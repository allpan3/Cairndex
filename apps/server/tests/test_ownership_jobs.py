"""Jobs stop when this server loses a library's ownership lease (ADR-0018 §4).

A scan or probe is the longest-lived writer in the system, so it is the one most
likely to still be running when another machine takes the library over. It must
notice at a batch boundary rather than run to completion against a library it no
longer owns.
"""

from datetime import timedelta
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.time import utcnow
from cairndex.domain.enums import JobStatus, JobType
from cairndex.jobs.worker import HandlerRegistry, JobContext, execute_job
from cairndex.ownership import get_lease_manager
from cairndex.ownership.lease import LeaseRecord, new_nonce, read_lease, write_lease
from cairndex.registry import jobs as job_service
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service

FOREIGN_UUID = "01OTHERSERVERAAAAAAAAAAAAA"


def new_scan_job(registry_factory: sessionmaker[Session], library_id: str) -> str:
    with registry_factory() as reg:
        job = job_service.create_job(reg, library_id=library_id, job_type=JobType.SCAN, payload={})
        reg.commit()
        return str(job.id)


def plant_foreign_lease(root: Path, *, age: timedelta = timedelta(seconds=0)) -> None:
    when = utcnow() - age
    write_lease(
        root,
        LeaseRecord(
            server_uuid=FOREIGN_UUID,
            machine_name="NAS",
            advertised_url=None,
            acquired_at=when,
            heartbeat_at=when,
            nonce=new_nonce(),
        ),
    )


def test_a_job_acquires_the_lease_before_running(
    registry_session_factory: sessionmaker[Session], library_id: str, library_root: Path
) -> None:
    ran: list[bool] = []

    def handler(_ctx: JobContext) -> dict[str, int]:
        ran.append(True)
        return {}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = new_scan_job(registry_session_factory, library_id)

    assert execute_job(registry_session_factory, job_id, registry) == JobStatus.SUCCEEDED
    assert ran == [True]
    snapshot = read_lease(library_root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == get_lease_manager().server_uuid


def test_a_queued_job_for_a_library_another_server_holds_fails_without_running(
    registry_session_factory: sessionmaker[Session], library_id: str, library_root: Path
) -> None:
    """A job can outlive a restart or a takeover; it must not write regardless."""
    plant_foreign_lease(library_root)
    ran: list[bool] = []

    def handler(_ctx: JobContext) -> dict[str, int]:
        ran.append(True)
        return {}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = new_scan_job(registry_session_factory, library_id)

    assert execute_job(registry_session_factory, job_id, registry) == JobStatus.FAILED
    assert ran == []
    with registry_session_factory() as reg:
        assert "served by NAS" in (job_service.get_job(reg, job_id).error or "")


def test_a_job_never_takes_over_a_stale_lease_on_its_own(
    registry_session_factory: sessionmaker[Session], library_id: str, library_root: Path
) -> None:
    """Takeover is a user decision (ADR-0018 §3); a worker must not make it."""
    plant_foreign_lease(library_root, age=timedelta(days=30))

    registry: HandlerRegistry = {JobType.SCAN: lambda _ctx: {}}
    job_id = new_scan_job(registry_session_factory, library_id)

    assert execute_job(registry_session_factory, job_id, registry) == JobStatus.FAILED
    snapshot = read_lease(library_root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == FOREIGN_UUID


def test_a_running_job_stops_at_the_next_batch_when_ownership_is_lost(
    registry_session_factory: sessionmaker[Session], library_id: str, library_root: Path
) -> None:
    batches: list[int] = []

    def handler(ctx: JobContext) -> dict[str, int]:
        for i in range(1, 11):
            if i == 3:
                # Another machine completes a confirmed takeover mid-scan; our
                # watchdog notices on its next pass.
                plant_foreign_lease(library_root)
                get_lease_manager().heartbeat_once()
            ctx.checkpoint(processed=i, total=10)
            batches.append(i)
        return {"done": 10}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = new_scan_job(registry_session_factory, library_id)

    assert execute_job(registry_session_factory, job_id, registry) == JobStatus.CANCELLED
    # It stopped at the boundary, rather than running all ten batches.
    assert batches == [1, 2]


def test_a_job_stopped_by_a_takeover_says_so_rather_than_looking_user_cancelled(
    registry_session_factory: sessionmaker[Session], library_id: str, library_root: Path
) -> None:
    def handler(ctx: JobContext) -> dict[str, int]:
        plant_foreign_lease(library_root)
        get_lease_manager().heartbeat_once()
        ctx.checkpoint(processed=1, total=2)
        return {}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = new_scan_job(registry_session_factory, library_id)

    execute_job(registry_session_factory, job_id, registry)

    with registry_session_factory() as reg:
        job = job_service.get_job(reg, job_id)
        assert job.status == JobStatus.CANCELLED
        assert job.message is not None
        assert "took over" in job.message


def test_losing_ownership_flags_the_librarys_other_jobs_for_cancellation(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    """The heartbeat's own response to a lost lease, independent of any handler."""
    with registry_session_factory() as reg:
        queued = job_service.create_job(
            reg, library_id=library_id, job_type=JobType.SCAN, payload={}
        )
        reg.commit()
        queued_id = queued.id

    with registry_session_factory() as reg:
        assert job_service.request_cancel_for_library(reg, library_id) == 1
        reg.commit()

    with registry_session_factory() as reg:
        assert job_service.get_job(reg, queued_id).cancel_requested is True


def test_cancelling_a_librarys_jobs_leaves_other_libraries_alone(
    registry_session_factory: sessionmaker[Session], library_id: str, tmp_path: Path
) -> None:
    second_root = tmp_path / "second-library"
    second_root.mkdir()
    pkg.create_package(second_root, "Second")
    with registry_session_factory() as reg:
        second = registry_service.register_existing_library(reg, root_path=str(second_root))
        other = job_service.create_job(reg, library_id=second.id, job_type=JobType.SCAN, payload={})
        reg.commit()
        other_id = other.id

    with registry_session_factory() as reg:
        assert job_service.request_cancel_for_library(reg, library_id) == 0
        reg.commit()

    with registry_session_factory() as reg:
        assert job_service.get_job(reg, other_id).cancel_requested is False
