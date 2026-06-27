"""Direct-playback support: capability detection, path resolution, and
external-subtitle conversion to WebVTT (AGENTS.md §6.1, ADR-0003 §4).

We never claim playback support merely because a file can be served: browser
video support varies by container/codec, so each video reports a `playable`
flag plus a human reason for the UI to show a fallback state. External `.srt`
subtitles are converted to browser-native `.vtt` into the app cache (never
beside the originals).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.core.config import get_settings
from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import resolve_within_root
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetFile, SubtitleTrack

# Containers/codecs broadly playable by the HTML <video> element. MKV/AVI/WMV
# and HEVC/H.265 are intentionally excluded — support is absent or unreliable,
# and §6.1 forbids over-claiming. (Remux/transcode is the §6.2 fallback.)
_PLAYABLE_CONTAINERS: frozenset[str] = frozenset({"mp4", "m4v", "webm"})
_PLAYABLE_VCODECS: frozenset[str] = frozenset(
    {"h264", "avc", "avc1", "vp8", "vp9", "av1", "theora"}
)

_VIDEO_MIME: dict[str, str] = {
    "mp4": "video/mp4",
    "m4v": "video/x-m4v",
    "webm": "video/webm",
    "mkv": "video/x-matroska",
    "mov": "video/quicktime",
    "avi": "video/x-msvideo",
    "wmv": "video/x-ms-wmv",
    "ts": "video/mp2t",
    "m2ts": "video/mp2t",
    "flv": "video/x-flv",
    "mpg": "video/mpeg",
    "mpeg": "video/mpeg",
}


@dataclass(frozen=True)
class Playability:
    playable: bool
    reason: str  # empty when playable
    mime_type: str


def assess_playability(asset_file: AssetFile) -> Playability:
    ext = extension_of(asset_file.relative_path)
    mime = _VIDEO_MIME.get(ext, "application/octet-stream")
    if ext not in _PLAYABLE_CONTAINERS:
        return Playability(
            False, f"{ext.upper() or 'This'} container isn't playable in browsers", mime
        )

    meta = asset_file.tech_metadata or {}
    vcodec = (meta.get("video_codec") or "").lower()
    if vcodec and vcodec not in _PLAYABLE_VCODECS:
        return Playability(False, f"{vcodec.upper()} video codec isn't widely supported", mime)
    return Playability(True, "", mime)


def resolve_file_path(session: Session, file_id: str) -> tuple[Path, AssetFile]:
    """Path-safe absolute path of any available AssetFile, for serving."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.availability != FileAvailability.AVAILABLE:
        raise NotFoundError("file is missing on disk")
    abs_path = resolve_within_root(asset_file.storage_root.canonical_path, asset_file.relative_path)
    return Path(abs_path), asset_file


def resolve_video_path(session: Session, file_id: str) -> tuple[Path, AssetFile]:
    """Path-safe absolute path of a video AssetFile, for streaming."""
    path, asset_file = resolve_file_path(session, file_id)
    if asset_file.media_kind != MediaKind.VIDEO:
        raise ValidationError("only video files are streamable")
    return path, asset_file


# --- External subtitle → WebVTT ---------------------------------------------
_TIMESTAMP = re.compile(r"(\d{2}:\d{2}:\d{2}),(\d{3})")


def _srt_to_vtt(text: str) -> str:
    """Minimal SubRip→WebVTT: header + comma→dot in cue timestamps.

    SRT and VTT cue bodies are otherwise compatible for common cases; this is a
    pragmatic conversion, not a full ASS/SSA styling port.
    """
    body = _TIMESTAMP.sub(r"\1.\2", text.replace("\r\n", "\n"))
    return "WEBVTT\n\n" + body.lstrip("﻿")


def vtt_cache_path(track_id: str) -> Path:
    return get_settings().cache_dir / "subtitles" / track_id[:2] / f"{track_id}.vtt"


def build_vtt_for_track(session: Session, track: SubtitleTrack, *, force: bool = False) -> Path:
    """Return a cached WebVTT file for an external subtitle track.

    Embedded streams and styling-only formats (ASS/SSA) are not yet served
    here — that needs ffmpeg extraction (the §6.2 fallback milestone).
    """
    if track.source_file_id is None:
        raise ValidationError("embedded subtitle streams cannot be served as VTT yet")
    source = session.get(AssetFile, track.source_file_id)
    if source is None:
        raise NotFoundError("subtitle source file is missing")
    ext = extension_of(source.relative_path)
    if ext not in ("srt", "vtt"):
        raise ValidationError(f"{ext.upper()} subtitles aren't convertible to VTT yet")

    dest = vtt_cache_path(track.id)
    if dest.exists() and not force:
        return dest

    abs_path = Path(resolve_within_root(source.storage_root.canonical_path, source.relative_path))
    raw = abs_path.read_text(encoding="utf-8", errors="replace")
    vtt = raw if ext == "vtt" else _srt_to_vtt(raw)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(vtt, encoding="utf-8")
    return dest


def subtitle_label(track: SubtitleTrack) -> str:
    """A display label for a track (explicit label, else language, else 'Subtitle')."""
    if track.label:
        return track.label
    base = track.language.upper() if track.language else "Subtitle"
    return f"{base} (forced)" if track.is_forced else base
