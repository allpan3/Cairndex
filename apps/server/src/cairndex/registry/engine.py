"""Registry database engine/session management (ADR-0008).

The registry lives at ``{CAIRNDEX_DATA_DIR}/registry.db`` and is created on
first use via ``create_all`` against the registry metadata. It is intentionally
independent of the content database and of any per-library database: it is
server-local runtime state, so it does not use the content DB's Alembic
migration chain. (If the registry schema later needs versioned migrations it can
get its own chain; for now ``create_all`` bootstraps it.)
"""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
from cairndex.persistence.engine import _apply_registry_pragmas
from cairndex.registry import models  # noqa: F401  (populate registry metadata)
from cairndex.registry.base import RegistryBase

# Additive columns the registry may gain over time. ``create_all`` only creates
# missing *tables*, never alters an existing one, and the registry deliberately
# has no migration chain (it is regenerable runtime state) — but dropping it
# would lose registered libraries. So we additively add any missing columns to
# long-lived tables. Each entry is (table, column, SQLite type + default): a
# NOT NULL column needs a constant DEFAULT, which is what makes SQLite's
# single-pass ADD COLUMN legal on a table that already has rows.
_ADDITIVE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("job_queue", "phase", "VARCHAR(32)"),
    ("job_queue", "message", "TEXT"),
    # ADR-0013: an existing registry row predates write mode and must come back
    # read-only, which is exactly what defaulting to 0 gives.
    ("registered_libraries", "write_mode_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
)


def _apply_additive_columns(engine: Engine) -> None:
    """Add any missing nullable columns to existing registry tables (idempotent)."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, column, sql_type in _ADDITIVE_COLUMNS:
            if table not in tables:
                continue  # create_all already made it with the column
            existing = {col["name"] for col in inspector.get_columns(table)}
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def create_registry_engine(database_url: str | None = None) -> Engine:
    """Create an Engine for the registry DB and ensure its schema exists."""
    settings = get_settings()
    url = database_url or settings.resolved_registry_url()

    if url.startswith("sqlite:///") and ":memory:" not in url:
        settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)
    # WAL unconditionally, unlike a library DB (ADR-0021): the registry lives on
    # the server's own disk, is never reached over a share, and never travels.
    if engine.dialect.name == "sqlite":
        event.listen(engine, "connect", _apply_registry_pragmas)
    RegistryBase.metadata.create_all(engine)
    _apply_additive_columns(engine)
    return engine


@lru_cache
def get_registry_engine() -> Engine:
    return create_registry_engine()


@lru_cache
def get_registry_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_registry_engine(), expire_on_commit=False, future=True)


@contextmanager
def registry_session_scope() -> Iterator[Session]:
    """Transactional registry session: commit on success, roll back on error."""
    session = get_registry_sessionmaker()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_registry_session() -> Iterator[Session]:
    """FastAPI dependency yielding a transactional registry session."""
    with registry_session_scope() as session:
        yield session
