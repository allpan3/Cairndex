"""Admission and draining shared by requests, jobs and library maintenance"""

import threading
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from contextvars import ContextVar

from cairndex.core.errors import (
    LibraryDrainError,
    LibraryLeaseError,
    LibraryOwnershipLostError,
    LibraryReleasedError,
)

_active_scope: ContextVar[frozenset[str]] = ContextVar("library_work", default=frozenset())


class LibraryLifecycle:
    """Keep ownership until every admitted operation has left its scope"""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._active: dict[str, int] = {}
        self._closed: set[str] = set()
        self._closing: set[str] = set()
        self._lost: set[str] = set()

    @contextmanager
    def work(self, library_id: str) -> Iterator[None]:
        """Count full operations, allowing their nested sessions during draining"""
        if library_id in _active_scope.get():
            yield
            return
        with self._condition:
            if library_id in self._lost:
                raise LibraryOwnershipLostError(
                    "Ownership changed; this server stopped serving the library"
                )
            if library_id in self._closed:
                raise LibraryReleasedError(
                    "This library is released on this server; choose Reopen to serve it here"
                )
            self._active[library_id] = self._active.get(library_id, 0) + 1
        token = _active_scope.set(_active_scope.get() | {library_id})
        try:
            yield
        finally:
            _active_scope.reset(token)
            with self._condition:
                self._active[library_id] -= 1
                self._condition.notify_all()

    def retain(self, library_id: str) -> None:
        """Pin a session across FastAPI's potentially different worker threads"""
        with self._condition:
            if library_id in self._closed and library_id not in _active_scope.get():
                raise LibraryReleasedError("This library is released; choose Reopen")
            self._active[library_id] = self._active.get(library_id, 0) + 1

    def leave(self, library_id: str) -> None:
        """Unpin a session only after its connection has closed"""
        with self._condition:
            if library_id not in self._active:
                return  # Test reset may outlive a disposable export thread
            self._active[library_id] -= 1
            self._condition.notify_all()

    def blocked(self, library_id: str) -> bool:
        """Report explicit release or loss without opening storage"""
        with self._condition:
            return library_id in self._closed

    def reopen(self, library_id: str) -> None:
        """Allow deliberate admission after a completed close"""
        with self._condition:
            if library_id in self._closing or self._active.get(library_id, 0):
                raise LibraryDrainError("Library work is still draining; retry Reopen shortly")
            self._closed.discard(library_id)
            self._lost.discard(library_id)

    def close(self, library_id: str, *, timeout: float = 30.0, lost: bool = False) -> None:
        """Drain, close SQLite under ownership, then release; failures stay closed"""
        from cairndex.ownership import get_lease_manager
        from cairndex.registry.library_engine import dispose_library_engine

        with self._condition:
            self._closed.add(library_id)
            if library_id in self._closing:
                raise LibraryDrainError("Library release is already in progress")
            self._closing.add(library_id)
        try:
            with self._condition:
                if not self._condition.wait_for(
                    lambda: not self._active.get(library_id, 0), timeout
                ):
                    raise LibraryDrainError(
                        "Library work is still draining; ownership is retained. "
                        "Retry Release shortly"
                    )
            from cairndex.media.hls import close_library_sessions
            from cairndex.replicas.service import close as close_replica

            close_replica(library_id)
            close_library_sessions(library_id)
            manager = get_lease_manager()
            owned = manager.holds(library_id) and not lost
            if owned:
                try:
                    manager.validate(library_id, force=True)
                except LibraryLeaseError:
                    owned = False
            # Unknown ownership is never a reason to rewrite a journal or lease
            dispose_library_engine(library_id, revert_journal_mode=owned)
            if owned:
                manager.release(library_id)
            else:
                manager.forget(library_id)
        finally:
            with self._condition:
                self._closing.discard(library_id)
                self._condition.notify_all()

    def lost(self, library_id: str) -> None:
        """Fence immediately and dispose once active work exits, without rewriting"""
        with self._condition:
            self._closed.add(library_id)
            self._lost.add(library_id)

        # SQL guards reject subsequent statements; cleanup cannot wait inside a
        # heartbeat lock or an executing statement that is itself counted
        def drain() -> None:
            with suppress(LibraryLeaseError):
                self.close(library_id, lost=True)

        threading.Thread(target=drain, name="library-loss-drain", daemon=True).start()

    def reset(self) -> None:
        """Clear admission state for isolated test teardown"""
        with self._condition:
            self._closed.clear()
            self._lost.clear()
            self._active.clear()
            self._closing.clear()


lifecycle = LibraryLifecycle()


def check_work_ownership() -> None:
    """Fence filesystem publication and long-operation boundaries in active work"""
    from cairndex.ownership import get_lease_manager

    manager = get_lease_manager()
    for library_id in _active_scope.get():
        if manager.holds(library_id) or library_id in manager._lost:
            manager.validate(library_id)
