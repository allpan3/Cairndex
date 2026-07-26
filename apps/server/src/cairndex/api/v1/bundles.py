from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse

from cairndex.api.deps import IfMatchVersion, LibraryAccessDep, LibrarySession, Pagination
from cairndex.api.schemas.browse import BundleBrowsePage, BundleSummary, ViewCounts
from cairndex.api.schemas.bundles import (
    BatchResult,
    BatchUpdate,
    BundleCleanupOrder,
    BundleCollections,
    BundleCreate,
    BundleCursorRead,
    BundleCursorUpdate,
    BundleOrder,
    BundleRead,
    BundleReorder,
    BundleTags,
    BundleUpdate,
    FileLink,
    FileRead,
    FileReorder,
    FileRepairCandidateRead,
    FileRepairRequest,
    FileUpdate,
    SetIdsRequest,
)
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.filters import BrowseRequest
from cairndex.core.errors import NotFoundError
from cairndex.media import playback, thumbnails
from cairndex.persistence.models import AssetFile
from cairndex.scanning import repair as repair_service
from cairndex.services import browse as browse_service
from cairndex.services import bundle_cursor as cursor_service
from cairndex.services import bundles as service
from cairndex.services import playback_progress as progress_service
from cairndex.services.browse import BundleSort, SystemView
from cairndex.services.pagination import MAX_LIMIT

router = APIRouter(prefix="/libraries/{library_id}/bundles", tags=["bundles"])


def _thumbnail_response(path: object) -> FileResponse:
    return FileResponse(str(path), media_type=thumbnails.thumbnail_media_type(Path(str(path))))


# Add incomplete watch progress to file rows without per-file queries
def _file_reads(db: LibrarySession, files: list[AssetFile]) -> list[FileRead]:
    file_ids = [asset_file.id for asset_file in files]
    progress_by_file = progress_service.progress_for_files(db, file_ids)
    return [
        FileRead.model_validate(asset_file).model_copy(
            update={
                "resume_position": progress_service.resume_position(
                    progress_by_file[asset_file.id].position_s
                    if asset_file.id in progress_by_file
                    else None,
                    progress_by_file[asset_file.id].completed
                    if asset_file.id in progress_by_file
                    else None,
                )
            }
        )
        for asset_file in files
    ]


# Build a bundle response with its effective ordered-media location
def _bundle_read(
    db: LibrarySession,
    bundle: object,
    current: AssetFile | None = None,
    *,
    current_resolved: bool = False,
) -> BundleRead:
    row = BundleRead.model_validate(bundle)
    if not current_resolved:
        current = cursor_service.current_file(db, row.id)
    return row.model_copy(update={"resume_file_id": current.id if current else None})


# --- Browse (declared before /{bundle_id} so the static paths win) -----------
def _browse_page(db: LibrarySession, **kwargs: object) -> BundleBrowsePage:
    page = browse_service.browse_bundles(db, **kwargs)  # type: ignore[arg-type]
    return BundleBrowsePage(
        items=[BundleSummary(**vars(s)) for s in page.items],
        total=page.total,
        offset=page.offset,
        limit=page.limit,
    )


@router.get("/browse", response_model=BundleBrowsePage)
def browse_bundles(
    db: LibrarySession,
    view: SystemView = SystemView.ALL,
    collection_id: Annotated[str | None, Query()] = None,
    include_descendants: bool = False,
    sort: BundleSort = BundleSort.DATE_ADDED,
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
    q: Annotated[str | None, Query()] = None,
) -> BundleBrowsePage:
    return _browse_page(
        db,
        view=view,
        collection_id=collection_id,
        include_descendants=include_descendants,
        sort=sort,
        descending=order == "desc",
        offset=offset,
        limit=limit,
        search=q,
    )


@router.post("/browse", response_model=BundleBrowsePage)
def browse_bundles_filtered(payload: BrowseRequest, db: LibrarySession) -> BundleBrowsePage:
    """Browse with a filter AST — the shared path for toolbar filters and
    Smart Collections. Equivalent to GET /browse when ``filter`` is null."""
    return _browse_page(
        db,
        view=payload.view,
        collection_id=payload.collection_id,
        include_descendants=payload.include_descendants,
        sort=payload.sort,
        descending=payload.order == "desc",
        offset=payload.offset,
        limit=payload.limit,
        filter_expr=payload.filter,
        search=payload.q,
    )


@router.get("/counts", response_model=ViewCounts)
def bundle_view_counts(db: LibrarySession) -> ViewCounts:
    return ViewCounts(**browse_service.view_counts(db))


