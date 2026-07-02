"""Library-scoped collections endpoints (ADR-0008).

Operate on the library DB selected by ``{library_id}`` via ``LibrarySession``,
so a collection created in one library is invisible to another.
"""

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from cairndex.api.deps import IfMatchVersion, LibrarySession, Pagination
from cairndex.api.schemas.browse import CountsResponse
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.taxonomy import (
    CollectionCreate,
    CollectionRead,
    CollectionStats,
    CollectionUpdate,
)
from cairndex.core.errors import NotFoundError
from cairndex.media import thumbnails
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


@router.get("/{collection_id}/stats", response_model=CollectionStats)
def get_collection_stats(collection_id: str, db: LibrarySession) -> CollectionStats:
    """Bundle/subcollection counts for the collection inspector."""
    stats = service.collection_stats(db, collection_id)
    return CollectionStats(
        direct_bundles=stats.direct_bundles,
        total_bundles=stats.total_bundles,
        subcollections=stats.subcollections,
    )


@router.patch("/{collection_id}", response_model=CollectionRead)
def update_collection(
    collection_id: str,
    payload: CollectionUpdate,
    db: LibrarySession,
    if_match: IfMatchVersion = None,
) -> CollectionRead:
    collection = service.update_collection(
        db,
        collection_id,
        name=payload.name,
        parent_id=payload.parent_id,
        set_parent="parent_id" in payload.model_fields_set,
        note=payload.note,
        set_note="note" in payload.model_fields_set,
        cover_bundle_id=payload.cover_bundle_id,
        set_cover="cover_bundle_id" in payload.model_fields_set,
        expected_version=if_match,
    )
    return CollectionRead.model_validate(collection)


@router.get("/{collection_id}/thumbnail")
def get_collection_thumbnail(collection_id: str, db: LibrarySession) -> FileResponse:
    """Serve the collection's cover thumbnail — the chosen cover bundle's cover,
    or an auto-picked bundle from the subtree. 404 if the collection has no
    thumbnailable bundle; 503 if ffmpeg is unavailable."""
    bundle_id = service.resolve_cover_bundle_id(db, collection_id)
    if bundle_id is None:
        raise NotFoundError(f"collection {collection_id!r} has no cover")
    try:
        path = thumbnails.generate_for_bundle(db, bundle_id)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if path is None:
        raise NotFoundError(f"collection {collection_id!r} has no cover")
    return FileResponse(str(path), media_type="image/jpeg")


@router.delete("/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_collection(collection_id: str, db: LibrarySession, cascade: bool = False) -> None:
    """Remove a collection (metadata only). ``cascade=true`` also removes its
    descendant subcollections; otherwise they float to the library root."""
    service.delete_collection(db, collection_id, cascade=cascade)
