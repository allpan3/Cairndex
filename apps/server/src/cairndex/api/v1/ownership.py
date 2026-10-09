"""Serving lifecycle for private stores; portable folders carry no global lease."""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Header

from cairndex.api.deps import RegistryDbSession, authorize_library
from cairndex.api.schemas.ownership import LibraryOwnershipRead
from cairndex.auth import SESSION_COOKIE
from cairndex.core.errors import NotFoundError
from cairndex.domain.enums import LibraryStatus
from cairndex.ownership.lifecycle import lifecycle
from cairndex.registry import services as registry_service
from cairndex.replicas import recovery
from cairndex.replicas.protocol import ReplicaError

router = APIRouter(prefix="/libraries/{library_id}/ownership", tags=["ownership"])


def _describe(library_id: str, root: Path, *, released: bool = False) -> LibraryOwnershipRead:
    recovery.descriptor_at(root)
    return LibraryOwnershipRead(
        library_id=library_id,
        state="locally_released" if released else "own",
        mountable=not released and not lifecycle.blocked(library_id),
        can_take_over=False,
        redirect_url=None,
        holder=None,
        takeover=None,
    )


@router.get("", response_model=LibraryOwnershipRead)
def get_ownership(library_id: str, db: RegistryDbSession) -> LibraryOwnershipRead:
    library = registry_service.get_library(db, library_id)
    return _describe(library_id, Path(library.root_path), released=library.serving_released)


@router.post("/takeover", response_model=LibraryOwnershipRead, status_code=202)
def take_over(library_id: str, db: RegistryDbSession) -> LibraryOwnershipRead:
    registry_service.get_library(db, library_id)
    raise ReplicaError(
        "Private stores use Release and Reopen; shared-folder takeover is unsupported"
    )


@router.post("/release", response_model=LibraryOwnershipRead)
def release_library(
    library_id: str,
    db: RegistryDbSession,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> LibraryOwnershipRead:
    library = registry_service.get_library(db, library_id)
    root = Path(library.root_path)
    recovery.descriptor_at(root)
    authorize_library(
        db, library_id=library_id, root=root, session_cookie=session, authorization=authorization
    )
    library.serving_released = True
    db.commit()
    lifecycle.close(library_id)
    return _describe(library_id, root, released=True)


@router.post("/reopen", response_model=LibraryOwnershipRead)
def reopen_library(
    library_id: str,
    db: RegistryDbSession,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> LibraryOwnershipRead:
    library = registry_service.get_library(db, library_id)
    root = Path(library.root_path)
    recovery.descriptor_at(root)
    authorize_library(
        db, library_id=library_id, root=root, session_cookie=session, authorization=authorization
    )
    if library.status != LibraryStatus.AVAILABLE:
        raise NotFoundError("Library storage is unavailable; restore its mount before reopening")
    lifecycle.close(library_id)
    lifecycle.reopen(library_id)
    library.serving_released = False
    db.commit()
    return _describe(library_id, root)
