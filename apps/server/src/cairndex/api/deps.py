from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import Cookie, Depends, Header, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from cairndex.auth import SESSION_COOKIE, requires_unlock
from cairndex.auth.local_token import is_local_owner_token
from cairndex.core.errors import AuthRequiredError, InvalidDeviceTokenError, NotFoundError
from cairndex.domain.enums import LibraryStatus
from cairndex.file_ops import gate as write_mode_gate
from cairndex.ownership import get_lease_manager
from cairndex.persistence.engine import get_session as _get_session
from cairndex.registry import device_tokens as token_service
from cairndex.registry import services as registry_service
from cairndex.registry.engine import get_registry_session as _get_registry_session
from cairndex.registry.engine import registry_session_scope
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


def _bearer_token(authorization: str) -> str:
    """Parse an Authorization header without accepting tokens in any other channel."""
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        raise InvalidDeviceTokenError("Authorization header must contain a bearer token")
    return token.strip()


def is_bearer_authorization(authorization: str | None) -> bool:
    """Return whether the header explicitly selects the Bearer scheme."""
    return authorization is not None and authorization.partition(" ")[0].lower() == "bearer"


def require_library_ownership(library_id: str, root: Path) -> None:
    """Refuse to serve a library this server does not own (ADR-0018 §3).

    Reads need the lease as much as writes do. Browsing already writes — bundle
    cursors, missing-file reconciliation — and reading a SQLite DB that another
    machine is writing through a share or a sync engine is exactly what ADR-0008
    rejected. So there is no leaseless read-only mount: no lease, no mount.

    Cheap by construction: a library we already hold costs one dictionary
    lookup, so this adds no filesystem I/O to the request path.
    """
    get_lease_manager().ensure_owned(library_id=library_id, root=root)


def authorize_library(
    registry: Session,
    *,
    library_id: str,
    root: Path,
    session_cookie: str | None,
    authorization: str | None,
) -> None:
    """Authorize one library through an explicit bearer or the ADR-0010 cookie."""
    if is_bearer_authorization(authorization):
        assert authorization is not None
        token = _bearer_token(authorization)
        if is_local_owner_token(token):
            # The desktop sidecar's loopback owner token (ADR-0018 §5). It
            # authenticates the caller as the shell that spawned this server,
            # but unlike a paired device token it does **not** stand in for a
            # library's passphrase: it is minted with no owner approval, so a
            # locked library stays locked until someone actually unlocks it.
            if requires_unlock(root, session_cookie, library_id):
                raise AuthRequiredError(f"library {library_id!r} is locked")
            return
        token_service.authenticate_device_token(
            registry,
            token=token,
            library_id=library_id,
        )
        return
    if requires_unlock(root, session_cookie, library_id):
        raise AuthRequiredError(f"library {library_id!r} is locked")


