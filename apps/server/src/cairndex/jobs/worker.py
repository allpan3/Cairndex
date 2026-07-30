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
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.errors import LibraryLeaseError
from cairndex.domain.enums import JobPhase, JobStatus, JobType, LibraryStatus
from cairndex.jobs.errors import safe_error_message
from cairndex.ownership import get_lease_manager
from cairndex.registry import jobs as job_service
from cairndex.registry import services as registry_service
from cairndex.registry.library_engine import get_library_sessionmaker

# Minimum seconds between registry progress writes on the hot checkpoint path.
# A huge scan checkpoints every batch; without throttling that is one registry
# commit per batch. Phase changes and progress completion bypass the throttle so
# the UI never misses a transition or stalls at "almost done".
_PROGRESS_MIN_INTERVAL = 0.5


class JobCancelled(Exception):
    """Raised inside a handler when cancellation has been requested."""


class JobOwnershipLost(JobCancelled):
    """Raised inside a handler when this server lost the library's lease.

    A subclass of ``JobCancelled`` so every handler's existing unwind path
    already does the right thing — roll back, stop, leave no partial write. It
    is a distinct type only so the terminal message can say what happened, since
    "cancelled" would suggest the user asked for it.

    This is the fast half of ADR-0018 §4's job re-verification. The slow half —
    the heartbeat flagging the library's jobs for cancellation — still runs, but
    it needs a registry round trip to be noticed; this check is an in-memory
    lookup, so a batch boundary reacts the moment the watchdog knows.
    """


