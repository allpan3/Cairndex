"""Jobs framework: execution, progress, cancellation, failure, and the API."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType
from cairndex.jobs.worker import HandlerRegistry, JobContext, Worker, execute_job
from cairndex.services import jobs as job_service


def _new_job(session_factory: sessionmaker[Session], payload: dict[str, object]) -> str:
    with session_factory() as session:
        job = job_service.create_job(session, type=JobType.SCAN, payload=payload)
        session.commit()
        return job.id


def test_job_runs_to_success_with_progress(session_factory: sessionmaker[Session]) -> None:
    def handler(ctx: JobContext) -> dict[str, int]:
        for i in range(1, 4):
            ctx.checkpoint(processed=i, total=3)
        return {"done": 3}

    registry: HandlerRegistry = {JobType.SCAN: handler}
    job_id = _new_job(session_factory, {})

    status = execute_job(session_factory, job_id, registry)
    assert status == JobStatus.SUCCEEDED

    with session_factory() as session:
        job = job_service.get_job(session, job_id)
        assert job.status == JobStatus.SUCCEEDED
        assert job.processed == 3
        assert job.total == 3
        assert job.result == {"done": 3}
        assert job.started_at is not None and job.finished_at is not None


def test_job_failure_is_recorded(session_factory: sessionmaker[Session]) -> None:
    def handler(_ctx: JobContext) -> None:
        raise RuntimeError("boom")

    job_id = _new_job(session_factory, {})
    status = execute_job(session_factory, job_id, {JobType.SCAN: handler})
    assert status == JobStatus.FAILED

    with session_factory() as session:
        job = job_service.get_job(session, job_id)
        assert job.status == JobStatus.FAILED
        assert job.error is not None and "boom" in job.error


def test_missing_handler_fails_cleanly(session_factory: sessionmaker[Session]) -> None:
    job_id = _new_job(session_factory, {})
    status = execute_job(session_factory, job_id, {})  # empty registry
    assert status == JobStatus.FAILED
    with session_factory() as session:
        assert job_service.get_job(session, job_id).status == JobStatus.FAILED


def test_cooperative_cancellation(session_factory: sessionmaker[Session]) -> None:
    # Request cancellation up front; the handler aborts at its first checkpoint.
    job_id = _new_job(session_factory, {})
    with session_factory() as session:
        job_service.request_cancel(session, job_id)
        session.commit()

    reached = {"iterations": 0}

    def handler(ctx: JobContext) -> None:
        for i in range(1, 100):
            reached["iterations"] = i
            ctx.checkpoint(processed=i, total=99)  # raises JobCancelled

    status = execute_job(session_factory, job_id, {JobType.SCAN: handler})
    assert status == JobStatus.CANCELLED
    assert reached["iterations"] == 1  # stopped at the first checkpoint
    with session_factory() as session:
        assert job_service.get_job(session, job_id).status == JobStatus.CANCELLED


def test_worker_run_once_processes_queue(session_factory: sessionmaker[Session]) -> None:
    ran = {"count": 0}

    def handler(_ctx: JobContext) -> None:
        ran["count"] += 1

    worker = Worker(session_factory, {JobType.SCAN: handler})
    _new_job(session_factory, {})

    assert worker.run_once() is True  # one job claimed + run
    assert worker.run_once() is False  # queue empty
    assert ran["count"] == 1


def test_jobs_api_exposes_status_and_cancel(client: TestClient, session: Session) -> None:
    job = job_service.create_job(session, type=JobType.SCAN, payload={"k": "v"})
    session.commit()

    got = client.get(f"/api/v1/jobs/{job.id}")
    assert got.status_code == 200
    assert got.json()["type"] == "scan"
    assert got.json()["status"] == "queued"

    cancelled = client.post(f"/api/v1/jobs/{job.id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["cancel_requested"] is True

    listed = client.get("/api/v1/jobs")
    assert any(j["id"] == job.id for j in listed.json()["items"])
