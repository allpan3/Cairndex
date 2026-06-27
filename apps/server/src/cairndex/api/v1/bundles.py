from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.browse import BundleBrowsePage, BundleSummary, ViewCounts
from cairndex.api.schemas.bundles import (
    BatchResult,
    BatchUpdate,
    BundleCreate,
    BundleFolders,
    BundleRead,
    BundleTags,
    BundleUpdate,
    FileLink,
    FileRead,
    FileReorder,
    FileUpdate,
    SetIdsRequest,
)
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.filters import BrowseRequest
from cairndex.core.errors import NotFoundError
from cairndex.media import thumbnails
from cairndex.services import browse as browse_service
from cairndex.services import bundles as service
from cairndex.services.browse import BundleSort, SystemView
from cairndex.services.pagination import MAX_LIMIT

router = APIRouter(prefix="/bundles", tags=["bundles"])


def _thumbnail_response(path: object) -> FileResponse:
    return FileResponse(str(path), media_type="image/jpeg")


# --- Browse (declared before /{bundle_id} so the static paths win) -----------
def _browse_page(db: DbSession, **kwargs: object) -> BundleBrowsePage:
    page = browse_service.browse_bundles(db, **kwargs)  # type: ignore[arg-type]
    return BundleBrowsePage(
        items=[BundleSummary(**vars(s)) for s in page.items],
        total=page.total,
        offset=page.offset,
        limit=page.limit,
    )


@router.get("/browse", response_model=BundleBrowsePage)
def browse_bundles(
    db: DbSession,
    view: SystemView = SystemView.ALL,
    folder_id: Annotated[str | None, Query()] = None,
    include_descendants: bool = False,
    sort: BundleSort = BundleSort.DATE_ADDED,
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
) -> BundleBrowsePage:
    return _browse_page(
        db,
        view=view,
        folder_id=folder_id,
        include_descendants=include_descendants,
        sort=sort,
        descending=order == "desc",
        offset=offset,
        limit=limit,
    )


@router.post("/browse", response_model=BundleBrowsePage)
def browse_bundles_filtered(payload: BrowseRequest, db: DbSession) -> BundleBrowsePage:
    """Browse with a filter AST — the shared path for toolbar filters and
    Smart Folders. Equivalent to GET /browse when ``filter`` is null."""
    return _browse_page(
        db,
        view=payload.view,
        folder_id=payload.folder_id,
        include_descendants=payload.include_descendants,
        sort=payload.sort,
        descending=payload.order == "desc",
        offset=payload.offset,
        limit=payload.limit,
        filter_expr=payload.filter,
    )


@router.get("/counts", response_model=ViewCounts)
def bundle_view_counts(db: DbSession) -> ViewCounts:
    return ViewCounts(**browse_service.view_counts(db))


@router.post("/batch", response_model=BatchResult)
def batch_update(payload: BatchUpdate, db: DbSession) -> BatchResult:
    updated = service.batch_update_bundles(
        db,
        bundle_ids=payload.bundle_ids,
        add_tag_ids=payload.add_tag_ids,
        remove_tag_ids=payload.remove_tag_ids,
        add_collection_ids=payload.add_folder_ids,
        remove_collection_ids=payload.remove_folder_ids,
    )
    return BatchResult(updated=updated)


@router.post("", response_model=BundleRead, status_code=status.HTTP_201_CREATED)
def create_bundle(payload: BundleCreate, db: DbSession) -> BundleRead:
    bundle = service.create_bundle(
        db,
        title=payload.title,
        note=payload.note,
        rating=payload.rating,
    )
    return BundleRead.model_validate(bundle)


@router.get("", response_model=Page[BundleRead])
def list_bundles(db: DbSession, page: Pagination) -> Page[BundleRead]:
    rows, next_cursor = service.list_bundles(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[BundleRead.model_validate(b) for b in rows], next_cursor=next_cursor)


@router.get("/{bundle_id}", response_model=BundleRead)
def get_bundle(bundle_id: str, db: DbSession) -> BundleRead:
    return BundleRead.model_validate(service.get_bundle(db, bundle_id))


