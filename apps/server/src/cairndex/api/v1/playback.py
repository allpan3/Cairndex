"""Direct playback: a per-bundle manifest, range-streamed video, and VTT subs.

Library-scoped (ADR-0008): all routes live under
``/api/v1/libraries/{library_id}/...``. The manifest lists each video with a
``playable`` flag/reason so the UI can show a fallback state instead of a silent
failure (AGENTS.md §6.1). Streaming is delegated to Starlette's ``FileResponse``,
which honors HTTP Range (206 + Content-Range). Subtitles are served as WebVTT.
"""

import math
import mimetypes
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse
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
from cairndex.domain.enums import MediaKind
from cairndex.media import playback, previews, storyboards, thumbnails
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetBundle, AssetFile, SubtitleTrack
from cairndex.services import collections as collection_service
from cairndex.services import playback_progress as progress_service
from cairndex.services import subtitles as sub_service
from cairndex.services.bundles import get_bundle, list_files
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
    files = list_files(db, bundle_id)
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
                display_title=f.display_title,
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


@router.post("/files/{file_id}/cover-frame", response_model=FileRead)
def set_cover_frame(file_id: str, payload: CoverFrameUpdate, db: LibrarySession) -> FileRead:
    """Persist a video cover timestamp and regenerate only its cached thumbnail."""
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
    if payload.time > duration:
        raise ValidationError("cover frame time exceeds video duration")
    asset_file.cover_time = payload.time
    bundle = db.get(AssetBundle, asset_file.bundle_id)
    if bundle is not None:
        bundle.cover_file_id = asset_file.id
        collection_service.touch_cover_collections_for_bundle(db, bundle.id)
    try:
        thumbnails.generate_for_file(db, file_id, force=True)
    except thumbnails.ThumbnailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.flush()
    return FileRead.model_validate(asset_file)


@router.delete("/files/{file_id}/cover-frame", response_model=FileRead)
def clear_cover_frame(file_id: str, db: LibrarySession) -> FileRead:
    """Clear a selected video cover timestamp and restore automatic extraction."""
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
    collection_service.touch_cover_collections_for_bundle(db, asset_file.bundle_id)
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
def stream_file(file_id: str, access: LibraryAccessDep) -> FileResponse:
    """Range-streamed video (FileResponse emits 206/Accept-Ranges/Content-Range).

    The content session is scoped to path resolution and released *before* the
    response streams, so overlapping drag-seek range requests don't pin
    connections and exhaust the pool (see ``LibraryAccess``).
    """
    with access.session() as db:
        path, asset_file = playback.resolve_video_path(db, file_id)
        cap = playback.assess_playability(asset_file)
        media_type, filename = cap.mime_type, asset_file.original_filename
    return FileResponse(str(path), media_type=media_type, filename=filename)


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
@router.get("/files/{file_id}/storyboard.vtt")
def storyboard_vtt(file_id: str, access: LibraryAccessDep) -> FileResponse:
    """Serve a cached storyboard WebVTT index, never generating on request."""
    with access.session() as db:
        path = storyboards.cached_index_for_file(db, file_id)
    return FileResponse(
        str(path),
        media_type="text/vtt",
        filename="storyboard.vtt",
        headers={"Cache-Control": storyboards.STORYBOARD_CACHE_CONTROL},
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
