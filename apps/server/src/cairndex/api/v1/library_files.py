"""Library-scoped filesystem + job routes (ADR-0008).

The read-only File Browser, raw-file serving, manual fast-add, and scan/probe/
thumbnail/storyboard job enqueueing — all scoped to one library by
``{library_id}``. File operations use the library content session (which
resolves the library root); job enqueueing writes to the registry queue with the
``library_id`` so the worker can open the right library DB to execute.
"""

import mimetypes
from typing import Annotated

from fastapi import APIRouter, Query, status
from fastapi.responses import FileResponse

from cairndex.api.deps import LibrarySession, RegistryDbSession
from cairndex.api.schemas.file_browser import FileBrowserEntryRead, FileBrowserListingRead
from cairndex.api.schemas.files import FastAddRequest, FastAddResponse
from cairndex.api.schemas.jobs import JobRead
from cairndex.domain.enums import JobType
from cairndex.media import previews
from cairndex.registry import jobs as job_service
from cairndex.registry import services as registry_service
from cairndex.scanning.fast_add import fast_add
from cairndex.services import file_browser as file_browser_service

router = APIRouter(prefix="/libraries/{library_id}", tags=["library-files"])


@router.get("/file-browser/entries", response_model=FileBrowserListingRead)
def list_file_browser_entries(
    db: LibrarySession,
    path: Annotated[str | None, Query()] = None,
) -> FileBrowserListingRead:
    """List non-hidden directories/files under ``path`` in the library root.

    Read-only. ``path`` is library-relative (omitted = the root); absolute
    paths, traversal, NUL bytes, and symlink escapes are rejected.
    """
    listing = file_browser_service.list_entries(db, path=path)
    if listing.missing_files_updated:
        db.commit()  # make the immediate sidebar-count refresh observe the update
    return FileBrowserListingRead(
        path=listing.path,
        entries=[FileBrowserEntryRead(**vars(e)) for e in listing.entries],
        missing_files_updated=listing.missing_files_updated,
    )


@router.get("/file/preview")
def serve_file_preview(
    db: LibrarySession,
    path: Annotated[str, Query()],
    size: Annotated[int, Query(json_schema_extra={"enum": list(previews.PREVIEW_SIZES)})] = 1600,
) -> FileResponse:
    """Serve a path-scoped WebP preview for a File Browser image.

    Read-only and path-safe. Files here need not be linked into a bundle, so the
    cache key is derived from the normalized library-relative path plus source
    quick fingerprint.
    """
    target = previews.preview_for_path(db, path, size)
    return FileResponse(
        str(target),
        media_type="image/webp",
        filename=target.name,
        headers={"Cache-Control": previews.PREVIEW_CACHE_CONTROL},
    )


@router.get("/file")
def serve_file(db: LibrarySession, path: Annotated[str, Query()]) -> FileResponse:
    """Serve the raw bytes of a file under the library root (File Browser preview).

    Read-only and path-safe (same scoping as ``/file-browser/entries``). Files here
    need not be linked into a bundle. ``FileResponse`` honors HTTP Range.
    """
    target = file_browser_service.resolve_entry_path(db, path)
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(str(target), media_type=media_type, filename=target.name)


@router.post("/fast-add", response_model=FastAddResponse)
def fast_add_files(payload: FastAddRequest, db: LibrarySession) -> FastAddResponse:
    result = fast_add(
        db,
        paths=payload.paths,
        grouping=payload.grouping,
        bundle_title=payload.bundle_title,
    )
    return FastAddResponse(
        bundles_created=result.bundles_created,
        files_linked=result.files_linked,
        skipped=result.skipped,
        subtitles_linked=result.subtitles_linked,
    )


# Enqueue a registry job, optionally reusing an equivalent queued job
def _enqueue(
    registry: RegistryDbSession,
    library_id: str,
    job_type: JobType,
    payload: dict[str, object],
    *,
    dedupe: bool = False,
) -> JobRead:
    registry_service.get_library(registry, library_id)  # 404 if unknown
    create = job_service.get_or_create_queued_job if dedupe else job_service.create_job
    job = create(
        registry,
        library_id=library_id,
        job_type=job_type,
        payload=payload,
    )
    return JobRead.model_validate(job)


@router.post("/jobs/scan", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_scan(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.SCAN, {})


@router.post("/jobs/probe", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_probe(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.PROBE, {}, dedupe=True)


@router.post("/jobs/thumbnails", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_thumbnails(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.THUMBNAIL, {}, dedupe=True)


@router.post("/jobs/storyboards", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_storyboards(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.STORYBOARD, {}, dedupe=True)
