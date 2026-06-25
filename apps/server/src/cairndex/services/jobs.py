"""Job persistence service: create, query, progress, and cancellation.

HTTP-agnostic. The worker (jobs/worker.py) drives status transitions; this
module is the data layer the worker and API share.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.core.time import utcnow
from cairndex.domain.enums import JobStatus, JobType
from cairndex.persistence.models import Job
from cairndex.services.pagination import keyset_page


def create_job(session: Session, *, type: JobType, payload: dict[str, Any] | None = None) -> Job:
    job = Job(type=type, payload=payload or {}, status=JobStatus.QUEUED)
    session.add(job)
    session.flush()
    return job


def get_job(session: Session, job_id: str) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id!r} not found")
    return job


def list_jobs(session: Session, *, limit: int, cursor: str | None) -> tuple[list[Job], str | None]:
    return keyset_page(session, select(Job), Job.id, limit, cursor)


def claim_next_queued(session: Session) -> Job | None:
    """Atomically move the oldest queued job to RUNNING and return it.

    Single-process worker, so a simple ordered select + status flip is enough;
    the flush makes the transition visible before the handler runs.
    """
    stmt = select(Job).where(Job.status == JobStatus.QUEUED).order_by(Job.id).limit(1)
    job = session.scalars(stmt).first()
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.started_at = utcnow()
    session.flush()
    return job


def mark_running(session: Session, job_id: str) -> None:
    """Ensure a job is RUNNING with a start time (idempotent)."""
    job = get_job(session, job_id)
    if job.status != JobStatus.RUNNING:
        job.status = JobStatus.RUNNING
    if job.started_at is None:
        job.started_at = utcnow()
    session.flush()


def update_progress(
    session: Session, job_id: str, *, processed: int, total: int | None = None
) -> None:
    job = get_job(session, job_id)
    job.processed = processed
    if total is not None:
        job.total = total
    session.flush()


def request_cancel(session: Session, job_id: str) -> Job:
    job = get_job(session, job_id)
    # Already-finished jobs are left untouched; a queued/running job is flagged.
    if job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
        job.cancel_requested = True
        session.flush()
    return job


def is_cancel_requested(session: Session, job_id: str) -> bool:
    job = session.get(Job, job_id)
    if job is None:
        return False
    session.refresh(job, ["cancel_requested"])
    return job.cancel_requested


def mark_finished(
    session: Session,
    job_id: str,
    *,
    status: JobStatus,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    job = get_job(session, job_id)
    job.status = status
    job.result = result
    job.error = error
    job.finished_at = utcnow()
    session.flush()
