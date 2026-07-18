"""Per-library owner passphrase lock endpoints (ADR-0010).

These stay reachable while a library is locked (they are the way to unlock it):
they are *not* behind the content gate. They resolve the library in the registry
and read its portable manifest for the passphrase hash, then grant/revoke an
unlock in the server-side session bound to the ``cairndex_session`` cookie.
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Header, Response, status
from fastapi.responses import JSONResponse

from cairndex.api.deps import RegistryDbSession, authorize_library, is_bearer_authorization
from cairndex.api.schemas.auth import AuthStatus, UnlockRequest
from cairndex.auth import (
    SESSION_COOKIE,
    is_protected,
    session_store,
    verify_passphrase,
)
from cairndex.auth.sessions import DEFAULT_TTL_SECONDS
from cairndex.registry import services as registry_service

router = APIRouter(prefix="/libraries/{library_id}/auth", tags=["auth"])


def _library_root(registry: RegistryDbSession, library_id: str) -> Path:
    library = registry_service.get_library(registry, library_id)  # 404 if unknown
    return Path(library.root_path)


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=DEFAULT_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        path="/",
    )


@router.get("/status", response_model=AuthStatus)
def auth_status(
    library_id: str,
    registry: RegistryDbSession,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    authorization: Annotated[str | None, Header()] = None,
) -> AuthStatus:
    root = _library_root(registry, library_id)
    protected = is_protected(root)
    if is_bearer_authorization(authorization):
        authorize_library(
            registry,
            library_id=library_id,
            root=root,
            session_cookie=session,
            authorization=authorization,
        )
        unlocked = True
    else:
        unlocked = (not protected) or session_store.is_unlocked(session, library_id)
    return AuthStatus(protected=protected, unlocked=unlocked)


@router.post("/unlock", response_model=AuthStatus)
def unlock(
    library_id: str,
    payload: UnlockRequest,
    registry: RegistryDbSession,
    response: Response,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> AuthStatus | JSONResponse:
    root = _library_root(registry, library_id)
    if not is_protected(root):
        # Nothing to unlock; report the true state without touching the session.
        return AuthStatus(protected=False, unlocked=True)
    if not verify_passphrase(root, payload.passphrase):
        # Generic error — never reveal whether the passphrase or the library was
        # the problem. Passphrase is never logged.
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"code": "unauthorized", "message": "Incorrect passphrase."},
        )
    token = session_store.unlock(session, library_id)
    _set_session_cookie(response, token)
    return AuthStatus(protected=True, unlocked=True)


@router.post("/lock", response_model=AuthStatus)
def lock(
    library_id: str,
    registry: RegistryDbSession,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> AuthStatus:
    root = _library_root(registry, library_id)
    session_store.lock(session, library_id)
    protected = is_protected(root)
    return AuthStatus(protected=protected, unlocked=not protected)