def get_library_session(
    library_id: str,
    registry: RegistryDbSession,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> Iterator[Session]:
    """Yield a content session bound to one library's ``library.db`` (ADR-0008).

    Resolves ``library_id`` (path param) in the registry, refuses an
    unavailable library (offline/moved path) with 404, then yields a
    transactional session from the per-library engine cache. This is how
    library-scoped content routes (``/api/v1/libraries/{library_id}/…``) reach
    the right database without any server-global "active library".

    Also the single choke point for the optional per-library passphrase lock
    (ADR-0010): a protected library with no valid unlock in the caller's session
    is refused with 401 before any content is read. Unprotected libraries and
    the ``auth/*`` endpoints are unaffected.
    """
    library = registry_service.get_library(registry, library_id)  # 404 if unknown
    if library.status != LibraryStatus.AVAILABLE:
        raise NotFoundError(f"library {library_id!r} is currently unavailable")

    root = Path(library.root_path)
    authorize_library(
        registry,
        library_id=library_id,
        root=root,
        session_cookie=session_cookie,
        authorization=authorization,
    )
    require_library_ownership(library_id, root)

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


@dataclass
class RegistryAccess:
    """A registry-session factory that does NOT pin a connection (see below).

    ``RegistryDbSession`` is a ``yield`` dependency, so a route (or another
    dependency) that takes it keeps a registry connection checked out until the
    *response body finishes*. Streaming gates must instead open a short-lived
    scope through this factory and close it before the bytes flow. Overridden
    in tests to bind to the test registry session.
    """

    open_session: Callable[[], AbstractContextManager[Session]]

    def session(self) -> AbstractContextManager[Session]:
        """A transactional registry session (commit/rollback/close)."""
        return self.open_session()


def get_registry_access() -> RegistryAccess:
    return RegistryAccess(open_session=registry_session_scope)


RegistryAccessDep = Annotated[RegistryAccess, Depends(get_registry_access)]


@dataclass
class LibraryAccess:
    """An authorized library handle that does NOT pin a DB connection.

    ``LibrarySession`` is a ``yield`` dependency, so FastAPI keeps its content
    connection — and the registry connection it depends on — checked out of the
    pool until the *response body finishes*. For a streaming ``FileResponse``
    (video range requests, HLS segments, full-res images) that means two
    connections are held for the entire byte transfer. Under drag-seek, the
    browser fires many overlapping range requests, and the held connections
    exhaust the per-library and registry QueuePools; new requests then block for
    ``pool_timeout`` (30s) and fail with a ``QueuePool`` timeout 500.

    This handle does the same registry-resolution + passphrase-lock gate up
    front, but hands back a *short-lived* ``session()`` scope the caller opens
    only to resolve the path and closes **before** constructing the response.
    No connection is held while the bytes stream.
    """

    open_session: Callable[[], AbstractContextManager[Session]]

    def session(self) -> AbstractContextManager[Session]:
        """A transactional content session for this library (commit/rollback/close)."""
        return self.open_session()


def get_library_access(
    library_id: str,
    registry_access: RegistryAccessDep,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> LibraryAccess:
    """Gate library access for streaming routes without holding a connection.

    Same resolution + lock checks as ``get_library_session`` (404 for an
    unavailable library, 401 for a locked one), but returns a ``LibraryAccess``
    whose ``session()`` the caller scopes narrowly around path resolution, so
    the streaming response body runs with no DB connection checked out.

    The registry gate itself is also scoped: taking ``RegistryDbSession`` here
    would pin a *registry* connection for the whole streaming body (yield-dep
    teardown runs only after the response finishes — and not at all when a
    client abort cancels the request task, stranding the connection until GC),
    which is exactly the drag-seek pool exhaustion this dependency exists to
    prevent — the library pool was freed but the registry pool still filled,
    new gates blocked 30s at resolution, and range requests 500ed mid-drag.
    Scoping the session inside this sync function is cancellation-immune. The
    registry sessionmaker uses ``expire_on_commit=False``, so the resolved
    library row stays readable after the scope closes.
    """
    with registry_access.session() as registry:
        library = registry_service.get_library(registry, library_id)  # 404 if unknown
        if library.status != LibraryStatus.AVAILABLE:
            raise NotFoundError(f"library {library_id!r} is currently unavailable")
        authorize_library(
            registry,
            library_id=library_id,
            root=Path(library.root_path),
            session_cookie=session_cookie,
            authorization=authorization,
        )
    require_library_ownership(library_id, Path(library.root_path))
    maker = get_library_sessionmaker(library)

    @contextmanager
    def _open() -> Iterator[Session]:
        session = maker()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    return LibraryAccess(open_session=_open)


LibraryAccessDep = Annotated[LibraryAccess, Depends(get_library_access)]


def require_write_mode(library_id: str, registry: RegistryDbSession) -> None:
    """Refuse a guarded file operation on a read-only library (ADR-0013 §1).

    Declared alongside ``LibrarySession`` on every write endpoint, so the gate
    is a property of the route rather than something each handler remembers to
    check. It runs on the registry, not the library DB: the flag is server
    runtime state and the refusal must not depend on opening content.
    """
    write_mode_gate.ensure_write_mode(registry, library_id)


# Declare on a route to gate it behind write mode; the value itself is unused.
WriteModeRequired = Annotated[None, Depends(require_write_mode)]


# Optimistic-concurrency precondition (ADR-0008 phase 9). A client sends the
# ``version`` it last read; the service rejects a stale edit with 409. Optional —
# when omitted the edit is last-write-wins, so existing callers are unaffected.
IfMatchVersion = Annotated[
    int | None,
    Header(alias="If-Match", description="Expected entity version for optimistic concurrency."),
]


class PageParams(BaseModel):
    limit: int = DEFAULT_LIMIT
    cursor: str | None = None


def page_params(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query()] = None,
) -> PageParams:
    return PageParams(limit=limit, cursor=cursor)


Pagination = Annotated[PageParams, Depends(page_params)]
