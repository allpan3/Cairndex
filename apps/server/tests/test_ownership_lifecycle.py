"""Synthetic competing owners and deterministic drain/resume boundaries"""

import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from cairndex.core.errors import (
    LibraryDrainError,
    LibraryLeaseHeldError,
    LibraryOwnershipLostError,
    LibraryOwnershipUncertainError,
    LibraryReleasedError,
)
from cairndex.devtools.benchmark_queries import run
from cairndex.ownership import get_lease_manager
from cairndex.ownership import manager as manager_module
from cairndex.ownership.lease import LeaseSnapshot, read_lease, write_lease
from cairndex.ownership.lifecycle import lifecycle
from cairndex.ownership.manager import LeaseManager, LeaseSettings
from cairndex.registry import library_engine, services
from cairndex.registry import library_package as pkg


# Build distinct identities without real observation delays
def peer(now=None) -> LeaseManager:
    kwargs = {"clock": now} if now else {}
    return LeaseManager(
        server_uuid="synthetic-peer",
        machine_name="Peer",
        advertised_url=None,
        settings=LeaseSettings(60, 300, 0),
        **kwargs,
    )


# Snapshot bytes and nanosecond mtimes, including sidecars and local plan state
def files(root: Path) -> dict:
    return {
        str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
        for p in root.rglob("*")
        if p.is_file()
    }


def test_release_reopen_and_persisted_selection(
    isolated_client: TestClient, library_id: str, library_root: Path
) -> None:
    """Repeated background requests never reacquire an explicitly released library"""
    base = f"/api/v1/libraries/{library_id}"
    assert isolated_client.get(f"{base}/bundles/browse").status_code == 200
    assert isolated_client.post(f"{base}/ownership/release").json()["state"] == "locally_released"
    before = files(library_root)
    for _ in range(3):
        assert isolated_client.get(f"{base}/bundles/browse").status_code == 409
        assert not isolated_client.get(f"{base}/ownership").json()["mountable"]
    assert files(library_root) == before
    assert isolated_client.get(base).status_code == 200
    # A fresh admission gate models restart; persisted registry intent still wins
    lifecycle.reset()
    assert isolated_client.get(f"{base}/bundles/browse").status_code == 409
    assert not get_lease_manager().holds(library_id)
    assert isolated_client.post(f"{base}/ownership/reopen").status_code == 200
    assert isolated_client.get(f"{base}/bundles/browse").status_code == 200
    assert isolated_client.post(f"{base}/ownership/release").status_code == 200
    assert isolated_client.post(f"{base}/ownership/release").status_code == 200


