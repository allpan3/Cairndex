"""Library-scoped collections endpoints (ADR-0008).

Operate on the library DB selected by ``{library_id}`` via ``LibrarySession``,
so a collection created in one library is invisible to another.
"""

from fastapi import APIRouter, status

from cairndex.api.deps import LibrarySession, Pagination
from cairndex.api.schemas.browse import CountsResponse
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.taxonomy import CollectionCreate, CollectionRead, CollectionUpdate
from cairndex.services import browse as browse_service
from cairndex.services import collections as service

router = APIRouter(prefix="/libraries/{library_id}/collections", tags=["library-collections"])


@router.get("/counts", response_model=CountsResponse)
def collection_counts(db: LibrarySession) -> CountsResponse:
    return CountsResponse(counts=browse_service.collection_counts(db))


@router.post("", response_model=CollectionRead, status_code=status.HTTP_201_CREATED)
def create_collection(payload: CollectionCreate, db: LibrarySession) -> CollectionRead:
    collection = service.create_collection(db, name=payload.name, parent_id=payload.parent_id)
    return CollectionRead.model_validate(collection)


@router.get("", response_model=Page[CollectionRead])
def list_collections(db: LibrarySession, page: Pagination) -> Page[CollectionRead]:
    rows, next_cursor = service.list_collections(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[CollectionRead.model_validate(c) for c in rows], next_cursor=next_cursor)


@router.get("/{collection_id}", response_model=CollectionRead)
def get_collection(collection_id: str, db: LibrarySession) -> CollectionRead:
    return CollectionRead.model_validate(service.get_collection(db, collection_id))


@router.patch("/{collection_id}", response_model=CollectionRead)
def update_collection(
    collection_id: str, payload: CollectionUpdate, db: LibrarySession
) -> CollectionRead:
    collection = service.update_collection(
        db,
        collection_id,
        name=payload.name,
        parent_id=payload.parent_id,
        set_parent="parent_id" in payload.model_fields_set,
    )
    return CollectionRead.model_validate(collection)


@router.delete("/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_collection(collection_id: str, db: LibrarySession) -> None:
    service.delete_collection(db, collection_id)
