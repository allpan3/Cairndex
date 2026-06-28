from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings


def _apply_sqlite_pragmas(dbapi_connection: object, _connection_record: object) -> None:
    """Set connection-scoped SQLite pragmas (ADR-0002).

    These are per-connection in SQLite, so they must run on every new DBAPI
    connection rather than once at startup.
    """
    cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()


def create_app_engine(database_url: str | None = None) -> Engine:
    """Create an Engine with Cairndex's SQLite configuration applied.

    The data directory is created if needed so a fresh checkout/deploy can
    open the database without a manual mkdir.
    """
    settings = get_settings()
    url = database_url or settings.resolved_database_url()

    if url.startswith("sqlite:///") and ":memory:" not in url:
        settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)
    # Pragmas apply to file and in-memory SQLite alike (FK enforcement matters
    # for the in-memory test database too).
    if engine.dialect.name == "sqlite":
        event.listen(engine, "connect", _apply_sqlite_pragmas)
    return engine


@lru_cache
def get_engine() -> Engine:
    return create_app_engine()


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional session context: commit on success, roll back on error."""
    session = get_sessionmaker()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a transactional session."""
    with session_scope() as session:
        yield session


def library_root_for_session(session: Session) -> Path:
    """The library root directory for a content session (ADR-0008).

    A library DB lives at ``<root>/.cairndex/library.db``, so the root is the
    grandparent of the bound engine's database file. Used by content services
    to resolve library-relative ``AssetFile`` paths without threading the root
    through every call.
    """
    bind = session.get_bind()
    database = getattr(getattr(bind, "url", None), "database", None)
    if not database:
        raise RuntimeError("session is not bound to a file-backed library database")
    return Path(database).resolve().parent.parent