@router.put("/reorder", response_model=BundleOrder)
def reorder_bundles(payload: BundleReorder, db: LibrarySession) -> BundleOrder:
    """Persist a manual drag-reorder of bundles (MANUAL sort). ``collection_id``
    scopes it to a collection's membership order; null = the global order.

    Answers with the scope's resulting order. The client applies that directly
    rather than re-fetching the listing: a refetch is a second, later answer to
    the same question, and any disagreement between it and the client's guess
    shows up as the row moving twice."""
    return BundleOrder(
        ordered_ids=browse_service.reorder_bundles(
            db,
            collection_id=payload.collection_id,
            moved_ids=payload.moved_ids,
            before_id=payload.before_id,
        )
    )


@router.post("/cleanup-order", status_code=status.HTTP_204_NO_CONTENT)
def cleanup_bundle_order(payload: BundleCleanupOrder, db: LibrarySession) -> None:
    """ "Clean up by…": rewrite the whole scope's manual order to a chosen sort."""
    browse_service.cleanup_bundle_order(
        db,
        collection_id=payload.collection_id,
        sort=BundleSort(payload.sort),
        descending=payload.order == "desc",
    )


@router.post("/batch", response_model=BatchResult)
def batch_update(payload: BatchUpdate, db: LibrarySession) -> BatchResult:
    updated = service.batch_update_bundles(
        db,
        bundle_ids=payload.bundle_ids,
        add_tag_ids=payload.add_tag_ids,
        remove_tag_ids=payload.remove_tag_ids,
        add_collection_ids=payload.add_collection_ids,
        remove_collection_ids=payload.remove_collection_ids,
    )
    return BatchResult(updated=updated)


@router.post("", response_model=BundleRead, status_code=status.HTTP_201_CREATED)
def create_bundle(payload: BundleCreate, db: LibrarySession) -> BundleRead:
    bundle = service.create_bundle(
        db,
        title=payload.title,
        notes=payload.notes,
        rating=payload.rating,
    )
    return _bundle_read(db, bundle)


@router.get("", response_model=Page[BundleRead])
def list_bundles(db: LibrarySession, page: Pagination) -> Page[BundleRead]:
    rows, next_cursor = service.list_bundles(db, limit=page.limit, cursor=page.cursor)
    current_by_bundle = cursor_service.current_files(db, [bundle.id for bundle in rows])
    return Page(
        items=[
            _bundle_read(
                db,
                bundle,
                current_by_bundle[bundle.id],
                current_resolved=True,
            )
            for bundle in rows
        ],
        next_cursor=next_cursor,
    )


@router.get("/{bundle_id}", response_model=BundleRead)
def get_bundle(bundle_id: str, db: LibrarySession) -> BundleRead:
    bundle = service.get_bundle(db, bundle_id)
    return _bundle_read(db, bundle)


@router.patch("/{bundle_id}", response_model=BundleRead)
def update_bundle(
    bundle_id: str, payload: BundleUpdate, db: LibrarySession, if_match: IfMatchVersion = None
) -> BundleRead:
    changes = payload.model_dump(exclude_unset=True)
    bundle = service.update_bundle(db, bundle_id, changes, expected_version=if_match)
    return _bundle_read(db, bundle)


