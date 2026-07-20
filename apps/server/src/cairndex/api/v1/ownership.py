"""Library ownership-lease endpoints (ADR-0018).

These are the two routes a client needs when a mount is refused: one to find out
who holds the library, and one to say "that machine is gone, serve it here".
Neither goes through the library mount gate — they have to work precisely when
the gate is closed.
"""

from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, status

from cairndex.api.deps import RegistryDbSession
from cairndex.api.schemas.ownership import LeaseHolderRead, LibraryOwnershipRead, TakeoverRead
from cairndex.core.errors import ValidationError
from cairndex.ownership import get_lease_manager
from cairndex.ownership.lease import LeaseRecord, LeaseState
from cairndex.registry import services as registry_service

router = APIRouter(prefix="/libraries/{library_id}/ownership", tags=["ownership"])

# States in which offering a takeover is the right thing to do. A live holder is
# excluded on purpose: the useful action there is to connect to that server, and
# offering a takeover would invite the user to create the dual-writer the lease
# exists to prevent.
_TAKEOVER_STATES = (LeaseState.STALE, LeaseState.UNREADABLE)

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _redirect_url(record: LeaseRecord | None) -> str | None:
    """The holder's URL, but only when it could actually mean something here.

    A loopback URL identifies the holder's *own* machine, so echoing it to a
    different client would send them to their own server (ADR-0018 §2).
    """
    if record is None or not record.advertised_url:
        return None
    host = urlsplit(record.advertised_url).hostname
    if host is None or host.lower() in _LOOPBACK_HOSTS:
        return None
    return record.advertised_url


def _holder_read(record: LeaseRecord | None) -> LeaseHolderRead | None:
    if record is None:
        return None
    return LeaseHolderRead(
        server_uuid=record.server_uuid,
        machine_name=record.machine_name or None,
        advertised_url=record.advertised_url,
        heartbeat_at=record.heartbeat_at.isoformat(),
    )


def _describe(library_id: str, root: Path) -> LibraryOwnershipRead:
    manager = get_lease_manager()
    state, record = manager.describe(library_id=library_id, root=root)
    progress = manager.takeover_progress(library_id)
    return LibraryOwnershipRead(
        library_id=library_id,
        state=state.value,
        mountable=state in (LeaseState.OWN, LeaseState.RELEASED),
        can_take_over=state in _TAKEOVER_STATES,
        redirect_url=_redirect_url(record),
        holder=_holder_read(record),
        takeover=(
            TakeoverRead(
                running=progress.running,
                error_code=progress.error_code,
                error_message=progress.error_message,
            )
            if progress is not None
            else None
        ),
    )


@router.get("", response_model=LibraryOwnershipRead)
def get_ownership(library_id: str, db: RegistryDbSession) -> LibraryOwnershipRead:
    """Who owns this library, and can this server serve it?"""
    library = registry_service.get_library(db, library_id)
    return _describe(library_id, Path(library.root_path))


@router.post("/takeover", response_model=LibraryOwnershipRead, status_code=status.HTTP_202_ACCEPTED)
def take_over(library_id: str, db: RegistryDbSession) -> LibraryOwnershipRead:
    """Confirm that the recorded holder is gone and serve this library here.

    Accepted, not completed: before taking a lease this server watches it for
    longer than a heartbeat period, so a holder that is actually alive gets the
    chance to prove it. Poll ``GET …/ownership`` until ``takeover.running`` is
    false.

    Refuses outright while a *live* lease is in place. The confirmation means "I
    know that machine is gone", which is not a claim anyone can truthfully make
    about a server that heartbeat seconds ago — so this is a 422 rather than a
    forced takeover.
    """
    library = registry_service.get_library(db, library_id)
    root = Path(library.root_path)

    manager = get_lease_manager()
    state, record = manager.describe(library_id=library_id, root=root)
    if state is LeaseState.FRESH:
        raise ValidationError(
            f"this library is actively served by {record.machine_name or 'another server'}"
            if record is not None
            else "this library is actively served by another server"
        )
    if state in _TAKEOVER_STATES:
        manager.start_takeover(library_id=library_id, root=root)
    return _describe(library_id, root)
