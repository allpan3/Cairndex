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


# Reuse a queued job instead of queueing duplicate pending work
def get_or_create_queued_job(
    session: Session,
    *,
    library_id: str,
    job_type: JobType,
    payload: dict[str, Any] | None = None,
) -> JobQueueEntry:
    normalized_payload = payload or {}
    stmt = select(JobQueueEntry).where(
        JobQueueEntry.library_id == library_id,
        JobQueueEntry.job_type == job_type,
        JobQueueEntry.status == JobStatus.QUEUED,
    )
    for job in session.scalars(stmt):
        if dict(job.payload or {}) == normalized_payload:
            return job
    # Select-then-insert can race; acceptable single-owner, unique guard is future work
    return create_job(
        session,
        library_id=library_id,
        job_type=job_type,
        payload=normalized_payload,
    )


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
    session: Session,
    job_id: str,
    *,
    processed: int | None = None,
    total: int | None = None,
    phase: str | None = None,
    message: str | None = None,
    clear_total: bool = False,
) -> None:
    """Patch a job's progress. ``None`` means "leave alone", not "set to null".

    That is what makes ``clear_total`` necessary rather than redundant: a phase
    change has to *remove* a total belonging to the phase that just ended, and
    passing ``total=None`` cannot say so. Without it, a scan that discovered 79
    files left `0/79` on screen through grouping and finalizing — a count that
    could never advance, because those phases report no total of their own.
    """
    job = get_job(session, job_id)
    if processed is not None:
        job.processed = processed
    if clear_total:
        job.total = None
    elif total is not None:
        job.total = total
    if phase is not None:
        job.phase = phase
    if message is not None:
        job.message = message
    session.flush()


def request_cancel(session: Session, job_id: str) -> JobQueueEntry:
    job = get_job(session, job_id)
    if job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
        job.cancel_requested = True
        session.flush()
    return job


def request_cancel_for_library(session: Session, library_id: str) -> int:
    """Cancel every unfinished job for one library. Returns how many were flagged.

    Used when a library is unmounted because its ownership lease was lost
    (ADR-0018 §4): a scan or probe must not keep writing to a library another
    server now owns. Cancellation is cooperative — the running handler notices
    at its next checkpoint — which is why the job worker also re-verifies the
    lease at batch boundaries.
    """
    stmt = select(JobQueueEntry).where(
        JobQueueEntry.library_id == library_id,
        JobQueueEntry.status.in_((JobStatus.QUEUED, JobStatus.RUNNING)),
    )
    flagged = 0
    for job in session.scalars(stmt):
        job.cancel_requested = True
        flagged += 1
    if flagged:
        session.flush()
    return flagged


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
    message: str | None = None,
) -> None:
    job = get_job(session, job_id)
    job.status = status
    job.result = result
    job.error = error
    # A terminal job is no longer in any working phase; keep an optional final
    # human-readable summary line in ``message`` instead.
    job.phase = None
    job.message = message
    job.finished_at = utcnow()
    session.flush()
