"""Per-library content engine/session cache (ADR-0008, phase 3).

Replaces the single global ``persistence.engine.get_engine()`` assumption with
one engine per open library DB. Engines are cached by ``library_id`` and keyed
on the resolved DB path, so a library that moves (new ``root_path``) transparently
re-opens against the new file. The content schema already lives inside each
``library.db`` (created by ``library_package.create_package``), so this module
only opens connections — it never creates content tables.
"""

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from cairndex.persistence.checkpoint import checkpoint_wal, snapshot_database, snapshot_path_for
from cairndex.persistence.engine import create_app_engine, ensure_content_indexes
from cairndex.registry import library_package as pkg
from cairndex.registry.models import RegisteredLibrary
from cairndex.search import ensure_search_schema

logger = logging.getLogger(__name__)


@dataclass
class _Cached:
    db_path: str
    engine: Engine
    sessionmaker: sessionmaker[Session]
    # Monotonic timestamp of the last time this library's engine was handed out.
    # Drives the idle WAL checkpoint (ADR-0018 §6); it is a coarse activity
    # signal, which is all an "is anyone using this?" question needs.
    last_used: float = 0.0
    # Whether the WAL has been checkpointed since that last use, so an idle
    # library is checkpointed once rather than on every maintenance pass.
    checkpointed_since_use: bool = False
    # Monotonic timestamp of the last consistent snapshot, or 0.0 for never.
    last_snapshot: float = 0.0


_cache: dict[str, _Cached] = {}
_lock = threading.Lock()


def _db_path_for(library: RegisteredLibrary) -> str:
    return pkg.db_path(Path(library.root_path)).as_posix()


def get_library_sessionmaker(library: RegisteredLibrary) -> sessionmaker[Session]:
    """Return a cached sessionmaker bound to ``library``'s ``library.db``.

    Thread-safe. If the cached entry points at a stale DB path (the library was
    moved/re-registered), the old engine is disposed and a fresh one opened.
    """
    db_path = _db_path_for(library)
    with _lock:
        cached = _cache.get(library.id)
        if cached is not None and cached.db_path == db_path:
            cached.last_used = time.monotonic()
            cached.checkpointed_since_use = False
            return cached.sessionmaker
        if cached is not None:
            cached.engine.dispose()
        engine = create_app_engine(database_url=f"sqlite:///{db_path}")
        # Backfill any content indexes added after this library DB was created
        # (create_all won't add them to an existing table). Once per open.
        ensure_content_indexes(engine)
        # Create/populate the FTS5 search index + maintenance triggers if missing.
        ensure_search_schema(engine)
        maker = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        _reconcile_file_operations(maker, Path(library.root_path))
        _cache[library.id] = _Cached(
            db_path=db_path,
            engine=engine,
            sessionmaker=maker,
            last_used=time.monotonic(),
        )
        return maker


def _reconcile_file_operations(maker: sessionmaker[Session], root: Path) -> None:
    """Settle write operations interrupted by a crash (ADR-0013 §3.1).

    On open, because that is the first moment after a crash when someone is
    looking at the library again — and it costs one indexed query against a
    table that is empty on every library that has never been written to.

    Deliberately swallows everything: a library that cannot be reconciled must
    still open. The alternative turns a recoverable disagreement between disk
    and database into a library the user cannot reach at all, and the scanner's
    moved-file repair remains available for exactly this state.
    """
    from cairndex.file_ops.reconcile import reconcile_pending

    try:
        with maker() as session:
            reconcile_pending(session, root)
    except Exception:
        logger.exception("file-operation reconciliation failed for %s", root)


def dispose_library_engine(library_id: str) -> None:
    """Drop and dispose the cached engine for a library, if any.

    Disposing closes the last connection, which is what lets SQLite fold the WAL
    back in and delete the ``-wal``/``-shm`` pair — so a cleanly closed library
    is a single consistent file for a sync engine to pick up (ADR-0018 §6).
    """
    with _lock:
        cached = _cache.pop(library_id, None)
    if cached is not None:
        cached.engine.dispose()


def maintain_library_engines(
    *, idle_after: float, snapshot_interval: float, library_ids: set[str] | None = None
) -> tuple[int, int]:
    """One maintenance pass: checkpoint idle libraries, refresh due snapshots.

    Returns ``(checkpointed, snapshotted)``. ``library_ids`` restricts the pass
    to libraries this server currently owns — checkpointing or snapshotting one
    whose lease we lost would be writing into another server's library.

    Deliberately skips a library that is in active use: a checkpoint competes
    with live readers and would usually be refused anyway, and the whole point
    is to tidy the at-rest state, which by definition is the idle one.
    """
    now = time.monotonic()
    with _lock:
        candidates = [
            (library_id, cached)
            for library_id, cached in _cache.items()
            if library_ids is None or library_id in library_ids
        ]

    checkpointed = 0
    snapshotted = 0
    for library_id, cached in candidates:
        idle_for = now - cached.last_used
        if idle_for < idle_after:
            continue

        if not cached.checkpointed_since_use and checkpoint_wal(cached.engine):
            cached.checkpointed_since_use = True
            checkpointed += 1

        snapshot_due = snapshot_interval > 0 and (
            cached.last_snapshot == 0.0 or (now - cached.last_snapshot) >= snapshot_interval
        )
        if snapshot_due:
            source = Path(cached.db_path)
            # Snapshot after the checkpoint so the copy reflects the folded-in
            # WAL rather than trailing it.
            if snapshot_database(source, snapshot_path_for(source)):
                cached.last_snapshot = now
                snapshotted += 1
            else:
                # Do not retry every pass on a persistently failing library
                # (read-only volume, no space); wait out the normal interval.
                cached.last_snapshot = now
        logger.debug("maintenance pass for library %s (idle %.0fs)", library_id, idle_for)

    return checkpointed, snapshotted


def close_library_engines() -> None:
    """Checkpoint and dispose every open library engine (clean shutdown).

    The ADR-0018 §6 "clean close" path. Dispose alone already causes SQLite to
    remove the WAL on last-connection close, but checkpointing first means the
    fold-in happens while we are still deliberately in control rather than as a
    side effect of teardown — and it keeps the behaviour explicit rather than
    resting on interpreter shutdown happening to close connections in time.
    """
    with _lock:
        cached = list(_cache.values())
        _cache.clear()
    for entry in cached:
        checkpoint_wal(entry.engine)
        entry.engine.dispose()


def refresh_library_engine(library_id: str) -> None:
    """Force the next access to re-open the library DB (e.g. after a move)."""
    dispose_library_engine(library_id)


def dispose_all_library_engines() -> None:
    """Dispose every cached engine (test teardown / shutdown)."""
    with _lock:
        cached = list(_cache.values())
        _cache.clear()
    for entry in cached:
        entry.engine.dispose()
