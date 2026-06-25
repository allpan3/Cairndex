"""In-process background job worker (ADR-0001: DB-backed queue, no Celery).

A handler is a callable ``(JobContext) -> dict | None``. It reports progress
and polls for cancellation through ``JobContext``; raising ``JobCancelled``
(which ``ctx.checkpoint`` does when a cancel is requested) unwinds cleanly to a
CANCELLED terminal state. Progress is committed at each checkpoint so the API
can observe a running job and so a cancel requested from another connection
becomes visible (SQLite WAL snapshots only refresh across transactions).
"""

import threading
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType
from cairndex.services import jobs as job_service


class JobCancelled(Exception):
    """Raised inside a handler when cancellation has been requested."""


class JobContext:
    """Handed to a job handler: its payload, progress, and cancel polling."""

    def __init__(self, session: Session, job_id: str, payload: dict[str, Any]) -> None:
        self.session = session
        self.job_id = job_id
        self.payload = payload

    def checkpoint(self, processed: int, total: int | None = None) -> None:
        """Persist progress and abort (raise ``JobCancelled``) if cancelled.

        Committing ends the read snapshot so the freshly-read cancel flag
        reflects requests made on other connections.
        """
        job_service.update_progress(self.session, self.job_id, processed=processed, total=total)
        self.session.commit()
        if job_service.is_cancel_requested(self.session, self.job_id):
            raise JobCancelled


Handler = Callable[[JobContext], dict[str, Any] | None]
HandlerRegistry = dict[JobType, Handler]


def execute_job(
    session_factory: sessionmaker[Session], job_id: str, registry: HandlerRegistry
) -> JobStatus:
    """Run one job to a terminal state in its own session. Returns the status."""
    with session_factory() as session:
        job = job_service.get_job(session, job_id)
        handler = registry.get(job.type)
        if handler is None:
            job_service.mark_finished(
                session, job_id, status=JobStatus.FAILED, error=f"no handler for {job.type}"
            )
            session.commit()
            return JobStatus.FAILED

        job_service.mark_running(session, job_id)
        session.commit()
        ctx = JobContext(session, job_id, dict(job.payload))
        try:
            result = handler(ctx)
            job_service.mark_finished(
                session, job_id, status=JobStatus.SUCCEEDED, result=result or {}
            )
            session.commit()
            return JobStatus.SUCCEEDED
        except JobCancelled:
            session.rollback()
            job_service.mark_finished(session, job_id, status=JobStatus.CANCELLED)
            session.commit()
            return JobStatus.CANCELLED
        except Exception as exc:  # noqa: BLE001 — record any handler failure
            session.rollback()
            job_service.mark_finished(session, job_id, status=JobStatus.FAILED, error=str(exc))
            session.commit()
            return JobStatus.FAILED


class Worker:
    """Polls the jobs table and runs queued jobs on a background thread."""

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        registry: HandlerRegistry,
        *,
        poll_interval: float = 0.5,
    ) -> None:
        self._session_factory = session_factory
        self._registry = registry
        self._poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> bool:
        """Claim and run a single queued job. Returns True if one ran."""
        with self._session_factory() as session:
            job = job_service.claim_next_queued(session)
            session.commit()
            if job is None:
                return False
            job_id = job.id
        execute_job(self._session_factory, job_id, self._registry)
        return True

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                ran = self.run_once()
            except Exception:  # noqa: BLE001 — never let the worker thread die
                ran = False
            if not ran:
                self._stop.wait(self._poll_interval)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="cairndex-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
