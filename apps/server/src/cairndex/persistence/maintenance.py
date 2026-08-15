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

"""

import logging
import threading
from collections.abc import Callable

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
    ) -> None:
        self._owned_library_ids = owned_library_ids
        self._interval = interval
        self._idle_after = idle_after
        self._snapshot_interval = snapshot_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> tuple[int, int]:
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