@router.patch("/{bundle_id}", response_model=BundleRead)
def update_bundle(bundle_id: str, payload: BundleUpdate, db: DbSession) -> BundleRead:
    changes = payload.model_dump(exclude_unset=True)
    return BundleRead.model_validate(service.update_bundle(db, bundle_id, changes))


@router.delete("/{bundle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bundle(bundle_id: str, db: DbSession) -> None:
    service.delete_bundle(db, bundle_id)


# --- Files -------------------------------------------------------------------
@router.get("/{bundle_id}/files", response_model=list[FileRead])
def list_files(bundle_id: str, db: DbSession) -> list[FileRead]:
    return [FileRead.model_validate(f) for f in service.list_files(db, bundle_id)]


@router.post("/{bundle_id}/files", response_model=FileRead, status_code=status.HTTP_201_CREATED)
def add_file(bundle_id: str, payload: FileLink, db: DbSession) -> FileRead:
    asset_file = service.add_file(
        db,
        bundle_id,
        storage_root_id=payload.storage_root_id,
        relative_path=payload.relative_path,
        role=payload.role,
        media_kind=payload.media_kind,
        display_title=payload.display_title,
        sequence=payload.sequence,
        note=payload.note,
        source=payload.source,
        mime_type=payload.mime_type,
    )
    return FileRead.model_validate(asset_file)


@router.patch("/{bundle_id}/files/{file_id}", response_model=FileRead)
def update_file(bundle_id: str, file_id: str, payload: FileUpdate, db: DbSession) -> FileRead:
    changes = payload.model_dump(exclude_unset=True)
    return FileRead.model_validate(service.update_file(db, bundle_id, file_id, changes))


@router.put("/{bundle_id}/files/order", response_model=list[FileRead])
def reorder_files(bundle_id: str, payload: FileReorder, db: DbSession) -> list[FileRead]:
    files = service.reorder_files(db, bundle_id, payload.ordered_ids)
    return [FileRead.model_validate(f) for f in files]


@router.delete("/{bundle_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_file(bundle_id: str, file_id: str, db: DbSession) -> None:
    service.remove_file(db, bundle_id, file_id)


# --- Tag / folder assignment -------------------------------------------------
@router.get("/{bundle_id}/tags", response_model=BundleTags)
def get_tags(bundle_id: str, db: DbSession) -> BundleTags:
    bundle = service.get_bundle(db, bundle_id)
    return BundleTags(bundle_id=bundle.id, tag_ids=[t.id for t in bundle.tags])


@router.put("/{bundle_id}/tags", response_model=BundleTags)
def set_tags(bundle_id: str, payload: SetIdsRequest, db: DbSession) -> BundleTags:
    bundle = service.set_bundle_tags(db, bundle_id, payload.ids)
    return BundleTags(bundle_id=bundle.id, tag_ids=[t.id for t in bundle.tags])


@router.get("/{bundle_id}/folders", response_model=BundleFolders)
def get_folders(bundle_id: str, db: DbSession) -> BundleFolders:
    bundle = service.get_bundle(db, bundle_id)
    return BundleFolders(bundle_id=bundle.id, folder_ids=[c.id for c in bundle.collections])


@router.put("/{bundle_id}/folders", response_model=BundleFolders)
def set_folders(bundle_id: str, payload: SetIdsRequest, db: DbSession) -> BundleFolders:
    bundle = service.set_bundle_collections(db, bundle_id, payload.ids)
    return BundleFolders(bundle_id=bundle.id, folder_ids=[c.id for c in bundle.collections])


# --- Thumbnails (generated lazily and cached) --------------------------------
@router.get("/{bundle_id}/thumbnail")
def get_bundle_thumbnail(bundle_id: str, db: DbSession) -> FileResponse:
    """Serve the bundle's cover thumbnail (generated on first request).

    404 if the bundle has no thumbnailable file; 503 if ffmpeg is unavailable.
    """
    try:
        path = thumbnails.generate_for_bundle(db, bundle_id)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if path is None:
        raise NotFoundError(f"bundle {bundle_id!r} has no thumbnail")
    return _thumbnail_response(path)


@router.get("/{bundle_id}/files/{file_id}/thumbnail")
def get_file_thumbnail(bundle_id: str, file_id: str, db: DbSession) -> FileResponse:
    try:
        path = thumbnails.generate_for_file(db, file_id)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _thumbnail_response(path)