class JobContext:
    """Handed to a job handler: the library's content session + root, its
    payload, and progress/cancel reporting (which targets the registry queue).

    Progress carries a coarse ``phase`` and an optional human ``message`` in
    addition to processed/total counts. Registry writes on the hot
    ``checkpoint`` path are throttled (``_PROGRESS_MIN_INTERVAL``) to avoid a
    DB commit per batch on large libraries; cancellation is still checked every
    call so a cancel is honoured promptly.
    """

    def __init__(
        self,
        *,
        session: Session,
        registry_session: Session,
        job_id: str,
        payload: dict[str, Any],
        library_root: Path,
        library_id: str = "",
        owns_library: Callable[[], bool] | None = None,
        progress_min_interval: float = _PROGRESS_MIN_INTERVAL,
    ) -> None:
        self.session = session
        self.registry_session = registry_session
        self.job_id = job_id
        self.payload = payload
        self.library_root = library_root
        self.library_id = library_id
        # Defaults to "yes" so a directly-constructed context (tests, one-off
        # handler runs) behaves exactly as before this check existed.
        self._owns_library = owns_library or (lambda: True)
        self.phase: JobPhase | None = None
        self.message: str | None = None
        self._progress_min_interval = progress_min_interval
        self._last_write = 0.0
        # The total last written, so a total *becoming known* can bypass the
        # throttle. It is a one-time event per phase, not the chatter the
        # throttle exists to suppress.
        self._last_total: int | None = None

    def set_phase(self, phase: JobPhase, message: str | None = None) -> None:
        """Move to a new phase, write it immediately, and honour cancellation.

        Phase transitions are infrequent, so they always flush to the registry
        (bypassing the progress throttle) and reset the per-phase count — both
        halves of it. ``clear_total`` is what makes the reset real: the previous
        phase's total has to go, or a phase that counts nothing inherits one it
        can never reach. A scan used to end at `0/79` for exactly that reason,
        the 79 belonging to a discovery pass that had finished.
        """
        self.phase = phase
        self.message = message
        self.session.commit()
        job_service.update_progress(
            self.registry_session,
            self.job_id,
            processed=0,
            clear_total=True,
            phase=phase.value,
            message=message,
        )
        self.registry_session.commit()
        self._last_write = time.monotonic()
        self._last_total = None
        self._raise_if_cancelled()

    def progress(self, processed: int, total: int | None = None) -> None:
        """Report progress without committing the content session.

        Separate from ``checkpoint`` because the two answer different questions.
        A checkpoint is a durability boundary: commit what has been done, in
        batches sized so a large library is not committing per row. Progress is
        a display concern, and tying it to that batch size meant a library
        smaller than one batch never reported anything at all — a 79-file scan
        with a batch size of 200 moved its bar exactly once, at the end.

        Writes are throttled the same way, so calling this per item is cheap:
        the cost of a no-op call is a clock read. Cancellation is only checked
        when a write actually happens, since that is a registry query and this
        runs in the hot loop.
        """
        now = time.monotonic()
        complete = total is not None and processed >= total
        # A newly known total is written straight away. Otherwise the first
        # report of a phase is swallowed by the throttle that set_phase just
        # reset, and the bar shows a label with no count until the first item
        # finishes — seconds, for work like storyboard generation.
        learned_total = total is not None and total != self._last_total
        if (
            not (complete or learned_total)
            and (now - self._last_write) < self._progress_min_interval
        ):
            return
        job_service.update_progress(
            self.registry_session,
            self.job_id,
            processed=processed,
            total=total,
            phase=self.phase.value if self.phase is not None else None,
            message=self.message,
        )
        self.registry_session.commit()
        self._last_write = now
        self._last_total = total
        self._raise_if_cancelled()

    def checkpoint(
        self, processed: int, total: int | None = None, *, message: str | None = None
    ) -> None:
        """Persist progress to the registry and abort if cancellation is requested.

        The content session is committed first so its durable work is visible,
        then the registry row is updated/committed so the API and the cancel
        flag observe a fresh snapshot. The registry write itself is throttled
        unless the work just completed (``processed >= total``) so the bar can
        reach 100%.
        """
        self.session.commit()
        if message is not None:
            self.message = message
        now = time.monotonic()
        complete = total is not None and processed >= total
        # See `progress`: a newly known total bypasses the throttle so the count
        # appears as soon as the work has been sized, rather than after the
        # first item finishes. This is the path storyboard and probe jobs use,
        # where one item can take seconds.
        learned_total = total is not None and total != self._last_total
        if complete or learned_total or (now - self._last_write) >= self._progress_min_interval:
            job_service.update_progress(
                self.registry_session,
                self.job_id,
                processed=processed,
                total=total,
                phase=self.phase.value if self.phase is not None else None,
                message=self.message,
            )
            self.registry_session.commit()
            self._last_write = now
            self._last_total = total
        self._raise_if_cancelled()

    def _raise_if_cancelled(self) -> None:
        # Ownership first: it is a local lookup, and if we no longer own the
        # library the very next thing this job would do is write to a library
        # another server owns (ADR-0018 §4).
        if not self._owns_library():
            raise JobOwnershipLost
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

        # Re-verify ownership before starting (ADR-0018 §4). A queued job can
        # outlive a restart or a takeover, and running it would write into a
        # library this server no longer owns. ``ensure_owned`` acquires a
        # released or own lease silently but never takes a foreign one — a
        # background job is not a place to make that decision on the user's
        # behalf.
        lease_manager = get_lease_manager()
        try:
            lease_manager.ensure_owned(library_id=library.id, root=library_root)
        except LibraryLeaseError as exc:
            job_service.mark_finished(reg, job_id, status=JobStatus.FAILED, error=exc.message)
            reg.commit()
            return JobStatus.FAILED

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
                library_id=library.id,
                owns_library=lambda: lease_manager.holds(library.id, library_root),
            )
            try:
                result = handler(ctx)
                content.commit()
                job_service.mark_finished(
                    reg, job_id, status=JobStatus.SUCCEEDED, result=result or {}
                )
                reg.commit()
                return JobStatus.SUCCEEDED
            except JobOwnershipLost:
                content.rollback()
                job_service.mark_finished(
                    reg,
                    job_id,
                    status=JobStatus.CANCELLED,
                    message="stopped: another server took over this library",
                )
                reg.commit()
                return JobStatus.CANCELLED
            except JobCancelled:
                content.rollback()
                job_service.mark_finished(reg, job_id, status=JobStatus.CANCELLED)
                reg.commit()
                return JobStatus.CANCELLED
            except Exception as exc:  # noqa: BLE001 — record any handler failure
                content.rollback()
                job_service.mark_finished(
                    reg,
                    job_id,
                    status=JobStatus.FAILED,
                    error=safe_error_message(exc, library_root=library_root),
                )
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
