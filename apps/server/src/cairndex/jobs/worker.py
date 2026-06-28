"""In-process background job worker (ADR-0001 + ADR-0008).

The registry owns the job queue; each job names a ``library_id``. To run a job
the worker opens that library's content DB (and resolves its filesystem root),
hands a handler a ``JobContext`` bound to that library, and writes progress and
the terminal state back to the registry job row. Durable results land in the
library's own DB; transient queue state stays in the registry.

A handler is a callable ``(JobContext) -> dict | None``. It reports progress and
polls for cancellation through ``JobContext``; raising ``JobCancelled`` unwinds
cleanly to a CANCELLED terminal state.
"""

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType, LibraryStatus
from cairndex.registry import jobs as job_service
from cairndex.registry import services as registry_service
from cairndex.registry.library_engine import get_library_sessionmaker


class JobCancelled(Exception):
    """Raised inside a handler when cancellation has been requested."""


class JobContext:
    """Handed to a job handler: the library's content session + root, its
    payload, and progress/cancel reporting (which targets the registry queue).
    """

    def __init__(
        self,
        *,
        session: Session,
        registry_session: Session,
        job_id: str,
        payload: dict[str, Any],
        library_root: Path,
    ) -> None:
        self.session = session
        self.registry_session = registry_session
        self.job_id = job_id
        self.payload = payload
        self.library_root = library_root

    def checkpoint(self, processed: int, total: int | None = None) -> None:
        """Persist progress to the registry and abort if cancellation is requested.

        The content session is committed first so its durable work is visible,
        then the registry row is updated/committed so the API and the cancel
        flag observe a fresh snapshot.
        """
        self.session.commit()
        job_service.update_progress(
            self.registry_session, self.job_id, processed=processed, total=total
        )
        self.registry_session.commit()
        if job_service.is_cancel_requested(self.registry_session, self.job_id):
            raise JobCancelled


Handler = Callable[[JobContext], dict[str, Any] | None]
HandlerRegistry = dict[JobType, Handler]


def execute_job(
    registry_factory: sessionmaker[Session], job_id: str, registry: HandlerRegistry
) -> JobStatus:
    """Run one job to a terminal state. Returns the status."""
    with registry_factory() as reg:
        job = job_service.get_job(reg, job_id)
        handler = registry.get(job.job_type)
        if handler is None:
            job_service.mark_finished(
                reg, job_id, status=JobStatus.FAILED, error=f"no handler for {job.job_type}"
            )
            reg.commit()
            return JobStatus.FAILED

        payload = dict(job.payload)
        try:
            library = registry_service.get_library(reg, job.library_id)
        except Exception as exc:  # noqa: BLE001 — library vanished/unavailable
            job_service.mark_finished(reg, job_id, status=JobStatus.FAILED, error=str(exc))
            reg.commit()
            return JobStatus.FAILED
        if library.status != LibraryStatus.AVAILABLE:
            job_service.mark_finished(
                reg,
                job_id,
                status=JobStatus.FAILED,
                error=f"library {library.id!r} is currently unavailable",
            )
            reg.commit()
            return JobStatus.FAILED
        library_root = Path(library.root_path)
        maker = get_library_sessionmaker(library)

        job_service.mark_running(reg, job_id)
        reg.commit()

        with maker() as content:
            ctx = JobContext(
                session=content,
                registry_session=reg,
                job_id=job_id,
                payload=payload,
                library_root=library_root,
            )
            try:
                result = handler(ctx)
                content.commit()
                job_service.mark_finished(
                    reg, job_id, status=JobStatus.SUCCEEDED, result=result or {}
                )
                reg.commit()
                return JobStatus.SUCCEEDED
            except JobCancelled:
                content.rollback()
                job_service.mark_finished(reg, job_id, status=JobStatus.CANCELLED)
                reg.commit()
                return JobStatus.CANCELLED
            except Exception as exc:  # noqa: BLE001 — record any handler failure
                content.rollback()
                job_service.mark_finished(reg, job_id, status=JobStatus.FAILED, error=str(exc))
                reg.commit()
                return JobStatus.FAILED


class Worker:
    """Polls the registry job queue and runs queued jobs on a background thread."""

    def __init__(
        self,
        registry_factory: sessionmaker[Session],
        registry: HandlerRegistry,
        *,
        poll_interval: float = 0.5,
    ) -> None:
        self._registry_factory = registry_factory
        self._registry = registry
        self._poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> bool:
        """Claim and run a single queued job. Returns True if one ran."""
        with self._registry_factory() as reg:
            job = job_service.claim_next_queued(reg)
            reg.commit()
            if job is None:
                return False
            job_id = job.id
        execute_job(self._registry_factory, job_id, self._registry)
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
