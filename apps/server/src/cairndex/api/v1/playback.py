"""Direct playback: a per-bundle manifest, range-streamed video, and VTT subs.

Library-scoped (ADR-0008): all routes live under
``/api/v1/libraries/{library_id}/...``. The manifest lists each video with a
``playable`` flag/reason so the UI can show a fallback state instead of a silent
failure (AGENTS.md §6.1). Video uses bounded, range-aware media streaming;
subtitles are served as WebVTT.
"""

import math
import mimetypes
from pathlib import Path, PurePosixPath
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from cairndex.api.deps import LibraryAccessDep, LibrarySession
from cairndex.api.schemas.bundles import FileRead
from cairndex.api.schemas.playback import (
    ContinueWatchingItem,
    ContinueWatchingPage,
    ContinueWatchingProgressRead,
    CoverFrameUpdate,
    PlayableVideo,
    PlaybackChapter,
    PlaybackManifest,
    PlaybackProgressRead,
    PlaybackProgressUpdate,
    SubtitleTrackRead,
)
from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError
from cairndex.core.time import utcnow
from cairndex.domain.enums import MediaKind
from cairndex.media import (
    contact_sheets,
    hevc_relabel,
    playback,
    previews,
    ranged_stream,
    storyboards,
    thumbnails,
)
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetBundle, AssetFile, SubtitleTrack
from cairndex.services import collections as collection_service
from cairndex.services import playback_progress as progress_service
from cairndex.services import subtitles as sub_service
from cairndex.services.bundles import get_bundle, list_active_files
from cairndex.services.pagination import MAX_LIMIT

router = APIRouter(prefix="/libraries/{library_id}", tags=["playback"])

_VTT_SERVABLE = ("srt", "vtt")


def _video_duration(asset_file: AssetFile) -> float | None:
    """Return a finite positive probed duration for cover-frame validation."""
    value = (asset_file.tech_metadata or {}).get("duration")
    if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
        return float(value)
    return None


# Convert stored chapter metadata to the public manifest shape
def _chapters(meta: dict[str, object]) -> list[PlaybackChapter]:
    raw = meta.get("chapters")
    if not isinstance(raw, list):
        return []
    chapters: list[PlaybackChapter] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        title = item.get("title")
        chapters.append(
            PlaybackChapter(
                start=float(start),
                end=float(end),
                title=title if isinstance(title, str) else None,
            )
        )
    return chapters


def _track_read(session: Session, library_id: str, track: SubtitleTrack) -> SubtitleTrackRead:
    external = track.source_file_id is not None
    src: str | None = None
    if external:
        source = session.get(AssetFile, track.source_file_id) if track.source_file_id else None
        if source is not None and extension_of(source.relative_path) in _VTT_SERVABLE:
            src = f"/api/v1/libraries/{library_id}/subtitles/{track.id}/vtt"
    return SubtitleTrackRead(
        id=track.id,
        language=track.language,
        label=playback.subtitle_label(track),
        format=track.format,
        is_default=track.is_default,
        is_forced=track.is_forced,
        kind="external" if external else "embedded",
        src=src,
    )


@router.get("/bundles/{bundle_id}/playback", response_model=PlaybackManifest)
def playback_manifest(library_id: str, bundle_id: str, db: LibrarySession) -> PlaybackManifest:
    get_bundle(db, bundle_id)  # 404 if the bundle doesn't exist
    videos: list[PlayableVideo] = []
    files = list_active_files(db, bundle_id)
    playback.reconcile_missing_files(db, files)
    video_files = [f for f in files if f.media_kind == MediaKind.VIDEO]
    progress_by_file = progress_service.progress_for_files(db, [f.id for f in video_files])
    for f in video_files:
        cap = playback.assess_playability(f)
        meta = f.tech_metadata or {}
        tracks = sub_service.list_tracks_for_video(db, f.id)
        progress = progress_by_file.get(f.id)
        videos.append(
            PlayableVideo(
                file_id=f.id,
                # The current filename, for the same reason FileRead derives it.
                display_title=PurePosixPath(f.relative_path).name,
                playable=cap.playable,
                reason=cap.reason,
                mime_type=cap.mime_type,
                stream_url=f"/api/v1/libraries/{library_id}/files/{f.id}/stream",
                width=meta.get("width"),
                height=meta.get("height"),
                duration=meta.get("duration"),
                storyboard_url=storyboards.storyboard_url_for_file(db, library_id, f),
                chapters=_chapters(meta),
                progress=(
                    PlaybackProgressRead(
                        position_s=progress.position_s,
                        duration_s=progress.duration_s,
                        completed=progress.completed,
                    )
                    if progress is not None
                    else None
                ),
                subtitles=[_track_read(db, library_id, t) for t in tracks],
            )
        )
    return PlaybackManifest(bundle_id=bundle_id, videos=videos)


