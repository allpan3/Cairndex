"""Direct playback: a per-bundle manifest, range-streamed video, and VTT subs.

`GET /bundles/{id}/playback` lists each video with a `playable` flag/reason so
the UI can show a fallback state instead of a silent failure (AGENTS.md §6.1).
Streaming is delegated to Starlette's `FileResponse`, which honors HTTP Range
(206 + Content-Range). Subtitles are served as browser-native WebVTT.
"""

import mimetypes

from fastapi import APIRouter
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from cairndex.api.deps import DbSession
from cairndex.api.schemas.playback import PlayableVideo, PlaybackManifest, SubtitleTrackRead
from cairndex.domain.enums import MediaKind
from cairndex.media import playback
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetFile, SubtitleTrack
from cairndex.services import subtitles as sub_service
from cairndex.services.bundles import get_bundle, list_files

router = APIRouter(tags=["playback"])

_VTT_SERVABLE = ("srt", "vtt")


def _track_read(session: Session, track: SubtitleTrack) -> SubtitleTrackRead:
    external = track.source_file_id is not None
    src: str | None = None
    if external:
        source = session.get(AssetFile, track.source_file_id) if track.source_file_id else None
        if source is not None and extension_of(source.relative_path) in _VTT_SERVABLE:
            src = f"/api/v1/subtitles/{track.id}/vtt"
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
def playback_manifest(bundle_id: str, db: DbSession) -> PlaybackManifest:
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
                stream_url=f"/api/v1/files/{f.id}/stream",
                width=meta.get("width"),
                height=meta.get("height"),
                duration=meta.get("duration"),
                subtitles=[_track_read(db, t) for t in tracks],
            )
        )
    return PlaybackManifest(bundle_id=bundle_id, videos=videos)


@router.get("/files/{file_id}/stream")
def stream_file(file_id: str, db: DbSession) -> FileResponse:
    """Range-streamed video (FileResponse emits 206/Accept-Ranges/Content-Range)."""
    path, asset_file = playback.resolve_video_path(db, file_id)
    cap = playback.assess_playability(asset_file)
    return FileResponse(str(path), media_type=cap.mime_type, filename=asset_file.original_filename)


@router.get("/files/{file_id}/content")
def file_content(file_id: str, db: DbSession) -> FileResponse:
    """Serve a file's original bytes (e.g. full-resolution images for the viewer).

    Path-safe and read-only; FileResponse honors HTTP Range so large images and
    media stream incrementally. The mime type is guessed from the filename.
    """
    path, asset_file = playback.resolve_file_path(db, file_id)
    media_type = mimetypes.guess_type(asset_file.original_filename)[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=media_type, filename=asset_file.original_filename)


@router.get("/subtitles/{track_id}/vtt")
def subtitle_vtt(track_id: str, db: DbSession) -> FileResponse:
    """Serve an external subtitle as WebVTT (converted + cached on first hit)."""
    track = sub_service.get_track(db, track_id)
    path = playback.build_vtt_for_track(db, track)
    return FileResponse(str(path), media_type="text/vtt")
