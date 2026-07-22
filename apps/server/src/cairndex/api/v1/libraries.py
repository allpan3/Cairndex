"""Library registry endpoints (ADR-0008).

Global (not library-scoped) endpoints for managing the set of registered
libraries. Per-library content endpoints already live under
``/api/v1/libraries/{library_id}/…`` in the content routers.
"""

from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from cairndex.api.deps import RegistryDbSession
from cairndex.registry import services as service
from cairndex.registry.schemas import (
    LibraryCreate,
    LibraryRead,
    LibraryRegister,
    PathProbeRead,
    PathSuggestion,
    PathSuggestions,
)

router = APIRouter(prefix="/libraries", tags=["libraries"])


@router.get("", response_model=list[LibraryRead])
def list_libraries(db: RegistryDbSession) -> list[LibraryRead]:
    return [LibraryRead.model_validate(lib) for lib in service.list_libraries(db)]


# Declared before /{library_id} so the static segment wins the route match.
@router.get("/path-suggestions", response_model=PathSuggestions)
def path_suggestions(path: Annotated[str, Query()] = "") -> PathSuggestions:
    """Directory autocompletions for the add-library form (owner setup only)."""
    return PathSuggestions(
        suggestions=[
            PathSuggestion(path=item.path, is_library=item.is_library)
            for item in service.suggest_paths(path)
        ]
    )


# Also before /{library_id}, for the same reason.
@router.get("/probe-path", response_model=PathProbeRead)
def probe_path(db: RegistryDbSession, path: Annotated[str, Query()]) -> PathProbeRead:
    """Report what an absolute server path is, without creating anything.

    The add-library form calls this once, on submit, so it can confirm the right
    action for the path: select an already-registered folder, register an
    existing library, or offer to make a plain (or not-yet-existing) folder into
    a new one. Owner-setup only, like ``/path-suggestions``.
    """
    probe = service.probe_path(db, path)
    return PathProbeRead(
        exists=probe.exists,
        is_library=probe.is_library,
        already_registered_id=probe.already_registered_id,
        manifest_display_name=probe.manifest_display_name,
        folder_name=probe.folder_name,
    )


@router.post("/create", response_model=LibraryRead, status_code=status.HTTP_201_CREATED)
def create_library(payload: LibraryCreate, db: RegistryDbSession) -> LibraryRead:
    library = service.create_library(
        db,
        root_path=payload.root_path,
        display_name=payload.display_name,
        create_if_missing=payload.create_if_missing,
    )
    return LibraryRead.model_validate(library)


@router.post("/register", response_model=LibraryRead, status_code=status.HTTP_201_CREATED)
def register_library(payload: LibraryRegister, db: RegistryDbSession) -> LibraryRead:
    library = service.register_existing_library(db, root_path=payload.root_path)
    return LibraryRead.model_validate(library)


@router.get("/{library_id}", response_model=LibraryRead)
def get_library(library_id: str, db: RegistryDbSession) -> LibraryRead:
    return LibraryRead.model_validate(service.get_library(db, library_id))


@router.delete("/{library_id}", status_code=status.HTTP_204_NO_CONTENT)
def deregister_library(library_id: str, db: RegistryDbSession) -> Response:
    """Remove a library from this server's registry. **Metadata-only.**

    Deletes the registry row and nothing else: the library folder, its
    ``.cairndex/`` package (manifest, ``library.db``, cache), and every media
    file stay untouched. Adding the same folder back later restores the library
    with all of its metadata, because none of it lives in the registry
    (ADR-0018 §1). This endpoint never deletes files — physical deletion is a
    separate capability that does not exist yet.

    Removing the library a client is currently viewing is allowed; the client
    falls back to its no-library state.
    """
    service.deregister_library(db, library_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
