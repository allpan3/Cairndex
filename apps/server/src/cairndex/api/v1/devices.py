"""Anonymous pairing and owner-session device management (ADR-0015)."""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response, status
from sqlalchemy import select

from cairndex.api.deps import RegistryDbSession
from cairndex.api.schemas.devices import (
    DeviceRead,
    PairApproveRequest,
    PairPollRequest,
    PairPollResponse,
    PairStartRequest,
    PairStartResponse,
)
from cairndex.auth import SESSION_COOKIE, is_protected, requires_unlock, session_store
from cairndex.auth.device_tokens import pairing_store
from cairndex.core.errors import AuthRequiredError, NotFoundError
from cairndex.domain.enums import LibraryStatus
from cairndex.registry import device_tokens as token_service
from cairndex.registry import services as registry_service
from cairndex.registry.models import RegisteredLibrary

router = APIRouter(prefix="/auth", tags=["auth", "devices"])


def _owner_session_authorized(registry: RegistryDbSession, session_cookie: str | None) -> None:
    """Require one valid protected-library unlock without probing every root's status."""
    libraries = list(registry.scalars(select(RegisteredLibrary)))
    unlocked_ids = session_store.unlocked_library_ids(session_cookie)
    for library in libraries:
        if library.id in unlocked_ids and is_protected(Path(library.root_path)):
            return
    for library in libraries:
        if library.id not in unlocked_ids and is_protected(Path(library.root_path)):
            raise AuthRequiredError("Unlock a protected library before managing devices")


def require_owner_session(
    registry: RegistryDbSession,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> None:
    """FastAPI dependency for global device-list and revocation operations."""
    _owner_session_authorized(registry, session_cookie)


OwnerSession = Annotated[None, Depends(require_owner_session)]


@router.post("/pair/start", response_model=PairStartResponse)
def start_pairing(payload: PairStartRequest, request: Request) -> PairStartResponse:
    """Start an anonymous, bounded ten-minute pairing request."""
    source = request.client.host if request.client is not None else "unknown"
    pair_code, poll_key = pairing_store.start(payload.device_name, source=source)
    return PairStartResponse(pair_code=pair_code, poll_key=poll_key)


@router.post(
    "/pair/poll",
    response_model=PairPollResponse,
    response_model_exclude_none=True,
)
def poll_pairing(payload: PairPollRequest, registry: RegistryDbSession) -> PairPollResponse:
    """Return pending uniformly or issue one bearer token after approval."""

    def _issue(name: str, library_ids: list[str]) -> tuple[str, list[str]]:
        token = token_service.issue_device_token(registry, name=name, library_ids=library_ids)
        registry.commit()
        return token, list(library_ids)

    issued = pairing_store.consume_approval(payload.poll_key, _issue)
    if issued is None:
        return PairPollResponse(status="pending")
    token, library_ids = issued
    return PairPollResponse(status="approved", token=token, library_ids=library_ids)


@router.post("/pair/approve", status_code=status.HTTP_204_NO_CONTENT)
def approve_pairing(
    payload: PairApproveRequest,
    registry: RegistryDbSession,
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> None:
    """Approve explicit library scopes from an authorized browser session."""
    _owner_session_authorized(registry, session_cookie)
    for library_id in payload.library_ids:
        library = registry_service.get_library(registry, library_id)
        if library.status != LibraryStatus.AVAILABLE:
            raise NotFoundError(f"library {library_id!r} is currently unavailable")
        if requires_unlock(Path(library.root_path), session_cookie, library_id):
            raise AuthRequiredError(f"library {library_id!r} must be unlocked before pairing")
    if not pairing_store.approve(payload.pair_code, payload.library_ids):
        raise NotFoundError("Pairing code is invalid or expired")
    response.status_code = status.HTTP_204_NO_CONTENT


@router.get("/devices", response_model=list[DeviceRead])
def list_devices(registry: RegistryDbSession, _owner: OwnerSession) -> list[DeviceRead]:
    """List paired devices, including revoked entries for owner audit."""
    return [
        DeviceRead.model_validate(device) for device in token_service.list_device_tokens(registry)
    ]


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_device(device_id: str, registry: RegistryDbSession, _owner: OwnerSession) -> None:
    """Revoke a device bearer token immediately."""
    token_service.revoke_device_token(registry, device_id)
