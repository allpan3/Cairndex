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

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
from cairndex.persistence.engine import _apply_sqlite_pragmas
from cairndex.registry import models  # noqa: F401  (populate registry metadata)
from cairndex.registry.base import RegistryBase


def create_registry_engine(database_url: str | None = None) -> Engine:
    """Create an Engine for the registry DB and ensure its schema exists."""
    settings = get_settings()
    url = database_url or settings.resolved_registry_url()

    if url.startswith("sqlite:///") and ":memory:" not in url:
        settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)
    if engine.dialect.name == "sqlite":
        event.listen(engine, "connect", _apply_sqlite_pragmas)
    RegistryBase.metadata.create_all(engine)
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
