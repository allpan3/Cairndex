"""Per-library content engine/session cache (ADR-0008, phase 3).

Replaces the single global ``persistence.engine.get_engine()`` assumption with
one engine per open library DB. Engines are cached by ``library_id`` and keyed
on the resolved DB path, so a library that moves (new ``root_path``) transparently
re-opens against the new file. The content schema already lives inside each
``library.db`` (created by ``library_package.create_package``), so this module
only opens connections — it never creates content tables.
"""

import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from cairndex.persistence.engine import create_app_engine, ensure_content_indexes
from cairndex.registry import library_package as pkg
from cairndex.registry.models import RegisteredLibrary
from cairndex.search import ensure_search_schema


@dataclass
class _Cached:
    db_path: str
    engine: Engine
    sessionmaker: sessionmaker[Session]


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
        _cache[library.id] = _Cached(db_path=db_path, engine=engine, sessionmaker=maker)
        return maker


def dispose_library_engine(library_id: str) -> None:
    """Drop and dispose the cached engine for a library, if any."""
    with _lock:
        cached = _cache.pop(library_id, None)
    if cached is not None:
        cached.engine.dispose()


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
