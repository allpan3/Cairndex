"""Library-scoped filesystem + job routes (ADR-0008).

The read-only File Browser, raw-file serving, manual fast-add, and scan/probe/
thumbnail/storyboard job enqueueing — all scoped to one library by
``{library_id}``. File operations use the library content session (which
resolves the library root); job enqueueing writes to the registry queue with the
``library_id`` so the worker can open the right library DB to execute.
"""

import mimetypes
from typing import Annotated

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import FileResponse, Response

from cairndex.api.deps import LibraryAccessDep, LibrarySession, RegistryDbSession
from cairndex.api.schemas.file_browser import FileBrowserEntryRead, FileBrowserListingRead
from cairndex.api.schemas.files import FastAddRequest, FastAddResponse
from cairndex.api.schemas.jobs import JobRead
from cairndex.domain.enums import JobType
from cairndex.media import hevc_relabel, previews, ranged_stream
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
    access: LibraryAccessDep,
    path: Annotated[str, Query()],
    size: Annotated[int, Query(json_schema_extra={"enum": list(previews.PREVIEW_SIZES)})] = 1600,
) -> FileResponse:
    """Serve a path-scoped WebP preview for a File Browser image.

    Read-only and path-safe. Files here need not be linked into a bundle, so the
    cache key is derived from the normalized library-relative path plus source
    quick fingerprint.

    Scoped like the other streaming routes: the session closes before the body
    streams, so no connection is pinned for the transfer (see ``LibraryAccess``).
    """
    with access.session() as db:
        target = previews.preview_for_path(db, path, size)
    return FileResponse(
        str(target),
        media_type="image/webp",
        filename=target.name,
        headers={"Cache-Control": previews.PREVIEW_CACHE_CONTROL},
    )


@router.get("/file")
def serve_file(
    access: LibraryAccessDep, path: Annotated[str, Query()], request: Request
) -> Response:
    """Serve the raw bytes of a file under the library root (File Browser preview).

    Read-only and path-safe (same scoping as ``/file-browser/entries``). Files here
    need not be linked into a bundle. Range is honoured either way.

    This is the route an *unindexed* File Browser video plays through, so it sees
    the same overlapping range requests as ``/files/{id}/stream`` and needs the
    same scoped session — a yield dependency here pins two connections for the
    whole transfer and strands them outright when a seek aborts the request.

    It relabels ``hev1`` HEVC as ``hvc1`` on the way out for the same reason that
    route does: five bytes of header, byte-for-byte what a remux would produce,
    and the file plays directly instead of needing a session
    (``media/hevc_relabel``). An unindexed path benefits most — it has no row to
    hang a session's metadata on in the first place.
    """
    with access.session() as db:
        target = file_browser_service.resolve_entry_path(db, path)
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    relabel = hevc_relabel.relabel_for(target)
    return ranged_stream.ranged_file_response(
        target,
        media_type=media_type,
        range_header=request.headers.get("range"),
        patch=relabel.apply if relabel is not None else None,
        filename=target.name,
    )


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
def enqueue_scan(
    library_id: str,
    registry: RegistryDbSession,
    suggest_grouping: Annotated[bool, Query()] = True,
) -> JobRead:
    """Enqueue library discovery, optionally with the grouping-suggestion pass.

    ``suggest_grouping=false`` is discovery on its own — what "Scan new files"
    asks for. Grouping is a separate, reviewable step the owner opens
    deliberately, and running it unasked both costs a directory-tree walk and
    puts the review dialog on screen at the end of a scan (owner-reported,
    2026-08-15). The combined Update keeps the default.
    """
    return _enqueue(registry, library_id, JobType.SCAN, {"suggest_grouping": suggest_grouping})


@router.post("/jobs/probe", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_probe(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.PROBE, {}, dedupe=True)


@router.post("/jobs/thumbnails", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_thumbnails(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.THUMBNAIL, {}, dedupe=True)


@router.post("/jobs/storyboards", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def enqueue_storyboards(library_id: str, registry: RegistryDbSession) -> JobRead:
    return _enqueue(registry, library_id, JobType.STORYBOARD, {}, dedupe=True)
