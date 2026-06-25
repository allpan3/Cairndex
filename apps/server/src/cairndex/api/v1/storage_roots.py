from fastapi import APIRouter, status

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.storage_roots import (
    StorageRootCreate,
    StorageRootRead,
    StorageRootUpdate,
)
from cairndex.services import storage_roots as service

router = APIRouter(prefix="/storage-roots", tags=["storage-roots"])


@router.post("", response_model=StorageRootRead, status_code=status.HTTP_201_CREATED)
def create_storage_root(payload: StorageRootCreate, db: DbSession) -> StorageRootRead:
    root = service.create_storage_root(
        db,
        name=payload.name,
        canonical_path=payload.canonical_path,
        read_only=payload.read_only,
    )
    return StorageRootRead.model_validate(root)


@router.get("", response_model=Page[StorageRootRead])
def list_storage_roots(db: DbSession, page: Pagination) -> Page[StorageRootRead]:
    roots, next_cursor = service.list_storage_roots(db, limit=page.limit, cursor=page.cursor)
    return Page(
        items=[StorageRootRead.model_validate(r) for r in roots],
        next_cursor=next_cursor,
    )


@router.get("/{root_id}", response_model=StorageRootRead)
def get_storage_root(root_id: str, db: DbSession) -> StorageRootRead:
    return StorageRootRead.model_validate(service.get_storage_root(db, root_id))


@router.patch("/{root_id}", response_model=StorageRootRead)
def update_storage_root(root_id: str, payload: StorageRootUpdate, db: DbSession) -> StorageRootRead:
    root = service.update_storage_root(
        db,
        root_id,
        name=payload.name,
        canonical_path=payload.canonical_path,
        read_only=payload.read_only,
    )
    return StorageRootRead.model_validate(root)


@router.delete("/{root_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_storage_root(root_id: str, db: DbSession) -> None:
    service.delete_storage_root(db, root_id)