# Store a video file's latest resume position
@router.put(
    "/files/{file_id}/progress",
    response_model=PlaybackProgressRead,
    status_code=status.HTTP_200_OK,
)
def update_progress(
    file_id: str, payload: PlaybackProgressUpdate, db: LibrarySession
) -> PlaybackProgressRead:
    value = progress_service.upsert_progress(
        db,
        file_id,
        position_s=payload.position_s,
        duration_s=payload.duration_s,
    )
    return PlaybackProgressRead(
        position_s=value.position_s,
        duration_s=value.duration_s,
        completed=value.completed,
    )


# Store progress from navigator.sendBeacon's POST-only transport
@router.post(
    "/files/{file_id}/progress",
    response_model=PlaybackProgressRead,
    status_code=status.HTTP_200_OK,
)
def beacon_progress(
    file_id: str, payload: PlaybackProgressUpdate, db: LibrarySession
) -> PlaybackProgressRead:
    return update_progress(file_id, payload, db)


def _touch_bundle_if_cover(db: LibrarySession, asset_file: AssetFile) -> None:
    """Refresh cover cache keys, but only where the picture actually changed.

    A file's cover frame is that file's own; it reaches the bundle's tile (and
    the collection tiles resolving through it) only when this file is already
    the bundle's cover. ``updated_at`` is the cache-busting key those tiles are
    fetched with, so bumping it for a file that is *not* the cover would
    re-fetch every one of them to show the same image.
    """
    bundle = db.get(AssetBundle, asset_file.bundle_id)
    if bundle is None or bundle.cover_file_id != asset_file.id:
        return
    bundle.updated_at = utcnow()
    collection_service.touch_cover_collections_for_bundle(db, bundle.id)


@router.post("/files/{file_id}/cover-frame", response_model=FileRead)
def set_cover_frame(file_id: str, payload: CoverFrameUpdate, db: LibrarySession) -> FileRead:
    """Persist a video cover timestamp and regenerate only its cached thumbnail.

    Scoped to *this file's* cover. Choosing which member represents the bundle
    is a separate decision with its own affordance (the star beside each row in
    the inspector's file list), and folding the two together meant picking a
    nicer frame for one video silently reassigned the whole bundle's cover
    (owner, 2026-07-30). A bundle whose cover already *is* this file naturally
    changes image, and only that case touches the bundle.
    """
    asset_file = db.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.media_kind is not MediaKind.VIDEO:
        raise ValidationError("cover frames are only supported for video files")
    # Resolve before invoking ffmpeg so missing/traversal/symlink escapes fail
    # through the same path-safe playback seam as streaming
    try:
        playback.resolve_video_path(db, file_id)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc
    duration = _video_duration(asset_file)
    if duration is None:
        raise ValidationError("video duration is unavailable")
    # Browser duration and ffprobe format duration can differ by milliseconds;
    # seek just before EOF so ffmpeg always has a decodable frame to extract
    cover_time = max(0.0, min(payload.time, max(0.0, duration - 0.1)))
    asset_file.cover_time = cover_time
    _touch_bundle_if_cover(db, asset_file)
    try:
        thumbnails.generate_for_file(db, file_id, force=True)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.flush()
    return FileRead.model_validate(asset_file)


