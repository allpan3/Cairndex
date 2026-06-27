from fastapi import APIRouter, status

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.browse import CountsResponse
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.taxonomy import FolderCreate, FolderRead, FolderUpdate
from cairndex.services import browse as browse_service
from cairndex.services import collections as service

# Routes/schemas keep "folder" terminology until Phase 2 renames the public API
# to /collections; the underlying domain is already a Collection.
router = APIRouter(prefix="/folders", tags=["folders"])


@router.post("", response_model=FolderRead, status_code=status.HTTP_201_CREATED)
def create_folder(payload: FolderCreate, db: DbSession) -> FolderRead:
    collection = service.create_collection(db, name=payload.name, parent_id=payload.parent_id)
    return FolderRead.model_validate(collection)


@router.get("", response_model=Page[FolderRead])
def list_folders(db: DbSession, page: Pagination) -> Page[FolderRead]:
    rows, next_cursor = service.list_collections(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[FolderRead.model_validate(f) for f in rows], next_cursor=next_cursor)


@router.get("/counts", response_model=CountsResponse)
def folder_counts(db: DbSession) -> CountsResponse:
    return CountsResponse(counts=browse_service.collection_counts(db))


@router.get("/{folder_id}", response_model=FolderRead)
def get_folder(folder_id: str, db: DbSession) -> FolderRead:
    return FolderRead.model_validate(service.get_collection(db, folder_id))


@router.patch("/{folder_id}", response_model=FolderRead)
def update_folder(folder_id: str, payload: FolderUpdate, db: DbSession) -> FolderRead:
    fields = payload.model_fields_set
    collection = service.update_collection(
        db,
        folder_id,
        name=payload.name,
        parent_id=payload.parent_id,
        set_parent="parent_id" in fields,
    )
    return FolderRead.model_validate(collection)


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(folder_id: str, db: DbSession) -> None:
    service.delete_collection(db, folder_id)