def test_drain_pins_checked_out_session_until_final_write(
    registry_session: Session, library_id: str, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Peer acquisition fails at the checkpoint boundary, after the last commit"""
    library = services.get_library(registry_session, library_id)
    maker = library_engine.get_library_sessionmaker(library)
    session = maker()
    session.execute(text("SELECT 1"))
    entered = threading.Event()
    original = library_engine.checkpoint_and_revert
    rival = peer()

    def checkpoint(engine):
        entered.set()
        with pytest.raises(LibraryLeaseHeldError):
            rival.acquire(library_id=library_id, root=library_root)
        return original(engine)

    monkeypatch.setattr(library_engine, "checkpoint_and_revert", checkpoint)
    # Timeout leaves the engine and lease pinned, never pretends to finish
    with pytest.raises(LibraryDrainError):
        lifecycle.close(library_id, timeout=0)
    assert get_lease_manager().holds(library_id)
    assert not entered.is_set()
    with pytest.raises(LibraryReleasedError):
        maker()
    session.execute(text("CREATE TABLE synthetic_drain (value INTEGER)"))
    session.commit()
    session.close()
    lifecycle.close(library_id)
    assert entered.is_set()
    assert pkg.db_path(library_root).read_bytes()[18:20] == b"\x01\x01"
    rival.acquire(library_id=library_id, root=library_root)
    rival.release(library_id)


def test_checkpoint_failure_retains_lease_and_can_retry(
    registry_session: Session, library_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Failed close is not advertised as a clean release"""
    library_engine.get_library_sessionmaker(services.get_library(registry_session, library_id))
    original = library_engine.checkpoint_and_revert
    monkeypatch.setattr(library_engine, "checkpoint_and_revert", lambda _: False)
    with pytest.raises(LibraryDrainError):
        lifecycle.close(library_id)
    assert get_lease_manager().holds(library_id)
    monkeypatch.setattr(library_engine, "checkpoint_and_revert", original)
    lifecycle.close(library_id)
    assert not get_lease_manager().holds(library_id)


def test_long_gap_before_heartbeat_revalidates_changed_owner(tmp_path: Path) -> None:
    """A request resumes before the heartbeat, sees takeover and never fights"""
    current = [datetime(2026, 1, 1, tzinfo=UTC)]
    manager = peer(lambda: current[0])
    manager.acquire(library_id="lib", root=tmp_path)
    from dataclasses import replace

    old = read_lease(tmp_path).record
    assert old
    current[0] += timedelta(hours=2)
    changed = replace(old, server_uuid="synthetic-other", nonce="other")
    write_lease(tmp_path, changed)
    with pytest.raises(LibraryOwnershipLostError):
        manager.ensure_owned(library_id="lib", root=tmp_path)
    with pytest.raises(LibraryOwnershipLostError):
        manager.ensure_owned(library_id="lib", root=tmp_path)
    assert read_lease(tmp_path).record == changed


@pytest.mark.parametrize("gap", [3600, -3600])
def test_no_peer_resume_and_clock_adjustment(tmp_path: Path, gap: int) -> None:
    """Forward suspend gaps and backward clock changes both validate exact nonce"""
    current = [datetime(2026, 1, 1, tzinfo=UTC)]
    manager = peer(lambda: current[0])
    manager.acquire(library_id="lib", root=tmp_path)
    before = files(tmp_path)
    current[0] += timedelta(seconds=gap)
    manager.validate("lib")
    assert files(tmp_path) == before
    assert manager.holds("lib")


def test_network_uncertainty_blocks_until_successful_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Heartbeat read failure closes writes without claiming another owner exists"""
    manager = peer()
    manager.acquire(library_id="lib", root=tmp_path)
    original = manager_module.read_lease
    monkeypatch.setattr(manager_module, "read_lease", lambda _: LeaseSnapshot(io_error=True))
    manager.heartbeat_once()
    with pytest.raises(LibraryOwnershipUncertainError):
        manager.validate("lib")
    monkeypatch.setattr(manager_module, "read_lease", original)
    manager.validate("lib")
    manager.release("lib")


def test_lost_owner_blocks_checked_out_commit(
    registry_session: Session, library_id: str, library_root: Path
) -> None:
    """Disposing a pool is insufficient; an already checked-out session is fenced"""
    from dataclasses import replace

    maker = library_engine.get_library_sessionmaker(
        services.get_library(registry_session, library_id)
    )
    with maker() as session:
        session.execute(text("CREATE TABLE synthetic_lost (value INTEGER)"))
        session.commit()
        session.execute(text("INSERT INTO synthetic_lost VALUES (1)"))
        record = read_lease(library_root).record
        assert record
        changed = replace(record, server_uuid="new-peer", nonce="new-peer-nonce")
        write_lease(library_root, changed)
        get_lease_manager().heartbeat_once()
        with pytest.raises(LibraryOwnershipLostError):
            session.commit()
        session.rollback()
    # Explicit retry closes any deferred loss cleanup without a journal rewrite
    assert read_lease(library_root).record == changed


def test_benchmark_foreign_lease_exact_no_write(
    library_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refusal precedes every SQLite, sidecar and plan-file mutation"""
    from cairndex.core.config import get_settings

    state = tmp_path / "maintenance-state"
    monkeypatch.setenv("CAIRNDEX_DATA_DIR", str(state))
    get_settings.cache_clear()
    rival = peer()
    rival.acquire(library_id="lib", root=library_root)
    before = files(library_root)
    try:
        with pytest.raises(LibraryLeaseHeldError):
            run(library_root, iterations=1, explain=False)
        assert files(library_root) == before
        assert not state.exists()
    finally:
        rival.release("lib")
        get_settings.cache_clear()


def test_metadata_permissions_and_protected_source(
    isolated_client: TestClient, library_id: str, library_root: Path
) -> None:
    """Real POSIX permission denial is structured; protected sources can browse"""
    source = library_root / "synthetic.txt"
    source.write_text("synthetic source")
    source.chmod(0o444)
    metadata = library_root / ".cairndex"
    metadata.chmod(0o555)
    try:
        response = isolated_client.get(f"/api/v1/libraries/{library_id}/bundles/browse")
        assert response.status_code == 409
        assert response.json()["code"] == "library_metadata_unwritable"
    finally:
        metadata.chmod(0o755)
    assert isolated_client.get(f"/api/v1/libraries/{library_id}/bundles/browse").status_code == 200
    assert source.read_text() == "synthetic source"
    assert source.stat().st_mode & 0o222 == 0


def test_active_job_drains_before_release(
    registry_session_factory, library_id: str, library_root: Path
) -> None:
    """A real worker cancels at its checkpoint while the peer remains refused"""
    from concurrent.futures import ThreadPoolExecutor

    from cairndex.domain.enums import JobStatus, JobType
    from cairndex.jobs.worker import execute_job
    from cairndex.registry import jobs

    entered, finish = threading.Event(), threading.Event()
    with registry_session_factory() as reg:
        job = jobs.create_job(reg, library_id=library_id, job_type=JobType.SCAN, payload={})
        reg.commit()
        job_id = job.id

    def handler(ctx):
        entered.set()
        assert finish.wait(5)
        ctx.checkpoint(processed=1, total=1)
        return {}

    with ThreadPoolExecutor() as executor:
        result = executor.submit(
            execute_job, registry_session_factory, job_id, {JobType.SCAN: handler}
        )
        assert entered.wait(5)
        with pytest.raises(LibraryDrainError):
            lifecycle.close(library_id, timeout=0)
        with pytest.raises(LibraryLeaseHeldError):
            peer().acquire(library_id=library_id, root=library_root)
        finish.set()
        assert result.result(5) is JobStatus.CANCELLED
    lifecycle.close(library_id)
    assert read_lease(library_root).record.released_at is not None


def test_request_cancellation_releases_admission_without_releasing_server() -> None:
    """A client disconnect drains its ASGI scope, never the server's library"""
    import asyncio

    from cairndex.api.library_lifecycle import LibraryLifecycleMiddleware

    async def scenario():
        entered = asyncio.Event()

        async def endpoint(scope, receive, send):
            entered.set()
            await asyncio.Event().wait()

        async def channel(*args):
            return {}

        middleware = LibraryLifecycleMiddleware(endpoint)
        task = asyncio.create_task(
            middleware(
                {"type": "http", "path": "/api/v1/libraries/synthetic/bundles"}, channel, channel
            )
        )
        await entered.wait()
        with pytest.raises(LibraryDrainError):
            lifecycle.close("synthetic", timeout=0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        lifecycle.close("synthetic", timeout=0)
        lifecycle.reopen("synthetic")

    asyncio.run(scenario())


def test_continuous_awake_idle_retains_and_renews(tmp_path: Path) -> None:
    """Many idle heartbeat intervals never release or become stale"""
    current = [datetime(2026, 1, 1, tzinfo=UTC)]
    manager = peer(lambda: current[0])
    manager.acquire(library_id="lib", root=tmp_path)
    for _ in range(12):
        previous = read_lease(tmp_path).record
        current[0] += timedelta(seconds=60)
        assert manager.heartbeat_once() == []
        record = read_lease(tmp_path).record
        assert record and previous and record.nonce != previous.nonce
        assert record.released_at is None
        manager.validate("lib")


def test_maintenance_drains_before_handoff(
    registry_session: Session, library_id: str, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The actual idle-maintenance pass retains admission through snapshot publication"""
    library_engine.get_library_sessionmaker(services.get_library(registry_session, library_id))
    original = library_engine.snapshot_database

    def snapshot(source, destination):
        with pytest.raises(LibraryDrainError):
            lifecycle.close(library_id, timeout=0)
        with pytest.raises(LibraryLeaseHeldError):
            peer().acquire(library_id=library_id, root=library_root)
        return original(source, destination)

    monkeypatch.setattr(library_engine, "snapshot_database", snapshot)
    assert library_engine.maintain_library_engines(
        idle_after=0, snapshot_interval=1, library_ids={library_id}
    ) == (1, 1)
    lifecycle.close(library_id)


def test_maintenance_exception_and_cancellation_close_before_release(library_root: Path) -> None:
    """BaseException unwinds SQLite before marking the maintenance lease released"""
    from cairndex.ownership.maintenance import maintenance_engine

    with pytest.raises(KeyboardInterrupt), maintenance_engine(library_root) as engine:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1")).scalar()
        raise KeyboardInterrupt
    assert read_lease(library_root).record.released_at is not None
    assert pkg.db_path(library_root).read_bytes()[18:20] == b"\x01\x01"


def test_maintenance_open_failure_preserves_unclean_lease(
    library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An opener that may have partially written is never advertised as closed"""
    from cairndex.ownership import maintenance

    def fail(**kwargs):
        raise RuntimeError("synthetic open failure")

    monkeypatch.setattr(maintenance, "create_app_engine", fail)
    with (
        pytest.raises(RuntimeError, match="synthetic open failure"),
        maintenance.maintenance_engine(library_root),
    ):
        pytest.fail("must refuse before yielding")
    assert read_lease(library_root).record.released_at is None


def test_release_never_overwrites_unknown_same_server_nonce(tmp_path: Path) -> None:
    """A second process can share the installation identity but not the claim"""
    from dataclasses import replace

    manager = peer()
    manager.acquire(library_id="lib", root=tmp_path)
    record = read_lease(tmp_path).record
    assert record
    changed = replace(record, nonce="different-process")
    write_lease(tmp_path, changed)
    manager.release("lib")
    assert read_lease(tmp_path).record == changed


# The child owns only a disposable lease and reports its post-suspend gate result
def suspended_owner(root: str, channel) -> None:
    manager = LeaseManager(
        server_uuid="suspended",
        machine_name="Synthetic",
        advertised_url=None,
        settings=LeaseSettings(0.01, 1, 0),
    )
    manager.acquire(library_id="lib", root=Path(root))
    channel.send("ready")
    channel.recv()
    try:
        manager.ensure_owned(library_id="lib", root=Path(root))
    except LibraryOwnershipLostError:
        channel.send("fenced")
    else:
        channel.send("incorrectly admitted")
    channel.close()


def test_process_suspension_fences_before_heartbeat(tmp_path: Path) -> None:
    """SIGSTOP/SIGCONT targets one synthetic process, never the host power state"""
    import multiprocessing
    import os
    import signal
    import time
    from dataclasses import replace

    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=suspended_owner, args=(str(tmp_path), child))
    process.start()
    try:
        assert parent.poll(10) and parent.recv() == "ready"
        os.kill(process.pid, signal.SIGSTOP)
        record = read_lease(tmp_path).record
        assert record
        changed = replace(record, server_uuid="replacement", nonce="replacement")
        write_lease(tmp_path, changed)
        time.sleep(0.02)
        parent.send("resume")
        os.kill(process.pid, signal.SIGCONT)
        assert parent.poll(10) and parent.recv() == "fenced"
        process.join(5)
        assert process.exitcode == 0
        assert read_lease(tmp_path).record == changed
    finally:
        if process.is_alive():
            os.kill(process.pid, signal.SIGCONT)
            process.terminate()
            process.join(5)
        parent.close()
        child.close()


def test_unowned_disposal_does_not_implicitly_checkpoint(
    registry_session: Session, library_id: str, library_root: Path
) -> None:
    """SQLite's last-connection close must not become an unowned database write"""
    maker = library_engine.get_library_sessionmaker(
        services.get_library(registry_session, library_id)
    )
    with maker() as session:
        session.execute(text("CREATE TABLE synthetic_recovery (value INTEGER)"))
        session.execute(text("INSERT INTO synthetic_recovery VALUES (7)"))
        session.commit()
    database = pkg.db_path(library_root)
    wal = Path(str(database) + "-wal")
    before_db, before_wal = database.read_bytes(), wal.read_bytes()
    library_engine.dispose_library_engine(library_id, revert_journal_mode=False)
    assert database.read_bytes() == before_db
    assert wal.read_bytes() == before_wal


def test_database_io_failure_forces_next_statement_to_revalidate(
    registry_session: Session, library_id: str, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An actual SQLAlchemy error dispatch invalidates certainty before the timer"""
    import sqlite3
    from dataclasses import replace

    from sqlalchemy.exc import OperationalError

    maker = library_engine.get_library_sessionmaker(
        services.get_library(registry_session, library_id)
    )
    engine = maker.kw["bind"]
    original = engine.dialect.do_execute

    def fail(*args, **kwargs):
        error = sqlite3.OperationalError("synthetic disk I/O error")
        error.sqlite_errorcode = sqlite3.SQLITE_IOERR
        raise error

    with maker() as session:
        monkeypatch.setattr(engine.dialect, "do_execute", fail)
        with pytest.raises(OperationalError):
            session.execute(text("SELECT 1"))
        monkeypatch.setattr(engine.dialect, "do_execute", original)
        record = read_lease(library_root).record
        assert record
        write_lease(library_root, replace(record, server_uuid="replacement", nonce="replacement"))
        with pytest.raises(LibraryOwnershipLostError):
            session.execute(text("SELECT 1"))
        session.rollback()


def test_old_session_factory_cannot_reopen_retired_engine(
    registry_session: Session, library_id: str
) -> None:
    """A retained access handle cannot revive the engine from before a handoff"""
    library = services.get_library(registry_session, library_id)
    old = library_engine.get_library_sessionmaker(library)
    lifecycle.close(library_id)
    lifecycle.reopen(library_id)
    fresh = library_engine.get_library_sessionmaker(library)
    with pytest.raises(LibraryReleasedError):
        old()
    with fresh() as session:
        assert session.execute(text("SELECT 1")).scalar() == 1


# Cached content sessions must outlive a failed request's registry transaction
@pytest.mark.parametrize("open_before_rollback", [False, True])
def test_session_factory_survives_expired_registry_record(
    registry_session: Session, library_id: str, open_before_rollback: bool
) -> None:
    library = services.get_library(registry_session, library_id)
    maker = library_engine.get_library_sessionmaker(library)
    session = maker() if open_before_rollback else None
    registry_session.rollback()
    registry_session.expunge(library)
    if session is not None:
        session.close()
    with maker() as fresh:
        assert fresh.execute(text("SELECT 1")).scalar() == 1
    lifecycle.close(library_id, timeout=0)
    assert not get_lease_manager().holds(library_id)


def test_failed_release_status_does_not_claim_completed_handoff(
    isolated_client: TestClient, library_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The status endpoint distinguishes release intent from a finished close"""
    base = f"/api/v1/libraries/{library_id}"
    assert isolated_client.get(f"{base}/bundles/browse").status_code == 200
    original = library_engine.checkpoint_and_revert
    monkeypatch.setattr(library_engine, "checkpoint_and_revert", lambda _: False)
    assert isolated_client.post(f"{base}/ownership/release").status_code == 409
    assert isolated_client.get(f"{base}/ownership").json()["state"] == "release_pending"
    monkeypatch.setattr(library_engine, "checkpoint_and_revert", original)
    assert isolated_client.post(f"{base}/ownership/release").json()["state"] == "locally_released"


def test_uncertain_status_offers_no_takeover(
    isolated_client: TestClient, library_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Temporary storage uncertainty is neither a foreign holder nor a takeover invitation"""
    base = f"/api/v1/libraries/{library_id}"
    assert isolated_client.get(f"{base}/bundles/browse").status_code == 200
    manager = get_lease_manager()
    manager.mark_uncertain(library_id)
    original = manager_module.read_lease
    monkeypatch.setattr(manager_module, "read_lease", lambda _: LeaseSnapshot(io_error=True))
    result = isolated_client.get(f"{base}/ownership").json()
    assert result["state"] == "ownership_uncertain"
    assert not result["mountable"] and not result["can_take_over"]
    monkeypatch.setattr(manager_module, "read_lease", original)
    assert isolated_client.get(f"{base}/ownership").json()["state"] == "own"
