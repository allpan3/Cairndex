"""Playback decisions + interactive HLS session endpoints (plan 1 §6, ADR-0014).

A cheap per-file **decision** (`POST .../playback-decision`) reports whether a
client can play a source directly or needs a server-driven HLS **session**
(remux/transcode). Sessions are created here, their VOD playlist and fMP4
segments are served on demand, and they are torn down explicitly or reaped when
idle. Path resolution stays server-side and every route is gated by the same
``LibrarySession`` dependency as direct streaming; segment/playlist bytes are
served with ``no-store`` because they are throwaway session state.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.playback import (
    AudioStreamRead,
    ClientCapabilities,
    PlaybackDecisionRequest,
    PlaybackDecisionResponse,
    PlaybackProgressRead,
    PlaybackSessionCreate,
    PlaybackSessionCreated,
    PlaybackSessionRef,
)
from cairndex.api.v1.playback import _chapters, _track_read
from cairndex.core.errors import ValidationError
from cairndex.core.paths import resolve_within_root
from cairndex.media import hls, playback
from cairndex.media.hls import BurnSubtitle, HlsSession, SessionManager, SessionParams
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.services import playback_progress as progress_service
from cairndex.services import subtitles as sub_service

router = APIRouter(prefix="/libraries/{library_id}", tags=["playback"])


# The API's HLS session manager is a process-wide singleton bound to config;
# tests override this dependency with a fake-ffmpeg manager.
def get_manager() -> SessionManager:
    return hls.get_session_manager()


SessionManagerDep = Annotated[SessionManager, Depends(get_manager)]


def _profile(caps: ClientCapabilities) -> playback.CapabilityProfile:
    return playback.CapabilityProfile.build(
        containers=caps.containers,
        video_codecs=caps.video_codecs,
        audio_codecs=caps.audio_codecs,
        max_height=caps.max_height,
        native_hls=caps.native_hls,
    )


def _duration(meta: dict[str, Any]) -> float | None:
    value = meta.get("duration")
    return float(value) if isinstance(value, (int, float)) else None


def _audio_streams(meta: dict[str, Any]) -> list[dict[str, Any]]:
    raw = meta.get("audio_streams")
    return [s for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []


def _audio_stream_reads(streams: list[dict[str, Any]]) -> list[AudioStreamRead]:
    return [
        AudioStreamRead(
            index=s.get("index") if isinstance(s.get("index"), int) else None,
            codec=s.get("codec") if isinstance(s.get("codec"), str) else None,
            channels=s.get("channels") if isinstance(s.get("channels"), int) else None,
            language=s.get("language") if isinstance(s.get("language"), str) else None,
            title=s.get("title") if isinstance(s.get("title"), str) else None,
            default=bool(s.get("default")),
        )
        for s in streams
    ]


def _decide(
    caps: playback.CapabilityProfile,
    asset_file: AssetFile,
    meta: dict[str, Any],
    *,
    audio_stream_index: int | None,
    burn_subtitle_track_id: str | None,
    max_height: int | None,
) -> playback.PlaybackDecision:
    from cairndex.media.subtitles import extension_of

    streams = _audio_streams(meta)
    height = meta.get("height")
    return playback.decide_playback(
        caps,
        ext=extension_of(asset_file.relative_path),
        video_codec=meta.get("video_codec") if isinstance(meta.get("video_codec"), str) else None,
        audio_codec=meta.get("audio_codec") if isinstance(meta.get("audio_codec"), str) else None,
        source_height=height if isinstance(height, int) else None,
        audio_stream_index=audio_stream_index,
        default_audio_index=playback.default_audio_stream_index(streams),
        burn_subtitle=burn_subtitle_track_id is not None,
        requested_max_height=max_height,
    )


def _selected_audio_codec(
    meta: dict[str, Any], streams: list[dict[str, Any]], audio_stream_index: int | None
) -> str | None:
    if audio_stream_index is not None:
        for stream in streams:
            if stream.get("index") == audio_stream_index:
                codec = stream.get("codec")
                return codec if isinstance(codec, str) else None
        return None
    default_index = playback.default_audio_stream_index(streams)
    for stream in streams:
        if stream.get("index") == default_index:
            codec = stream.get("codec")
            return codec if isinstance(codec, str) else None
    audio_codec = meta.get("audio_codec")
    return audio_codec if isinstance(audio_codec, str) else None


def _relative_subtitle_index(meta: dict[str, Any], absolute_index: int) -> int | None:
    raw = meta.get("subtitle_streams")
    streams = [s for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []
    for position, stream in enumerate(streams):
        if stream.get("index") == absolute_index:
            return position
    return None


def _resolve_burn_subtitle(
    db: Session, asset_file: AssetFile, video_path: Path, track_id: str
) -> BurnSubtitle:
    track = sub_service.get_track(db, track_id)  # 404 if unknown
    if track.video_file_id is not None and track.video_file_id != asset_file.id:
        raise ValidationError("subtitle track does not belong to this video")
    if track.source_file_id is not None:
        source = db.get(AssetFile, track.source_file_id)
        if source is None:
            raise ValidationError("subtitle source file is missing")
        path = Path(resolve_within_root(library_root_for_session(db), source.relative_path))
        return BurnSubtitle(path=path, stream_index=None)
    if track.embedded_index is not None:
        rel = _relative_subtitle_index(asset_file.tech_metadata or {}, track.embedded_index)
        if rel is None:
            raise ValidationError("cannot resolve the embedded subtitle stream for burn-in")
        return BurnSubtitle(path=video_path, stream_index=rel)
    raise ValidationError("subtitle track cannot be burned in")


def _build_params(
    db: Session,
    asset_file: AssetFile,
    video_path: Path,
    meta: dict[str, Any],
    *,
    caps: playback.CapabilityProfile,
    audio_stream_index: int | None,
    burn_subtitle_track_id: str | None,
    max_height: int | None,
) -> SessionParams:
    from cairndex.core.config import get_settings

    streams = _audio_streams(meta)
    # Validate a requested audio track whenever one is given — including on a
    # legacy row with no probed streams (an unknown index can't be honored).
    if audio_stream_index is not None:
        known = {s.get("index") for s in streams}
        if audio_stream_index not in known:
            raise ValidationError(f"audio stream {audio_stream_index} does not exist")
    selected_codec = _selected_audio_codec(meta, streams, audio_stream_index)
    audio_copy = playback.normalize_audio_codec(selected_codec) == "aac"

    effective_max_height = playback.effective_max_height(caps.max_height, max_height)

    burn = (
        _resolve_burn_subtitle(db, asset_file, video_path, burn_subtitle_track_id)
        if burn_subtitle_track_id is not None
        else None
    )
    hwaccel = get_settings().ffmpeg_hwaccel
    if hwaccel and hwaccel.lower() == "none":
        hwaccel = None
    return SessionParams(
        audio_stream_index=audio_stream_index,
        audio_copy=audio_copy,
        max_height=effective_max_height,
        burn_subtitle=burn,
        hwaccel=hwaccel,
    )


def _playlist_url(library_id: str, file_id: str, session_id: str) -> str:
    return (
        f"/api/v1/libraries/{library_id}/files/{file_id}/playback-sessions/{session_id}/index.m3u8"
    )


@dataclass
class _DecisionContext:
    """Everything the resolve→probe→decide step yields, shared by both endpoints."""

    video_path: Path
    asset_file: AssetFile
    meta: dict[str, Any]
    caps: playback.CapabilityProfile
    decision: playback.PlaybackDecision


def _resolve_and_decide(
    db: Session,
    file_id: str,
    *,
    caps: ClientCapabilities,
    audio_stream_index: int | None,
    burn_subtitle_track_id: str | None,
    max_height: int | None,
) -> _DecisionContext:
    video_path, asset_file = playback.resolve_video_path(db, file_id)
    meta = asset_file.tech_metadata or {}
    profile = _profile(caps)
    decision = _decide(
        profile,
        asset_file,
        meta,
        audio_stream_index=audio_stream_index,
        burn_subtitle_track_id=burn_subtitle_track_id,
        max_height=max_height,
    )
    return _DecisionContext(video_path, asset_file, meta, profile, decision)


def _start_session(
    manager: SessionManager,
    db: Session,
    ctx: _DecisionContext,
    *,
    library_id: str,
    file_id: str,
    audio_stream_index: int | None,
    burn_subtitle_track_id: str | None,
    max_height: int | None,
    start_s: float,
) -> HlsSession:
    params = _build_params(
        db,
        ctx.asset_file,
        ctx.video_path,
        ctx.meta,
        caps=ctx.caps,
        audio_stream_index=audio_stream_index,
        burn_subtitle_track_id=burn_subtitle_track_id,
        max_height=max_height,
    )
    return manager.create_session(
        library_id=library_id,
        file_id=file_id,
        source_path=ctx.video_path,
        duration=_duration(ctx.meta) or 0.0,
        kind=ctx.decision.session_kind,
        params=params,
        start_s=start_s,
    )


@router.post("/files/{file_id}/playback-decision", response_model=PlaybackDecisionResponse)
def playback_decision(
    library_id: str,
    file_id: str,
    payload: PlaybackDecisionRequest,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> PlaybackDecisionResponse:
    """Decide direct/remux/transcode and, for non-direct, start an HLS session."""
    ctx = _resolve_and_decide(
        db,
        file_id,
        caps=payload.caps,
        audio_stream_index=payload.audio_stream_index,
        burn_subtitle_track_id=payload.burn_subtitle_track_id,
        max_height=payload.max_height,
    )
    meta = ctx.meta
    duration = _duration(meta)
    tracks = sub_service.list_tracks_for_video(db, file_id)
    from cairndex.media import storyboards

    progress = progress_service.progress_for_files(db, [file_id]).get(file_id)

    stream_url: str | None = None
    session_ref: PlaybackSessionRef | None = None
    reason = ctx.decision.reason
    if ctx.decision.method == "direct":
        stream_url = f"/api/v1/libraries/{library_id}/files/{file_id}/stream"
    elif duration is None or duration <= 0:
        # A VOD session needs a known duration; a legacy/un-probed row can't get
        # one. Don't fail the whole decision — return it with no session so the
        # client can fall back (e.g. attempt direct) rather than getting a 422.
        reason = f"{ctx.decision.reason}; session unavailable until the file is probed"
    else:
        created = _start_session(
            manager,
            db,
            ctx,
            library_id=library_id,
            file_id=file_id,
            audio_stream_index=payload.audio_stream_index,
            burn_subtitle_track_id=payload.burn_subtitle_track_id,
            max_height=payload.max_height,
            start_s=0.0,
        )
        session_ref = PlaybackSessionRef(
            id=created.id, playlist_url=_playlist_url(library_id, file_id, created.id)
        )

    return PlaybackDecisionResponse(
        method=ctx.decision.method,
        reason=reason,
        stream_url=stream_url,
        session=session_ref,
        duration=duration,
        audio_streams=_audio_stream_reads(_audio_streams(meta)),
        subtitles=[_track_read(db, library_id, t) for t in tracks],
        chapters=_chapters(meta),
        storyboard_url=storyboards.storyboard_url_for_file(db, library_id, ctx.asset_file),
        progress=(
            PlaybackProgressRead(
                position_s=progress.position_s,
                duration_s=progress.duration_s,
                completed=progress.completed,
            )
            if progress is not None
            else None
        ),
    )


@router.post(
    "/files/{file_id}/playback-sessions",
    response_model=PlaybackSessionCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_playback_session(
    library_id: str,
    file_id: str,
    payload: PlaybackSessionCreate,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> PlaybackSessionCreated:
    """Explicitly start an HLS session (e.g. a mid-play quality/audio switch)."""
    ctx = _resolve_and_decide(
        db,
        file_id,
        caps=payload.caps,
        audio_stream_index=payload.audio_stream_index,
        burn_subtitle_track_id=payload.burn_subtitle_track_id,
        max_height=payload.max_height,
    )
    created = _start_session(
        manager,
        db,
        ctx,
        library_id=library_id,
        file_id=file_id,
        audio_stream_index=payload.audio_stream_index,
        burn_subtitle_track_id=payload.burn_subtitle_track_id,
        max_height=payload.max_height,
        start_s=payload.start_s or 0.0,
    )
    return PlaybackSessionCreated(
        session_id=created.id,
        playlist_url=_playlist_url(library_id, file_id, created.id),
        kind=ctx.decision.session_kind,
    )


@router.get("/files/{file_id}/playback-sessions/{session_id}/{artifact}")
def playback_session_artifact(
    library_id: str,
    file_id: str,
    session_id: str,
    artifact: str,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> Response:
    """Serve the session playlist, its init segment, or a media segment.

    ``db`` gates access with the same ``LibrarySession`` dependency as direct
    streaming; the bytes are throwaway session state, so ``no-store``.
    """
    no_store = {"Cache-Control": "no-store"}
    if artifact == "index.m3u8":
        body = manager.serve_playlist(library_id, session_id)
        return Response(content=body, media_type="application/vnd.apple.mpegurl", headers=no_store)
    path = manager.serve_artifact(library_id, session_id, artifact)
    return FileResponse(str(path), media_type="video/mp4", headers=no_store)


@router.delete(
    "/files/{file_id}/playback-sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_playback_session(
    library_id: str,
    file_id: str,
    session_id: str,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> Response:
    """Tear down a session (player close; a beacon may deliver this)."""
    manager.teardown(library_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
