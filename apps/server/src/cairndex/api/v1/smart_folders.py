"""Smart Folder CRUD: named, persisted filter expressions (AGENTS.md §4.8)."""

from fastapi import APIRouter, status

from cairndex.api.deps import DbSession
from cairndex.api.schemas.smart_folders import (
    SmartFolderCreate,
    SmartFolderRead,
    SmartFolderUpdate,
)
from cairndex.filters.ast import FilterExpression
from cairndex.persistence.models import SmartFolder
from cairndex.services import smart_folders as service

router = APIRouter(prefix="/smart-folders", tags=["smart-folders"])


def _read(sf: SmartFolder) -> SmartFolderRead:
    return SmartFolderRead(
        id=sf.id,
        name=sf.name,
        filter=FilterExpression.model_validate(sf.filter_json),
        default_sort=sf.default_sort,
        default_layout=sf.default_layout,
        sort_order=sf.sort_order,
        created_at=sf.created_at,
        updated_at=sf.updated_at,
    )


@router.get("", response_model=list[SmartFolderRead])
def list_smart_folders(db: DbSession) -> list[SmartFolderRead]:
    return [_read(sf) for sf in service.list_smart_folders(db)]


@router.post("", response_model=SmartFolderRead, status_code=status.HTTP_201_CREATED)
def create_smart_folder(payload: SmartFolderCreate, db: DbSession) -> SmartFolderRead:
    sf = service.create_smart_folder(
        db,
        name=payload.name,
        filter_expr=payload.filter,
        default_sort=payload.default_sort,
        default_layout=payload.default_layout,
        sort_order=payload.sort_order,
    )
    return _read(sf)


@router.get("/{smart_folder_id}", response_model=SmartFolderRead)
def get_smart_folder(smart_folder_id: str, db: DbSession) -> SmartFolderRead:
    return _read(service.get_smart_folder(db, smart_folder_id))


@router.patch("/{smart_folder_id}", response_model=SmartFolderRead)
def update_smart_folder(
    smart_folder_id: str, payload: SmartFolderUpdate, db: DbSession
) -> SmartFolderRead:
    fields = payload.model_fields_set
    sf = service.update_smart_folder(
        db,
        smart_folder_id,
        name=payload.name,
        filter_expr=payload.filter,
        default_sort=payload.default_sort,
        set_default_sort="default_sort" in fields,
        default_layout=payload.default_layout,
        set_default_layout="default_layout" in fields,
        sort_order=payload.sort_order,
    )
    return _read(sf)


@router.delete("/{smart_folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_smart_folder(smart_folder_id: str, db: DbSession) -> None:
    service.delete_smart_folder(db, smart_folder_id)
    db.commit()