@router.delete("/files/{file_id}/cover-frame", response_model=FileRead)
def clear_cover_frame(file_id: str, db: LibrarySession) -> FileRead:
    """Clear a selected video cover timestamp and restore automatic extraction.

    The mirror of ``set_cover_frame``: it returns this file's thumbnail to an
    automatically extracted frame and leaves the bundle's choice of cover file
    alone, because setting a frame no longer changed it.
    """
    asset_file = db.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.media_kind is not MediaKind.VIDEO:
        raise ValidationError("cover frames are only supported for video files")
    try:
        playback.resolve_video_path(db, file_id)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc
    asset_file.cover_time = None
    _touch_bundle_if_cover(db, asset_file)
    try:
        thumbnails.generate_for_file(db, file_id, force=True)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.flush()
    return FileRead.model_validate(asset_file)


# List bundles with unfinished playback progress
@router.get("/continue-watching", response_model=ContinueWatchingPage)
def continue_watching(
    db: LibrarySession,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ContinueWatchingPage:
    page = progress_service.continue_watching(db, offset=offset, limit=limit)
    return ContinueWatchingPage(
        items=[
            ContinueWatchingItem(
                **vars(item.bundle),
                progress=ContinueWatchingProgressRead(
                    file_id=item.progress.file_id,
                    position_s=item.progress.position_s,
                    duration_s=item.progress.duration_s,
                ),
            )
            for item in page.items
        ],
        total=page.total,
        offset=page.offset,
        limit=page.limit,
    )


@router.get("/files/{file_id}/stream")
def stream_file(file_id: str, access: LibraryAccessDep, request: Request) -> Response:
    """Range-streamed video, relabelling ``hev1`` HEVC as ``hvc1`` on the way out.

    The content session is scoped to path resolution and released *before* the
    response streams, so overlapping drag-seek range requests don't pin
    connections and exhaust the pool (see ``LibraryAccess``).

    An ``hev1`` file whose parameter sets are complete in ``hvcC`` is served with
    five bytes of header rewritten (``media/hevc_relabel``), which is byte-for-byte
    what a remux would have produced — so AVFoundation accepts it directly and no
    HLS session, ffmpeg run or session lifetime is involved at all. Anything the
    relabel cannot vouch for streams untouched and the decision sends it to a
    session as before.
    """
    with access.session() as db:
        path, asset_file = playback.resolve_video_path(db, file_id)
        cap = playback.assess_playability(asset_file)
        media_type, filename = cap.mime_type, asset_file.original_filename
    return _video_response(path, media_type, filename, request)


def _video_response(path: Path, media_type: str, filename: str, request: Request) -> Response:
    """Serve video bytes, patched to ``hvc1`` when that is provably equivalent."""
    relabel = hevc_relabel.relabel_for(path)
    return ranged_stream.ranged_file_response(
        path,
        media_type=media_type,
        range_header=request.headers.get("range"),
        patch=relabel.apply if relabel is not None else None,
        filename=filename,
    )


@router.get("/files/{file_id}/content")
def file_content(file_id: str, access: LibraryAccessDep) -> FileResponse:
    """Serve a file's original bytes (e.g. full-resolution images for the viewer).

    Path-safe and read-only; FileResponse honors HTTP Range so large images and
    media stream incrementally. The mime type is guessed from the filename. The
    content session is released before the response body streams (see
    ``LibraryAccess``).
    """
    with access.session() as db:
        path, asset_file = playback.resolve_file_path(db, file_id)
        filename = asset_file.original_filename
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=media_type, filename=filename)


# Serve a lazily generated WebP image preview derivative
@router.get("/files/{file_id}/preview")
def file_preview(
    file_id: str,
    access: LibraryAccessDep,
    size: Annotated[int, Query(json_schema_extra={"enum": list(previews.PREVIEW_SIZES)})] = 1600,
) -> FileResponse:
    """Serve a lazily generated, fingerprint-invalidated WebP preview.

    Uses the scoped ``LibraryAccess`` gate (like ``stream_file``): drag/scroll
    bursts abort these requests mid-flight, and a cancelled request can strand a
    ``yield``-dependency connection, draining the pool. The session closes
    inside the handler, before the response streams.
    """
    with access.session() as db:
        try:
            path = previews.preview_for_file(db, file_id, size)
        except NotFoundError:
            db.commit()  # persist access-time missing marks before the 404 response
            raise
    return FileResponse(
        str(path),
        media_type="image/webp",
        filename=path.name,
        headers={"Cache-Control": previews.PREVIEW_CACHE_CONTROL},
    )


