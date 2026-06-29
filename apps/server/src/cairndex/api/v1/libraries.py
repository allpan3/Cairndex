"""Library registry endpoints (ADR-0008).

Global (not library-scoped) endpoints for managing the set of registered
libraries. Per-library content endpoints already live under
``/api/v1/libraries/{library_id}/…`` in the content routers.
"""

from typing import Annotated

from fastapi import APIRouter, Query, status

from cairndex.api.deps import RegistryDbSession
from cairndex.api.schemas.files import PathSuggestions
from cairndex.registry import services as service
from cairndex.registry.schemas import LibraryCreate, LibraryRead, LibraryRegister

router = APIRouter(prefix="/libraries", tags=["libraries"])


@router.get("", response_model=list[LibraryRead])
def list_libraries(db: RegistryDbSession) -> list[LibraryRead]:
    return [LibraryRead.model_validate(lib) for lib in service.list_libraries(db)]


# Declared before /{library_id} so the static segment wins the route match.
@router.get("/path-suggestions", response_model=PathSuggestions)
def path_suggestions(path: Annotated[str, Query()] = "") -> PathSuggestions:
    """Directory autocompletions for the add-library form (owner setup only)."""
    return PathSuggestions(suggestions=service.suggest_paths(path))


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
