"""Smart Collection CRUD: named, persisted filter expressions (AGENTS.md §4.8)."""

from fastapi import APIRouter, status

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.smart_collections import (
    SmartCollectionCreate,
    SmartCollectionRead,
    SmartCollectionUpdate,
)
from cairndex.filters.ast import FilterExpression
from cairndex.persistence.models import SmartCollection
from cairndex.services import smart_collections as service

router = APIRouter(prefix="/libraries/{library_id}/smart-collections", tags=["smart-collections"])


def _read(sc: SmartCollection) -> SmartCollectionRead:
    return SmartCollectionRead(
        id=sc.id,
        name=sc.name,
        filter=FilterExpression.model_validate(sc.filter_json),
        default_sort=sc.default_sort,
        default_layout=sc.default_layout,
        sort_order=sc.sort_order,
        created_at=sc.created_at,
        updated_at=sc.updated_at,
    )


@router.get("", response_model=list[SmartCollectionRead])
def list_smart_collections(db: LibrarySession) -> list[SmartCollectionRead]:
    return [_read(sc) for sc in service.list_smart_collections(db)]


@router.post("", response_model=SmartCollectionRead, status_code=status.HTTP_201_CREATED)
def create_smart_collection(
    payload: SmartCollectionCreate, db: LibrarySession
) -> SmartCollectionRead:
    sc = service.create_smart_collection(
        db,
        name=payload.name,
        filter_expr=payload.filter,
        default_sort=payload.default_sort,
        default_layout=payload.default_layout,
    )
    return _read(sc)


@router.get("/{smart_collection_id}", response_model=SmartCollectionRead)
def get_smart_collection(smart_collection_id: str, db: LibrarySession) -> SmartCollectionRead:
    return _read(service.get_smart_collection(db, smart_collection_id))


@router.patch("/{smart_collection_id}", response_model=SmartCollectionRead)
def update_smart_collection(
    smart_collection_id: str, payload: SmartCollectionUpdate, db: LibrarySession
) -> SmartCollectionRead:
    fields = payload.model_fields_set
    sc = service.update_smart_collection(
        db,
        smart_collection_id,
        name=payload.name,
        filter_expr=payload.filter,
        default_sort=payload.default_sort,
        set_default_sort="default_sort" in fields,
        default_layout=payload.default_layout,
        set_default_layout="default_layout" in fields,
        sort_order=payload.sort_order,
    )
    return _read(sc)


@router.delete("/{smart_collection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_smart_collection(smart_collection_id: str, db: LibrarySession) -> None:
    service.delete_smart_collection(db, smart_collection_id)
    db.commit()
