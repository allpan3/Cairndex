"""Background SQLite maintenance pass (ADR-0018 §6).

Runs the idle WAL checkpoint and the periodic snapshot on a timer. Kept separate
from the lease heartbeat even though both are per-library periodic work: the
heartbeat is a correctness mechanism whose timing another machine depends on,
and a slow checkpoint on a sluggish NAS mount must not be able to delay it into
looking stale.

The set of libraries to maintain is supplied by a callable rather than imported,
so persistence stays unaware of the ownership layer. In practice it is "the
libraries whose lease we hold" — maintaining one we do not own would mean
writing into another server's library.

It also sweeps grouping-plan databases nothing claims any more (ADR-0022). Those
sit in the server's own data directory rather than in a library, so no amount of
tidying a library reaches them; here is where a periodic pass already exists. The
set of *registered* libraries comes in the same way and for the same reason —
note registered, not owned: a library this server is not currently serving still
has every right to the review someone left open on it.
"""

import logging
import threading
from collections.abc import Callable
from pathlib import Path

from cairndex.persistence.engine import sweep_orphaned_plans
from cairndex.registry.library_engine import maintain_library_engines

logger = logging.getLogger(__name__)


class SqliteMaintenance:
    """A timer thread that keeps idle library databases tidy on disk."""

    def __init__(
        self,
        *,
        owned_library_ids: Callable[[], set[str]],
        interval: float,
        idle_after: float,
        snapshot_interval: float,
        registered_db_paths: Callable[[], set[Path]] | None = None,
    ) -> None:
        self._owned_library_ids = owned_library_ids
        self._registered_db_paths = registered_db_paths
        self._interval = interval
        self._idle_after = idle_after
        self._snapshot_interval = snapshot_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> tuple[int, int]:
        if self._registered_db_paths is not None:
            try:
                sweep_orphaned_plans(self._registered_db_paths())
            except Exception:  # noqa: BLE001 — tidying must not stop the checkpoint
                logger.warning("could not sweep orphaned grouping plans", exc_info=True)
        return maintain_library_engines(
            idle_after=self._idle_after,
            snapshot_interval=self._snapshot_interval,
            library_ids=self._owned_library_ids(),
        )

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="cairndex-sqlite-maintenance", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.run_once()
            except Exception:  # noqa: BLE001 — never let the maintenance thread die
                logger.exception("sqlite maintenance pass failed")
