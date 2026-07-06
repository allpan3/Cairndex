"""Direct playback: a per-bundle manifest, range-streamed video, and VTT subs.

Library-scoped (ADR-0008): all routes live under
``/api/v1/libraries/{library_id}/...``. The manifest lists each video with a
``playable`` flag/reason so the UI can show a fallback state instead of a silent
failure (AGENTS.md §6.1). Streaming is delegated to Starlette's ``FileResponse``,
which honors HTTP Range (206 + Content-Range). Subtitles are served as WebVTT.
"""

import mimetypes

from fastapi import APIRouter
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.playback import (
    PlayableVideo,
    PlaybackChapter,
    PlaybackManifest,
    SubtitleTrackRead,
)
from cairndex.domain.enums import MediaKind
from cairndex.media import playback, storyboards
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetFile, SubtitleTrack
from cairndex.services import subtitles as sub_service
from cairndex.services.bundles import get_bundle, list_files

router = APIRouter(prefix="/libraries/{library_id}", tags=["playback"])

_VTT_SERVABLE = ("srt", "vtt")


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
    for f in list_files(db, bundle_id):
        if f.media_kind != MediaKind.VIDEO:
            continue
        cap = playback.assess_playability(f)
        meta = f.tech_metadata or {}
        tracks = sub_service.list_tracks_for_video(db, f.id)
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
                subtitles=[_track_read(db, library_id, t) for t in tracks],
            )
        )
    return PlaybackManifest(bundle_id=bundle_id, videos=videos)


@router.get("/files/{file_id}/stream")
def stream_file(file_id: str, db: LibrarySession) -> FileResponse:
    """Range-streamed video (FileResponse emits 206/Accept-Ranges/Content-Range)."""
    path, asset_file = playback.resolve_video_path(db, file_id)
    cap = playback.assess_playability(asset_file)
    return FileResponse(str(path), media_type=cap.mime_type, filename=asset_file.original_filename)


@router.get("/files/{file_id}/content")
def file_content(file_id: str, db: LibrarySession) -> FileResponse:
    """Serve a file's original bytes (e.g. full-resolution images for the viewer).

    Path-safe and read-only; FileResponse honors HTTP Range so large images and
    media stream incrementally. The mime type is guessed from the filename.
    """
    path, asset_file = playback.resolve_file_path(db, file_id)
    media_type = mimetypes.guess_type(asset_file.original_filename)[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=media_type, filename=asset_file.original_filename)


# Serve a cached storyboard index without request-path generation
@router.get("/files/{file_id}/storyboard.vtt")
def storyboard_vtt(file_id: str, db: LibrarySession) -> FileResponse:
    """Serve a cached storyboard WebVTT index, never generating on request."""
    path = storyboards.cached_index_for_file(db, file_id)
    return FileResponse(
        str(path),
        media_type="text/vtt",
        filename="storyboard.vtt",
        headers={"Cache-Control": storyboards.STORYBOARD_CACHE_CONTROL},
    )


# Serve a cached storyboard sheet without request-path generation
@router.get("/files/{file_id}/storyboard/{sheet_name}.jpg")
def storyboard_sheet(file_id: str, sheet_name: str, db: LibrarySession) -> FileResponse:
    """Serve a cached storyboard sheet, never generating on request."""
    path = storyboards.cached_sheet_for_file(db, file_id, sheet_name)
    return FileResponse(
        str(path),
        media_type="image/jpeg",
        filename=f"{sheet_name}.jpg",
        headers={"Cache-Control": storyboards.STORYBOARD_CACHE_CONTROL},
    )


@router.get("/subtitles/{track_id}/vtt")
def subtitle_vtt(track_id: str, db: LibrarySession) -> FileResponse:
    """Serve an external subtitle as WebVTT (converted + cached on first hit)."""
    track = sub_service.get_track(db, track_id)
    path = playback.build_vtt_for_track(db, track)
    return FileResponse(str(path), media_type="text/vtt")
