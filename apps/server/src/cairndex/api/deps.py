from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.domain.enums import LibraryStatus
from cairndex.persistence.engine import get_session as _get_session
from cairndex.registry import services as registry_service
from cairndex.registry.engine import get_registry_session as _get_registry_session
from cairndex.registry.library_engine import get_library_sessionmaker
from cairndex.services.pagination import DEFAULT_LIMIT, MAX_LIMIT


def get_db() -> Iterator[Session]:
    """FastAPI DB-session dependency.

    Wraps the engine's transactional session scope. Overridden in tests to
    bind to the test database.
    """
    yield from _get_session()


DbSession = Annotated[Session, Depends(get_db)]


def get_registry_db() -> Iterator[Session]:
    """FastAPI registry-DB session dependency (ADR-0008).

    The registry tracks registered libraries and the job queue; it is a
    separate database from the content/library DBs. Overridden in tests.
    """
    yield from _get_registry_session()


RegistryDbSession = Annotated[Session, Depends(get_registry_db)]


def get_library_session(library_id: str, registry: RegistryDbSession) -> Iterator[Session]:
    """Yield a content session bound to one library's ``library.db`` (ADR-0008).

    Resolves ``library_id`` (path param) in the registry, refuses an
    unavailable library (offline/moved path) with 404, then yields a
    transactional session from the per-library engine cache. This is how
    library-scoped content routes (``/api/v1/libraries/{library_id}/…``) reach
    the right database without any server-global "active library".
    """
    library = registry_service.get_library(registry, library_id)  # 404 if unknown
    if library.status != LibraryStatus.AVAILABLE:
        raise NotFoundError(f"library {library_id!r} is currently unavailable")

    session = get_library_sessionmaker(library)()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


LibrarySession = Annotated[Session, Depends(get_library_session)]


class PageParams(BaseModel):
    limit: int = DEFAULT_LIMIT
    cursor: str | None = None


def page_params(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query()] = None,
) -> PageParams:
    return PageParams(limit=limit, cursor=cursor)


Pagination = Annotated[PageParams, Depends(page_params)]
