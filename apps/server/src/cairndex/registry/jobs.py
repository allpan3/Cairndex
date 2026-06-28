"""Registry job-queue service (ADR-0008, phase 7).

The registry owns the transient job queue: each row carries the ``library_id``
so the worker can open the right library DB to execute, while durable results
land in that library's own ``library.db``. HTTP-agnostic; the worker
(``jobs/worker.py``) drives status transitions and the API shares this layer.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.core.time import utcnow
from cairndex.domain.enums import JobStatus, JobType
from cairndex.registry.models import JobQueueEntry
from cairndex.services.pagination import keyset_page


def create_job(
    session: Session,
    *,
    library_id: str,
    job_type: JobType,
    payload: dict[str, Any] | None = None,
) -> JobQueueEntry:
    job = JobQueueEntry(
        library_id=library_id,
        job_type=job_type,
        payload=payload or {},
        status=JobStatus.QUEUED,
    )
    session.add(job)
    session.flush()
    return job


def get_job(session: Session, job_id: str) -> JobQueueEntry:
    job = session.get(JobQueueEntry, job_id)
    if job is None:
        raise NotFoundError(f"job {job_id!r} not found")
    return job


def list_jobs(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[JobQueueEntry], str | None]:
    return keyset_page(session, select(JobQueueEntry), JobQueueEntry.id, limit, cursor)


def claim_next_queued(session: Session) -> JobQueueEntry | None:
    """Atomically move the oldest queued job to RUNNING and return it."""
    stmt = (
        select(JobQueueEntry)
        .where(JobQueueEntry.status == JobStatus.QUEUED)
        .order_by(JobQueueEntry.id)
        .limit(1)
    )
    job = session.scalars(stmt).first()
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.started_at = utcnow()
    session.flush()
    return job


def mark_running(session: Session, job_id: str) -> None:
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


def request_cancel(session: Session, job_id: str) -> JobQueueEntry:
    job = get_job(session, job_id)
    if job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
        job.cancel_requested = True
        session.flush()
    return job


def is_cancel_requested(session: Session, job_id: str) -> bool:
    job = session.get(JobQueueEntry, job_id)
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
