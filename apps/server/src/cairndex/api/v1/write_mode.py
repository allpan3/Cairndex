"""Per-library write-mode toggle (ADR-0013 §1).

The opt-in that ends the metadata-only posture for one library. Like the
``auth/*`` endpoints these are registry-level rather than content-level — they
resolve the library and read its manifest, and never open ``library.db`` — but
unlike them they are **not** reachable while a library is locked: changing what
Cairndex may do to a user's files is exactly the sort of thing the passphrase
exists to stand in front of.
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Header

from cairndex.api.deps import RegistryDbSession, authorize_library
from cairndex.api.schemas.write_mode import WriteModeRead, WriteModeUpdate
from cairndex.auth import SESSION_COOKIE
from cairndex.file_ops import gate
from cairndex.registry import services as registry_service

router = APIRouter(prefix="/libraries/{library_id}/write-mode", tags=["write mode"])


def _authorize(
    registry: RegistryDbSession,
    library_id: str,
    session_cookie: str | None,
    authorization: str | None,
) -> None:
    """Resolve the library (404) and require an unlocked session or token (401)."""
    library = registry_service.get_library(registry, library_id)
    authorize_library(
        registry,
        library_id=library_id,
        root=Path(library.root_path),
        session_cookie=session_cookie,
        authorization=authorization,
    )


def _read(state: gate.WriteModeState) -> WriteModeRead:
    return WriteModeRead(
        enabled=state.enabled,
        allowed_by_deployment=state.allowed_by_deployment,
        effective=state.effective,
        requires_passphrase=state.requires_passphrase,
    )


@router.get("", response_model=WriteModeRead)
def get_write_mode(
    library_id: str,
    registry: RegistryDbSession,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> WriteModeRead:
    """Report whether guarded file operations are permitted for this library."""
    _authorize(registry, library_id, session, authorization)
    return _read(gate.read_write_mode(registry, library_id))


@router.put("", response_model=WriteModeRead)
def set_write_mode(
    library_id: str,
    payload: WriteModeUpdate,
    registry: RegistryDbSession,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> WriteModeRead:
    """Turn write mode on or off.

    Enabling a passphrase-protected library needs that passphrase in the body —
    a one-time re-auth on the capability change, answered with a generic 401 so
    a missing passphrase and a wrong one are indistinguishable. Enabling on a
    deployment configured read-only is refused with 403 ``write_mode_disabled``.
    Disabling is always permitted for an authorized caller.
    """
    _authorize(registry, library_id, session, authorization)
    state = gate.set_write_mode(
        registry,
        library_id,
        enabled=payload.enabled,
        passphrase=payload.passphrase,
    )
    return _read(state)
