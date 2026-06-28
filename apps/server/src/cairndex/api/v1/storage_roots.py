import mimetypes
from typing import Annotated

from fastapi import APIRouter, Query, status
from fastapi.responses import FileResponse

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.file_view import FileViewEntryRead, FileViewListingRead
from cairndex.api.schemas.jobs import JobRead
from cairndex.api.schemas.storage_roots import (
    FastAddRequest,
    FastAddResponse,
    PathSuggestions,
    StorageRootCreate,
    StorageRootRead,
    StorageRootUpdate,
)
from cairndex.domain.enums import JobType
from cairndex.scanning.fast_add import fast_add
from cairndex.services import file_view as file_view_service
from cairndex.services import jobs as job_service
from cairndex.services import storage_roots as service

router = APIRouter(prefix="/storage-roots", tags=["storage-roots"])


def _enqueue(db: DbSession, root_id: str, job_type: JobType, payload: dict[str, object]) -> JobRead:
    service.get_storage_root(db, root_id)  # 404 if the root does not exist
    job = job_service.create_job(db, type=job_type, payload={"storage_root_id": root_id, **payload})
    return JobRead.model_validate(job)


@router.post("", response_model=StorageRootRead, status_code=status.HTTP_201_CREATED)
def create_storage_root(payload: StorageRootCreate, db: DbSession) -> StorageRootRead:
    root = service.create_storage_root(
        db,
        name=payload.name,
        canonical_path=payload.canonical_path,
        read_only=payload.read_only,
        create_if_missing=payload.create_if_missing,
    )
    return StorageRootRead.model_validate(root)


@router.get("", response_model=Page[StorageRootRead])
def list_storage_roots(db: DbSession, page: Pagination) -> Page[StorageRootRead]:
    roots, next_cursor = service.list_storage_roots(db, limit=page.limit, cursor=page.cursor)
    return Page(
        items=[StorageRootRead.model_validate(r) for r in roots],
        next_cursor=next_cursor,
    )


# Declared before /{root_id} so the static segment wins the route match.
@router.get("/path-suggestions", response_model=PathSuggestions)
def path_suggestions(path: Annotated[str, Query()] = "") -> PathSuggestions:
    """Directory autocompletions for the add-library form (owner setup only)."""
    return PathSuggestions(suggestions=service.suggest_paths(path))


@router.get("/{root_id}", response_model=StorageRootRead)
def get_storage_root(root_id: str, db: DbSession) -> StorageRootRead:
    return StorageRootRead.model_validate(service.get_storage_root(db, root_id))


# --- Read-only File View: storage-root filesystem browsing -------------------
@router.get("/{root_id}/entries", response_model=FileViewListingRead)
def list_file_view_entries(
    root_id: str,
    db: DbSession,
    path: Annotated[str | None, Query()] = None,
) -> FileViewListingRead:
    """List non-hidden directories/files under ``path`` in a storage root.

    Read-only. ``path`` is root-relative (omitted = the root itself); absolute
    paths, traversal, NUL bytes, and symlink escapes are rejected.
    """
    listing = file_view_service.list_entries(db, root_id, path=path)
    return FileViewListingRead(
        root_id=listing.root_id,
        path=listing.path,
        entries=[FileViewEntryRead(**vars(e)) for e in listing.entries],
    )


@router.get("/{root_id}/file")
def serve_file_view_file(
    root_id: str,
    db: DbSession,
    path: Annotated[str, Query()],
) -> FileResponse:
    """Serve the raw bytes of a file under a storage root, for File View preview.

    Read-only and path-safe (same scoping as ``/entries``): ``path`` is
    root-relative; absolute paths, traversal, NUL bytes, and symlink escapes are
    rejected. Files here need not be linked into a bundle. ``FileResponse``
    honors HTTP Range, so images and video stream incrementally.
    """
    target = file_view_service.resolve_entry_path(db, root_id, path)
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(str(target), media_type=media_type, filename=target.name)


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


# --- Async media jobs (the worker runs them; poll via /api/v1/jobs) ----------
@router.post("/{root_id}/scan", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def scan_root(root_id: str, db: DbSession) -> JobRead:
    return _enqueue(db, root_id, JobType.SCAN, {})


@router.post("/{root_id}/probe", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def probe_root(root_id: str, db: DbSession, reprobe: bool = Query(default=False)) -> JobRead:
    return _enqueue(db, root_id, JobType.PROBE, {"reprobe": reprobe})


@router.post("/{root_id}/thumbnails", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def thumbnails_root(root_id: str, db: DbSession, force: bool = Query(default=False)) -> JobRead:
    return _enqueue(db, root_id, JobType.THUMBNAIL, {"force": force})


@router.post("/{root_id}/fast-add", response_model=FastAddResponse)
def fast_add_files(root_id: str, payload: FastAddRequest, db: DbSession) -> FastAddResponse:
    result = fast_add(
        db,
        root_id,
        paths=payload.paths,
        grouping=payload.grouping,
        bundle_title=payload.bundle_title,
    )
    return FastAddResponse(
        bundles_created=result.bundles_created,
        files_linked=result.files_linked,
        skipped=result.skipped,
    )