@router.delete("/{bundle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bundle(bundle_id: str, db: LibrarySession) -> None:
    service.delete_bundle(db, bundle_id)


@router.post("/{bundle_id}/opened", status_code=status.HTTP_204_NO_CONTENT)
def mark_bundle_opened(bundle_id: str, db: LibrarySession) -> None:
    """Record that the owner opened this bundle (Recent view, Date Opened order).

    Fire-and-forget from the client: it stamps a timestamp and returns nothing,
    so a failure can never block opening a bundle. Not a PATCH — nothing about
    the bundle's metadata changes, and it must not consume a version.
    """
    service.mark_bundle_opened(db, bundle_id)


@router.put("/{bundle_id}/cursor", response_model=BundleCursorRead)
def update_bundle_cursor(
    bundle_id: str, payload: BundleCursorUpdate, db: LibrarySession
) -> BundleCursorRead:
    cursor = cursor_service.set_cursor(db, bundle_id, payload.file_id)
    return BundleCursorRead(file_id=cursor.file_id)


# --- Files -------------------------------------------------------------------
@router.get("/{bundle_id}/files", response_model=list[FileRead])
def list_files(bundle_id: str, db: LibrarySession) -> list[FileRead]:
    files = list(service.list_files(db, bundle_id))
    playback.reconcile_missing_files(db, files)
    return _file_reads(db, files)


@router.post("/{bundle_id}/files", response_model=FileRead, status_code=status.HTTP_201_CREATED)
def add_file(bundle_id: str, payload: FileLink, db: LibrarySession) -> FileRead:
    asset_file = service.add_file(
        db,
        bundle_id,
        relative_path=payload.relative_path,
        role=payload.role,
        media_kind=payload.media_kind,
        display_title=payload.display_title,
        sequence=payload.sequence,
        note=payload.note,
        source=payload.source,
        mime_type=payload.mime_type,
    )
    return _file_reads(db, [asset_file])[0]


@router.patch("/{bundle_id}/files/{file_id}", response_model=FileRead)
def update_file(
    bundle_id: str,
    file_id: str,
    payload: FileUpdate,
    db: LibrarySession,
    if_match: IfMatchVersion = None,
) -> FileRead:
    changes = payload.model_dump(exclude_unset=True)
    asset_file = service.update_file(db, bundle_id, file_id, changes, expected_version=if_match)
    return _file_reads(db, [asset_file])[0]


@router.put("/{bundle_id}/files/order", response_model=list[FileRead])
def reorder_files(bundle_id: str, payload: FileReorder, db: LibrarySession) -> list[FileRead]:
    files = service.reorder_files(db, bundle_id, payload.ordered_ids)
    return _file_reads(db, list(files))


@router.get(
    "/{bundle_id}/files/{file_id}/repair-candidate",
    response_model=FileRepairCandidateRead | None,
)
def get_file_repair_candidate(
    bundle_id: str, file_id: str, db: LibrarySession
) -> FileRepairCandidateRead | None:
    candidate = repair_service.find_repair_candidate(db, bundle_id, file_id)
    return FileRepairCandidateRead(**vars(candidate)) if candidate is not None else None


@router.put("/{bundle_id}/files/{file_id}/repair", response_model=FileRead)
def repair_file(
    bundle_id: str,
    file_id: str,
    payload: FileRepairRequest,
    db: LibrarySession,
) -> FileRead:
    repaired = repair_service.repair_file(
        db,
        bundle_id,
        file_id,
        payload.replacement_file_id,
    )
    return _file_reads(db, [repaired])[0]


@router.delete("/{bundle_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_file(bundle_id: str, file_id: str, db: LibrarySession) -> None:
    service.remove_file(db, bundle_id, file_id)


# --- Tag / collection assignment ---------------------------------------------
@router.get("/{bundle_id}/tags", response_model=BundleTags)
def get_tags(bundle_id: str, db: LibrarySession) -> BundleTags:
    bundle = service.get_bundle(db, bundle_id)
    return BundleTags(bundle_id=bundle.id, tag_ids=[t.id for t in bundle.tags])


@router.put("/{bundle_id}/tags", response_model=BundleTags)
def set_tags(bundle_id: str, payload: SetIdsRequest, db: LibrarySession) -> BundleTags:
    bundle = service.set_bundle_tags(db, bundle_id, payload.ids)
    return BundleTags(bundle_id=bundle.id, tag_ids=[t.id for t in bundle.tags])


@router.get("/{bundle_id}/collections", response_model=BundleCollections)
def get_collections(bundle_id: str, db: LibrarySession) -> BundleCollections:
    bundle = service.get_bundle(db, bundle_id)
    return BundleCollections(bundle_id=bundle.id, collection_ids=[c.id for c in bundle.collections])


@router.put("/{bundle_id}/collections", response_model=BundleCollections)
def set_collections(
    bundle_id: str, payload: SetIdsRequest, db: LibrarySession
) -> BundleCollections:
    bundle = service.set_bundle_collections(db, bundle_id, payload.ids)
    return BundleCollections(bundle_id=bundle.id, collection_ids=[c.id for c in bundle.collections])


# --- Thumbnails (generated lazily and cached) --------------------------------
@router.get("/{bundle_id}/thumbnail")
def get_bundle_thumbnail(bundle_id: str, access: LibraryAccessDep) -> FileResponse:
    """Serve the bundle's cover thumbnail (generated on first request).

    404 if the bundle has no thumbnailable file; 503 if ffmpeg is unavailable.
    Uses the scoped ``LibraryAccess`` gate: grid scrolling aborts thumbnail
    requests in bursts, and a cancelled request can strand a ``yield``-dependency
    connection, draining the pool (same class of bug as drag-seek on
    ``/stream``). The session closes before the image streams.
    """
    with access.session() as db:
        try:
            path = thumbnails.generate_for_bundle(db, bundle_id)
        except thumbnails.ThumbnailError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    if path is None:
        raise NotFoundError(f"bundle {bundle_id!r} has no thumbnail")
    return _thumbnail_response(path)


@router.get("/{bundle_id}/files/{file_id}/thumbnail")
def get_file_thumbnail(bundle_id: str, file_id: str, access: LibraryAccessDep) -> FileResponse:
    with access.session() as db:
        try:
            path = thumbnails.generate_for_file(db, file_id)
        except thumbnails.ThumbnailError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _thumbnail_response(path)
