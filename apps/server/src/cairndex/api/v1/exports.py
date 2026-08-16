"""Clip exports: create, poll, download (plan 1 §10 / M11).

Three short requests rather than one long one. Encoding a GIF decodes a
contiguous span of the source, which on a 4K file over a network mount can
outlast the desktop shell's 30-second relay read timeout — so the work happens
in a background worker (``media/exports``) and every route here returns at
once.

Library-scoped like the rest of the content API (ADR-0008), and an export is
only visible to the library that created it: an id is a random hex string, but
scoping the lookup means a leaked one still cannot pull an artifact out of a
library the caller does not have open.
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from cairndex.api.deps import LibraryAccessDep
from cairndex.api.schemas.exports import ClipExportCreate, ClipExportRead
from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import resolve_within_root
from cairndex.domain.enums import MediaKind
from cairndex.media import exports
from cairndex.media.exports import ClipExport, ExportManager
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile

router = APIRouter(prefix="/libraries/{library_id}", tags=["exports"])


# Process-wide singleton bound to config; tests override this dependency with a
# manager wired to a fake encoder.
def get_manager() -> ExportManager:
    return exports.get_export_manager()


ExportManagerDep = Annotated[ExportManager, Depends(get_manager)]


def _read(export: ClipExport) -> ClipExportRead:
    with export.lock:
        return ClipExportRead(
            export_id=export.id,
            kind=export.kind,
            status=export.status,
            progress=export.progress,
            filename=export.filename,
            error=export.error,
        )


def _safe_stem(title: str) -> str:
    """A filename stem from a display title, with what a name cannot hold gone.

    A display title usually still carries the source's extension, so the naive
    stem yields ``clip.mp4.gif``. Drop a short trailing suffix — bounded at five
    characters so a title that merely contains a dot ("Scene 2.5 rework") keeps
    all of it.

    The desktop shell sanitizes again on its side (`sanitize_file_name`); this
    is for the browser download and the Content-Disposition header.
    """
    stem, dot, suffix = title.rpartition(".")
    if dot and stem and 1 <= len(suffix) <= 5 and suffix.isalnum():
        title = stem
    cleaned = "".join(" " if ch in '\\/:*?"<>|' else ch for ch in title).strip()
    return cleaned or "clip"


@router.post(
    "/files/{file_id}/exports",
    response_model=ClipExportRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_export(
    library_id: str,
    file_id: str,
    body: ClipExportCreate,
    access: LibraryAccessDep,
    manager: ExportManagerDep,
) -> ClipExportRead:
    """Start encoding a GIF from a marked span. Returns immediately."""
    with access.session() as db:
        asset_file = db.get(AssetFile, file_id)
        if asset_file is None:
            raise NotFoundError(f"file {file_id!r} not found")
        if asset_file.media_kind is not MediaKind.VIDEO:
            raise ValidationError("clips are cut from video files")

        raw_duration = (asset_file.tech_metadata or {}).get("duration")
        duration = (
            float(raw_duration)
            if isinstance(raw_duration, (int, float)) and raw_duration > 0
            else None
        )
        params = exports.validated_gif_params(
            start_s=body.start_s,
            end_s=body.end_s,
            width=body.width,
            fps=body.fps,
            duration=duration,
            corner=body.watermark_corner,
        )
        watermark = exports.validated_watermark(body.watermark_png)
        library_root = library_root_for_session(db)
        source = Path(resolve_within_root(library_root, asset_file.relative_path))
        title = asset_file.display_title or Path(asset_file.relative_path).stem

    # Outside the session: creating an export starts an ffmpeg, and holding a DB
    # connection across it is what stranded connections on the streaming routes
    # (see the scoped-session note in `api/deps`).
    export = manager.create(
        library_id=library_id,
        file_id=file_id,
        source_path=source,
        params=params,
        filename=f"{_safe_stem(title)}.gif",
        watermark_png=watermark,
    )
    return _read(export)


@router.get("/files/{file_id}/exports/{export_id}", response_model=ClipExportRead)
def get_export(
    library_id: str,
    file_id: str,
    export_id: str,
    access: LibraryAccessDep,
    manager: ExportManagerDep,
) -> ClipExportRead:
    """Poll one export until it reports `done` or `failed`."""
    export = manager.get(export_id, library_id=library_id)
    if export is None or export.file_id != file_id:
        raise NotFoundError(f"export {export_id!r} not found")
    return _read(export)


@router.get("/files/{file_id}/exports/{export_id}/download")
def download_export(
    library_id: str,
    file_id: str,
    export_id: str,
    access: LibraryAccessDep,
    manager: ExportManagerDep,
) -> FileResponse:
    """Serve the finished artifact.

    The export is *not* dropped here. A download can fail halfway, and deleting
    on the way out would leave the caller with a truncated GIF and no way to ask
    again; the TTL reaper collects it instead, and the client deletes explicitly
    once it has the bytes.
    """
    export = manager.get(export_id, library_id=library_id)
    if export is None or export.file_id != file_id:
        raise NotFoundError(f"export {export_id!r} not found")
    with export.lock:
        ready = export.status == "done"
        path = export.output_path
        filename = export.filename
        reason = export.error
    if not ready:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=reason or "this export is not finished yet",
        )
    return FileResponse(
        str(path),
        media_type="image/gif",
        filename=filename,
        # Throwaway session state, exactly like an HLS segment.
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/files/{file_id}/exports/{export_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_export(
    library_id: str,
    file_id: str,
    export_id: str,
    access: LibraryAccessDep,
    manager: ExportManagerDep,
) -> None:
    """Drop an artifact once the client has it, ahead of the TTL."""
    export = manager.get(export_id, library_id=library_id)
    if export is None or export.file_id != file_id:
        raise NotFoundError(f"export {export_id!r} not found")
    manager.discard(export_id)
