"""Jobs framework: execution, progress, cancellation, failure, and the API.

Jobs live on the registry queue (ADR-0008); each job names a library, and the
worker opens that library's content DB to run a handler.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType
from cairndex.jobs.worker import HandlerRegistry, JobContext, Worker, execute_job
from cairndex.registry import jobs as job_service


def _new_job(
    registry_factory: sessionmaker[Session], library_id: str, payload: dict[str, object]
) -> str:
    with registry_factory() as reg:
        job = job_service.create_job(
            reg, library_id=library_id, job_type=JobType.SCAN, payload=payload
        )
        reg.commit()
        return job.id


def test_job_runs_to_success_with_progress(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    def handler(ctx: JobContext) -> dict[str, int]:
        for i in range(1, 4):
            ctx.checkpoint(processed=i, total=3)
        return {"done": 3}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = _new_job(registry_session_factory, library_id, {})

    status = execute_job(registry_session_factory, job_id, registry)
    assert status == JobStatus.SUCCEEDED

    with registry_session_factory() as reg:
        job = job_service.get_job(reg, job_id)
        assert job.status == JobStatus.SUCCEEDED
        assert job.processed == 3
        assert job.total == 3
        assert job.result == {"done": 3}
        assert job.started_at is not None and job.finished_at is not None


def test_job_failure_is_recorded(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    def handler(_ctx: JobContext) -> None:
        raise RuntimeError("boom")

    job_id = _new_job(registry_session_factory, library_id, {})
    status = execute_job(registry_session_factory, job_id, {JobType.SCAN: handler})
    assert status == JobStatus.FAILED

    with registry_session_factory() as reg:
        job = job_service.get_job(reg, job_id)
        assert job.status == JobStatus.FAILED
        assert job.error is not None and "boom" in job.error


def test_missing_handler_fails_cleanly(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    job_id = _new_job(registry_session_factory, library_id, {})
    status = execute_job(registry_session_factory, job_id, {})  # empty registry
    assert status == JobStatus.FAILED
    with registry_session_factory() as reg:
        assert job_service.get_job(reg, job_id).status == JobStatus.FAILED


def test_cooperative_cancellation(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    job_id = _new_job(registry_session_factory, library_id, {})
    with registry_session_factory() as reg:
        job_service.request_cancel(reg, job_id)
        reg.commit()

    reached = {"iterations": 0}

    def handler(ctx: JobContext) -> None:
        for i in range(1, 100):
            reached["iterations"] = i
            ctx.checkpoint(processed=i, total=99)  # raises JobCancelled

    status = execute_job(registry_session_factory, job_id, {JobType.SCAN: handler})
    assert status == JobStatus.CANCELLED
    assert reached["iterations"] == 1  # stopped at the first checkpoint
    with registry_session_factory() as reg:
        assert job_service.get_job(reg, job_id).status == JobStatus.CANCELLED


def test_worker_run_once_processes_queue(
    registry_session_factory: sessionmaker[Session], library_id: str
) -> None:
    ran = {"count": 0}

    def handler(_ctx: JobContext) -> None:
        ran["count"] += 1

    worker = Worker(registry_session_factory, {JobType.SCAN: handler})
    _new_job(registry_session_factory, library_id, {})

    assert worker.run_once() is True  # one job claimed + run
    assert worker.run_once() is False  # queue empty
    assert ran["count"] == 1


def test_jobs_api_exposes_status_and_cancel(
    client: TestClient, registry_session: Session, library_id: str
) -> None:
    job = job_service.create_job(
        registry_session, library_id=library_id, job_type=JobType.SCAN, payload={"k": "v"}
    )
    registry_session.commit()

    got = client.get(f"/api/v1/jobs/{job.id}")
    assert got.status_code == 200
    assert got.json()["job_type"] == "scan"
    assert got.json()["status"] == "queued"

    cancelled = client.post(f"/api/v1/jobs/{job.id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["cancel_requested"] is True

    listed = client.get("/api/v1/jobs")
    assert any(j["id"] == job.id for j in listed.json()["items"])
