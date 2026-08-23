"""Playback decisions + interactive HLS session endpoints (plan 1 §6, ADR-0014).

A cheap per-file **decision** (`POST .../playback-decision`) reports whether a
client can play a source directly or needs a server-driven HLS **session**
(remux/transcode). Sessions are created here, their VOD playlist and fMP4
segments are served on demand, and they are torn down explicitly or reaped when
idle. Path resolution stays server-side and every route is gated by the same
``LibrarySession`` dependency as direct streaming; segment/playlist bytes are
served with ``no-store`` because they are throwaway session state.
"""

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from cairndex.api.deps import LibraryAccessDep, LibrarySession
from cairndex.api.schemas.playback import (
    AudioStreamRead,
    ClientCapabilities,
    FileBrowserPlaybackDecisionRequest,
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
from cairndex.domain.enums import MediaKind
from cairndex.media import hevc_relabel, hls, playback, probe_service, tonemap
from cairndex.media.hls import BurnSubtitle, HlsSession, SessionManager, SessionParams
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.services import file_browser as file_browser_service
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


def _effective_video_tag(
    caps: playback.CapabilityProfile, meta: dict[str, Any], path: Path
) -> tuple[str | None, str | None]:
    """``(tag to decide on, why a relabel was unavailable)``.

    An `hev1` file that carries its parameter sets in `hvcC` can be served *as*
    `hvc1` by rewriting five bytes of header on the way out (see
    `media/hevc_relabel`), which makes it directly playable on a client that
    takes `hvc1` — no session, no ffmpeg, and none of the session lifetime that
    used to hang off it. Resolved here rather than in `decide_playback`, which is
    a pure function and must stay one.

    The second element is the difference between "this file cannot be relabelled"
    and "this client would not take the result anyway". Both used to fall back to
    a session in silence, which made a remux look arbitrary; whichever applies is
    now said out loud in the decision reason.
    """
    tag = meta.get("video_codec_tag") if isinstance(meta.get("video_codec_tag"), str) else None
    if tag != "hev1":
        return tag, None
    if "hvc1" not in caps.video_codec_tags:
        return tag, "this client plays no HEVC tag progressively"
    outcome = hevc_relabel.outcome_for(path)
    if outcome.relabel is not None:
        return "hvc1", None
    # No relabel *and* nothing to say means the parser found no `hev1` sample
    # entry in a file the probe called `hev1` — the two disagree, which is a
    # defect here rather than a property of the file. Say that instead of
    # falling back in silence; silence is what made this class hard to chase.
    return tag, outcome.why or "its container header does not match its probed codec tag"


def _explained(decision: playback.PlaybackDecision, note: str | None) -> playback.PlaybackDecision:
    """Append a relabel note to a non-direct decision's reason.

    Only when it is non-direct: on a `direct` decision the relabel either worked
    or was never needed, and there is nothing left to excuse.
    """
    if not note or decision.method == "direct":
        return decision
    return replace(decision, reason=f"{decision.reason}; {note}")


def _with_colour_note(
    decision: playback.PlaybackDecision, hdr: str | None
) -> playback.PlaybackDecision:
    """Say what happens to an HDR source's colour, but only where it applies.

    Transcode only: a direct play or a remux hands the source's own pixels to a
    client that said it could decode them, so colour is that client's business.
    A transcode is the one path that re-encodes, and therefore the one that can
    get colour wrong — silently, which is why it is stated. See `media/tonemap`.
    """
    if decision.method != "transcode":
        return decision
    note = tonemap.reason(hdr)
    return decision if note is None else replace(decision, reason=f"{decision.reason}; {note}")


def _decide(
    caps: playback.CapabilityProfile,
    asset_file: AssetFile,
    meta: dict[str, Any],
    video_path: Path,
    *,
    audio_stream_index: int | None,
    burn_subtitle_track_id: str | None,
    max_height: int | None,
) -> playback.PlaybackDecision:
    from cairndex.media.subtitles import extension_of

    streams = _audio_streams(meta)
    height = meta.get("height")
    depth = meta.get("bit_depth")
    tag, note = _effective_video_tag(caps, meta, video_path)
    decided = _explained(
        playback.decide_playback(
            caps,
            ext=extension_of(asset_file.relative_path),
            video_codec=meta.get("video_codec")
            if isinstance(meta.get("video_codec"), str)
            else None,
            audio_codec=meta.get("audio_codec")
            if isinstance(meta.get("audio_codec"), str)
            else None,
            video_codec_tag=tag,
            source_height=height if isinstance(height, int) else None,
            bit_depth=depth if isinstance(depth, int) else None,
            hdr=meta.get("hdr") if isinstance(meta.get("hdr"), str) else None,
            audio_stream_index=audio_stream_index,
            default_audio_index=playback.default_audio_stream_index(streams),
            burn_subtitle=burn_subtitle_track_id is not None,
            requested_max_height=max_height,
        ),
        note,
    )
    return _with_colour_note(decided, meta.get("hdr") if isinstance(meta.get("hdr"), str) else None)


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
        video_codec=playback.normalize_video_codec(meta.get("video_codec")),
        hdr=meta.get("hdr") if isinstance(meta.get("hdr"), str) else None,
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
    # A scanned-but-unprobed row has no codec, depth or duration, and the matrix
    # below is deliberately optimistic about all three — so without this the
    # answer for a fresh library is always "direct", and every source the browser
    # cannot decode fails on arrival. Bounded, cached in the row, and silent on
    # failure (see ensure_probed).
    probe_service.ensure_probed(db, asset_file)
    meta = asset_file.tech_metadata or {}
    profile = _profile(caps)
    decision = _decide(
        profile,
        asset_file,
        meta,
        video_path,
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
    access: LibraryAccessDep,
    manager: SessionManagerDep,
) -> Response:
    """Serve the session playlist, its init segment, or a media segment.

    ``access`` gates the request with the same registry/lock checks as direct
    streaming, but without pinning a DB connection while a segment streams — the
    manager serves the bytes from session state, so no content session is
    opened at all. Bytes are throwaway session state, so ``no-store``.
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
    """Tear down a session (player close, file switch, unmount)."""
    manager.teardown(library_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Teardown alias for navigator.sendBeacon, whose pagehide transport can only
# POST (it cannot issue a DELETE). Mirrors the M4 progress beacon alias so the
# web player can guarantee session cleanup even when the tab is closing.
@router.post(
    "/files/{file_id}/playback-sessions/{session_id}/teardown",
    status_code=status.HTTP_204_NO_CONTENT,
)
def beacon_teardown_playback_session(
    library_id: str,
    file_id: str,
    session_id: str,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> Response:
    """Tear down a session via a POST beacon (pagehide `navigator.sendBeacon`)."""
    manager.teardown(library_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- File Browser paths: playback without an index row -----------------------
# The File Browser is the physical surface, and a path there need not be in the
# library database at all. Until now that meant no decision: playback fell
# straight through to a native progressive read, so a fresh library could play
# only what the browser itself decodes, and everything else showed the format
# card with no server-side conversion available (owner-reported, 2026-08-15).
#
# These routes give a bare path the same decision and the same HLS sessions a
# file row gets, with an on-demand probe standing in for the stored metadata.
# What stays absent is what genuinely needs a row: subtitle tracks, storyboards,
# resume, and the cover frame.


def _path_session_key(relative_path: str) -> str:
    """Session-reuse identity for a path, in the slot a file id normally fills.

    Never leaves the server: the manager keys reuse on it, and the artifact
    routes below address a session by its own id.
    """
    return f"path:{relative_path}"


def _resolve_browser_video(db: Session, raw_path: str) -> tuple[Path, str, dict[str, Any]]:
    """Path-safe absolute path, normalized relative path, and probed metadata."""
    from cairndex.core.paths import normalize_relative_path
    from cairndex.media import probe_service
    from cairndex.scanning.media_types import classify

    video_path = file_browser_service.resolve_entry_path(db, raw_path)
    relative_path = normalize_relative_path(raw_path)
    classification = classify(video_path.name)
    if classification is None or classification[0] is not MediaKind.VIDEO:
        raise ValidationError("only video files are streamable")
    return video_path, relative_path, probe_service.probe_path(video_path) or {}


@router.post("/file-browser/playback-decision", response_model=PlaybackDecisionResponse)
def file_browser_playback_decision(
    library_id: str,
    payload: FileBrowserPlaybackDecisionRequest,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> PlaybackDecisionResponse:
    """Decide direct/remux/transcode for a library-relative path, session and all."""
    video_path, relative_path, meta = _resolve_browser_video(db, payload.path)
    caps = _profile(payload.caps)
    streams = _audio_streams(meta)
    height = meta.get("height")
    depth = meta.get("bit_depth")
    tag, note = _effective_video_tag(caps, meta, video_path)
    decision = _explained(
        playback.decide_playback(
            caps,
            ext=video_path.suffix.lstrip("."),
            video_codec=meta.get("video_codec")
            if isinstance(meta.get("video_codec"), str)
            else None,
            audio_codec=meta.get("audio_codec")
            if isinstance(meta.get("audio_codec"), str)
            else None,
            video_codec_tag=tag,
            source_height=height if isinstance(height, int) else None,
            bit_depth=depth if isinstance(depth, int) else None,
            hdr=meta.get("hdr") if isinstance(meta.get("hdr"), str) else None,
            audio_stream_index=payload.audio_stream_index,
            default_audio_index=playback.default_audio_stream_index(streams),
            requested_max_height=payload.max_height,
        ),
        note,
    )
    decision = _with_colour_note(
        decision, meta.get("hdr") if isinstance(meta.get("hdr"), str) else None
    )

    duration = _duration(meta)
    stream_url: str | None = None
    session_ref: PlaybackSessionRef | None = None
    reason = decision.reason
    if decision.method == "direct":
        stream_url = f"/api/v1/libraries/{library_id}/file?path={quote(relative_path, safe='')}"
    elif duration is None or duration <= 0:
        # Same degradation as the per-file route: answer without a session and
        # let the client fall back, rather than refusing the whole decision.
        reason = f"{decision.reason}; session unavailable until the file can be probed"
    else:
        created = manager.create_session(
            library_id=library_id,
            file_id=_path_session_key(relative_path),
            source_path=video_path,
            duration=duration,
            kind=decision.session_kind,
            params=_path_session_params(meta, caps, payload),
            start_s=payload.start_s or 0.0,
        )
        session_ref = PlaybackSessionRef(
            id=created.id,
            playlist_url=(
                f"/api/v1/libraries/{library_id}/file-browser/playback-sessions/"
                f"{created.id}/index.m3u8"
            ),
        )

    return PlaybackDecisionResponse(
        method=decision.method,
        reason=reason,
        stream_url=stream_url,
        session=session_ref,
        duration=duration,
        audio_streams=_audio_stream_reads(streams),
        # All four need a file row to hang on, which this path does not have.
        subtitles=[],
        chapters=_chapters(meta),
        storyboard_url=None,
        progress=None,
    )


def _path_session_params(
    meta: dict[str, Any],
    caps: playback.CapabilityProfile,
    payload: FileBrowserPlaybackDecisionRequest,
) -> SessionParams:
    from cairndex.core.config import get_settings

    streams = _audio_streams(meta)
    # An unknown index cannot be honored, including on a file the probe could
    # not read (no streams at all) — mirrors the per-file path.
    if payload.audio_stream_index is not None and payload.audio_stream_index not in {
        s.get("index") for s in streams
    }:
        raise ValidationError(f"audio stream {payload.audio_stream_index} does not exist")
    selected = _selected_audio_codec(meta, streams, payload.audio_stream_index)
    hwaccel = get_settings().ffmpeg_hwaccel
    if hwaccel and hwaccel.lower() == "none":
        hwaccel = None
    return SessionParams(
        audio_stream_index=payload.audio_stream_index,
        audio_copy=playback.normalize_audio_codec(selected) == "aac",
        max_height=playback.effective_max_height(caps.max_height, payload.max_height),
        burn_subtitle=None,
        hwaccel=hwaccel,
        video_codec=playback.normalize_video_codec(meta.get("video_codec")),
        hdr=meta.get("hdr") if isinstance(meta.get("hdr"), str) else None,
    )


@router.get("/file-browser/playback-sessions/{session_id}/{artifact}")
def file_browser_session_artifact(
    library_id: str,
    session_id: str,
    artifact: str,
    access: LibraryAccessDep,
    manager: SessionManagerDep,
) -> Response:
    """Serve a path-scoped session's playlist, init segment, or media segment.

    Identical to the per-file route: a session is addressed by its own id, and
    the manager holds the bytes, so nothing here needs to know what produced it.
    """
    no_store = {"Cache-Control": "no-store"}
    if artifact == "index.m3u8":
        body = manager.serve_playlist(library_id, session_id)
        return Response(content=body, media_type="application/vnd.apple.mpegurl", headers=no_store)
    path = manager.serve_artifact(library_id, session_id, artifact)
    return FileResponse(str(path), media_type="video/mp4", headers=no_store)


@router.delete(
    "/file-browser/playback-sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_file_browser_session(
    library_id: str,
    session_id: str,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> Response:
    """Tear down a path-scoped session (player close, file switch, unmount)."""
    manager.teardown(library_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/file-browser/playback-sessions/{session_id}/teardown",
    status_code=status.HTTP_204_NO_CONTENT,
)
def beacon_teardown_file_browser_session(
    library_id: str,
    session_id: str,
    db: LibrarySession,
    manager: SessionManagerDep,
) -> Response:
    """Tear down a path-scoped session via a POST beacon (see the per-file alias)."""
    manager.teardown(library_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