# Serve a cached storyboard index without request-path generation
@router.get("/files/{file_id}/contact-sheet")
def get_contact_sheet(
    file_id: str,
    access: LibraryAccessDep,
    cols: Annotated[int, Query(ge=contact_sheets.MIN_COLS, le=contact_sheets.MAX_COLS)] = 4,
    rows: Annotated[int, Query(ge=contact_sheets.MIN_ROWS, le=contact_sheets.MAX_ROWS)] = 4,
    width: Annotated[
        int,
        Query(ge=contact_sheets.MIN_SHEET_WIDTH, le=contact_sheets.MAX_SHEET_WIDTH),
    ] = contact_sheets.DEFAULT_SHEET_WIDTH,
) -> FileResponse:
    """The frame grid for a contact-sheet export (plan 1 §10, first M11 slice).

    Frames only — the client composes the metadata header and the per-cell
    timestamps, which it can already render without dragging font discovery into
    the server. Generated on demand, cached by grid shape and source
    fingerprint; a scoped session so the ffmpeg run never holds a DB connection.

    ``X-Contact-Sheet-Times`` carries the instant each cell was sampled from, so
    the client labels cells from the same definition that chose the frames
    rather than reimplementing the sampling rule. Exposed to the browser because
    the desktop shell reaches this through a cross-origin relay.
    """
    with access.session() as db:
        try:
            path, times = contact_sheets.sheet_for_file(
                db, file_id, cols=cols, rows=rows, width=width
            )
        except contact_sheets.ContactSheetError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return FileResponse(
        str(path),
        media_type="image/jpeg",
        filename=path.name,
        headers={
            "Cache-Control": contact_sheets.CACHE_CONTROL,
            "X-Contact-Sheet-Times": ",".join(f"{at:.3f}" for at in times),
            "Access-Control-Expose-Headers": "X-Contact-Sheet-Times",
        },
    )


@router.get("/files/{file_id}/storyboard.vtt")
def storyboard_vtt(file_id: str, access: LibraryAccessDep) -> FileResponse:
    """Serve a cached storyboard WebVTT index, never generating on request."""
    with access.session() as db:
        path = storyboards.cached_index_for_file(db, file_id)
    return FileResponse(
        str(path),
        media_type="text/vtt",
        filename="storyboard.vtt",
        headers={"Cache-Control": storyboards.STORYBOARD_INDEX_CACHE_CONTROL},
    )


# Serve a cached storyboard sheet without request-path generation
@router.get("/files/{file_id}/storyboard/{sheet_name}.jpg")
def storyboard_sheet(file_id: str, sheet_name: str, access: LibraryAccessDep) -> FileResponse:
    """Serve a cached storyboard sheet, never generating on request.

    The seek-bar hover tooltip requests (and aborts) sheets continuously while
    scrubbing, so this must not hold a ``yield``-dependency connection (see
    ``file_preview``).
    """
    with access.session() as db:
        path = storyboards.cached_sheet_for_file(db, file_id, sheet_name)
    return FileResponse(
        str(path),
        media_type="image/jpeg",
        filename=f"{sheet_name}.jpg",
        headers={"Cache-Control": storyboards.STORYBOARD_CACHE_CONTROL},
    )


@router.get("/subtitles/{track_id}/vtt")
def subtitle_vtt(track_id: str, access: LibraryAccessDep) -> FileResponse:
    """Serve an external subtitle as WebVTT (converted + cached on first hit)."""
    with access.session() as db:
        track = sub_service.get_track(db, track_id)
        path = playback.build_vtt_for_track(db, track)
    return FileResponse(str(path), media_type="text/vtt")
