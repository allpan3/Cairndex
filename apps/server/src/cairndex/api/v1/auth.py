"""Optional per-library passphrases stored privately on this serving instance."""

from pathlib import Path
from threading import RLock
from typing import Annotated

from fastapi import APIRouter, Cookie, Header, Response, status
from fastapi.responses import JSONResponse

from cairndex.api.deps import RegistryDbSession, authorize_library, is_bearer_authorization
from cairndex.api.schemas.auth import AccessSettingsRequest, AuthStatus, UnlockRequest
from cairndex.auth import (
    SESSION_COOKIE,
    hash_passphrase,
    is_protected,
    private_auth,
    requires_unlock,
    session_store,
    verify_passphrase,
)
from cairndex.auth.local_token import owner_session
from cairndex.auth.sessions import DEFAULT_TTL_SECONDS
from cairndex.core.errors import AuthRequiredError
from cairndex.registry import device_tokens, library_package
from cairndex.registry import services as registry_service
from cairndex.replicas.protocol import ReplicaError

router = APIRouter(prefix="/libraries/{library_id}/auth", tags=["auth"])


_settings_lock = RLock()


def _status(root: Path, *, protected: bool, unlocked: bool) -> AuthStatus:
    portable = library_package.read_manifest(root).replica is not None
    return AuthStatus(
        protected=protected,
        unlocked=unlocked,
        access_settings_version=1 if portable else 0,
        private_recovery_version=1 if portable else 0,
    )


def _library_root(registry: RegistryDbSession, library_id: str) -> Path:
    library = registry_service.get_library(registry, library_id)  # 404 if unknown
    return Path(library.root_path)


def _grant(
    response: Response, authorization: str | None, session: str | None, library_id: str
) -> None:
    effective = owner_session(authorization, session)
    if effective and effective != session:
        session_store.grant(effective, library_id)
    else:
        _set_session_cookie(response, session_store.unlock(session, library_id))


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
    effective = owner_session(authorization, session)
    if effective != session:
        return _status(
            root,
            protected=protected,
            unlocked=not requires_unlock(root, effective, library_id),
        )
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
        unlocked = not requires_unlock(root, session, library_id)
    return _status(root, protected=protected, unlocked=unlocked)


@router.post("/unlock", response_model=AuthStatus)
def unlock(
    library_id: str,
    payload: UnlockRequest,
    registry: RegistryDbSession,
    response: Response,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    authorization: Annotated[str | None, Header()] = None,
) -> AuthStatus | JSONResponse:
    root = _library_root(registry, library_id)
    with _settings_lock:
        if not is_protected(root):
            # Nothing to unlock; report the true state without touching the session.
            return _status(root, protected=False, unlocked=True)
        if not verify_passphrase(root, payload.passphrase):
            # Generic error — never reveal whether the passphrase or the library was
            # the problem. Passphrase is never logged.
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"code": "unauthorized", "message": "Incorrect passphrase."},
            )
        _grant(response, authorization, session, library_id)
        return _status(root, protected=True, unlocked=True)


@router.post("/lock", response_model=AuthStatus)
def lock(
    library_id: str,
    registry: RegistryDbSession,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    authorization: Annotated[str | None, Header()] = None,
) -> AuthStatus:
    root = _library_root(registry, library_id)
    session_store.lock(owner_session(authorization, session), library_id)
    protected = is_protected(root)
    return _status(root, protected=protected, unlocked=not protected)


@router.put("/settings", response_model=AuthStatus)
def configure_access(
    library_id: str,
    payload: AccessSettingsRequest,
    registry: RegistryDbSession,
    response: Response,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    authorization: Annotated[str | None, Header()] = None,
) -> AuthStatus:
    """Change only this server's guard, with current-passphrase reauthentication."""
    root = _library_root(registry, library_id)
    if library_package.read_manifest(root).replica is None:
        raise ReplicaError("Legacy library format is not supported")
    with _settings_lock:
        authorize_library(
            registry,
            library_id=library_id,
            root=root,
            session_cookie=session,
            authorization=authorization,
        )
        if is_protected(root) and not verify_passphrase(root, payload.current_passphrase or ""):
            raise AuthRequiredError("Incorrect current passphrase")
        # Commit revocation first: a failed storage write must not leave old grants valid.
        device_tokens.revoke_device_tokens_for_library(registry, library_id)
        registry.commit()
        session_store.revoke_library(library_id)
        private_auth.write(
            root, hash_passphrase(payload.passphrase) if payload.passphrase else None
        )
        _grant(response, authorization, session, library_id)
    return _status(root, protected=payload.passphrase is not None, unlocked=True)
