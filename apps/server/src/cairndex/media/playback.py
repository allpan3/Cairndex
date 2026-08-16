"""Direct-playback support: capability detection, path resolution, and
external-subtitle conversion to WebVTT (AGENTS.md §6.1, ADR-0003 §4).

We never claim playback support merely because a file can be served: browser
video support varies by container/codec, so each video reports a `playable`
flag plus a human reason for the UI to show a fallback state. External `.srt`
subtitles are converted to browser-native `.vtt` into the library's portable
``.cairndex/cache/subtitles/`` (ADR-0008 phase 8), never beside the originals.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import resolve_within_root
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.subtitles import extension_of
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile, SubtitleTrack
from cairndex.registry import library_package

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
    # This flag is the client's *native fallback* when a decision cannot be made
    # or fails, so claiming it for a source no browser decodes sends playback
    # back to the same refusal. Depth and Dolby Vision are exactly that case:
    # the container and codec name both look ordinary (see `decide_playback`).
    if (meta.get("hdr") or "").lower() == "dv":
        return Playability(False, "Dolby Vision needs conversion to play in a browser", mime)
    depth = meta.get("bit_depth")
    if isinstance(depth, int) and depth > 8:
        return Playability(False, f"{depth}-bit video isn't widely supported", mime)
    return Playability(True, "", mime)


# --- Playback decision matrix (plan 1 §6.1) ---------------------------------
# A pure, side-effect-free function decides direct / remux / transcode from the
# client's declared capabilities versus the source's probed container+codecs. It
# is the single source of truth reused by the decision endpoint and by session
# creation, and it must degrade safely on legacy rows missing M1 probe keys
# (unknown codec → optimistic, never a 500).

# Normalize container/codec aliases to the canonical tokens clients report via
# canPlayType/isTypeSupported so caps membership tests are apples-to-apples.
_CONTAINER_BY_EXT: dict[str, str] = {
    "mp4": "mp4",
    "m4v": "mp4",
    "mov": "mov",
    "webm": "webm",
    "mkv": "mkv",
    "avi": "avi",
    "wmv": "asf",
    "asf": "asf",
    "flv": "flv",
    "ts": "mpegts",
    "m2ts": "mpegts",
    "mts": "mpegts",
    "mpg": "mpeg",
    "mpeg": "mpeg",
    "ogv": "ogg",
    "3gp": "3gp",
}
_VIDEO_CODEC_ALIASES: dict[str, str] = {
    "avc": "h264",
    "avc1": "h264",
    "h.264": "h264",
    "x264": "h264",
    "hevc": "hevc",
    "h265": "hevc",
    "h.265": "hevc",
    "hvc1": "hevc",
    "hev1": "hevc",
    "vp08": "vp8",
    "vp09": "vp9",
}
_AUDIO_CODEC_ALIASES: dict[str, str] = {
    "mp4a": "aac",
    "ac-3": "ac3",
    "eac-3": "eac3",
    "e-ac-3": "eac3",
    "dca": "dts",
    "mp3float": "mp3",
}

# Codec tags a client must confirm *by tag* before we hand it the source
# directly. The codec family alone is not enough for HEVC: it rides as either
# ``hvc1`` (decoder config in the container header) or ``hev1`` (config allowed
# in-band and allowed to change), and AVFoundation — Safari, and so the desktop
# shell's WKWebView — plays only ``hvc1``. Since both tags normalize to ``hevc``,
# a family-only test sends an ``hev1`` source down the direct path where it
# cannot play at all. Tags outside this set are not discriminating and are
# ignored, so nothing else changes behaviour.
_TAG_SENSITIVE_CODECS: dict[str, frozenset[str]] = {
    "hevc": frozenset({"hvc1", "hev1"}),
}
_ALL_DISCRIMINATING_TAGS: frozenset[str] = frozenset().union(*_TAG_SENSITIVE_CODECS.values())

# Codec support is not depth-independent, and the codec name does not say which
# depth a source uses. A browser answering "probably" to `avc1.640028` or
# `hvc1.1.6.L93.B0` has answered about **8-bit** — those are High and Main
# profile strings — so a 10-bit source of the same codec family passes the
# family test and is then refused by the engine. High 10 H.264 is the worst
# case: no browser decodes it at all, and it is common in real libraries
# (owner-reported "this video can't be played here" on a probed MP4,
# 2026-08-15). The client advertises these extra tokens for the depths it
# separately confirmed; a source deeper than 8 bits needs the matching one.
_HIGH_DEPTH_TOKEN_BY_CODEC: dict[str, str] = {
    "h264": "h26410",
    "hevc": "hevc10",
    "vp9": "vp910",
    "av1": "av110",
}
_ALL_HIGH_DEPTH_TOKENS: frozenset[str] = frozenset(_HIGH_DEPTH_TOKEN_BY_CODEC.values())


def normalize_codec_tag(value: str | None) -> str | None:
    """Canonical four-character codec tag, or ``None`` when absent/meaningless."""
    if not value:
        return None
    token = value.strip().lower()
    if not token or token.startswith("[") or set(token) <= {"0"}:
        return None
    return token


def _normalize_token(value: str | None, aliases: Mapping[str, str]) -> str | None:
    if not value:
        return None
    token = value.strip().lower()
    if not token:
        return None
    return aliases.get(token, token)


def normalize_container(ext: str | None) -> str | None:
    """Canonical container token for a file extension (``m4v`` → ``mp4``)."""
    if not ext:
        return None
    token = ext.strip().lower().lstrip(".")
    return _CONTAINER_BY_EXT.get(token, token or None)


def normalize_video_codec(codec: str | None) -> str | None:
    return _normalize_token(codec, _VIDEO_CODEC_ALIASES)


def normalize_audio_codec(codec: str | None) -> str | None:
    return _normalize_token(codec, _AUDIO_CODEC_ALIASES)


@dataclass(frozen=True)
class CapabilityProfile:
    """A client's declared playback capabilities (plan 1 §6.1).

    Codecs/containers are normalized on construction so membership tests match
    the source's normalized tokens regardless of how the client spelled them.
    """

    containers: frozenset[str] = field(default_factory=frozenset)
    video_codecs: frozenset[str] = field(default_factory=frozenset)
    # Discriminating codec tags the client confirmed it can play *directly*,
    # parsed out of the same wire list as ``video_codecs``. Kept separate because
    # normalization deliberately folds ``hvc1``/``hev1`` into ``hevc``, which is
    # right for the family test and fatal for the tag test.
    video_codec_tags: frozenset[str] = field(default_factory=frozenset)
    # Depth tokens (``hevc10``, ``h26410``, …) the client confirmed, parsed out
    # of the same wire list. Separate from the family set for the same reason
    # the tags are: a client that plays 8-bit HEVC and one that also plays
    # 10-bit both advertise ``hevc``.
    video_high_depth: frozenset[str] = field(default_factory=frozenset)
    audio_codecs: frozenset[str] = field(default_factory=frozenset)
    max_height: int | None = None
    native_hls: bool = False

    @classmethod
    def build(
        cls,
        *,
        containers: Iterable[str] | None = None,
        video_codecs: Iterable[str] | None = None,
        audio_codecs: Iterable[str] | None = None,
        max_height: int | None = None,
        native_hls: bool = False,
    ) -> CapabilityProfile:
        return cls(
            containers=frozenset(
                t for c in (containers or []) if (t := normalize_container(c)) is not None
            ),
            video_codecs=frozenset(
                t for c in (video_codecs or []) if (t := normalize_video_codec(c)) is not None
            ),
            # Tag entries also normalize into the family set above, so a client
            # that advertises only "hvc1" still reports HEVC support.
            video_codec_tags=frozenset(
                t
                for c in (video_codecs or [])
                if (t := normalize_codec_tag(c)) is not None and t in _ALL_DISCRIMINATING_TAGS
            ),
            video_high_depth=frozenset(
                t
                for c in (video_codecs or [])
                if (t := (c or "").strip().lower()) in _ALL_HIGH_DEPTH_TOKENS
            ),
            audio_codecs=frozenset(
                t for c in (audio_codecs or []) if (t := normalize_audio_codec(c)) is not None
            ),
            max_height=max_height,
            native_hls=native_hls,
        )


Method = Literal["direct", "remux", "transcode"]


@dataclass(frozen=True)
class PlaybackDecision:
    """The chosen delivery method plus a human-readable reason."""

    method: Method
    reason: str

    @property
    def session_kind(self) -> Literal["remux", "transcode"]:
        """The HLS session kind for a non-direct method.

        A ``direct``-playable source that is nonetheless forced through HLS
        (e.g. a client with no progressive path) is a pure copy → remux.
        """
        return "transcode" if self.method == "transcode" else "remux"


def default_audio_stream_index(audio_streams: list[dict[str, Any]]) -> int | None:
    """Absolute stream index of the source's default audio track.

    The default-flagged stream, else the first audio stream, else ``None``.
    Used to tell a track *switch* (which precludes direct play) from a no-op.
    """
    if not audio_streams:
        return None
    for stream in audio_streams:
        if stream.get("default") and isinstance(stream.get("index"), int):
            return int(stream["index"])
    first = audio_streams[0].get("index")
    return int(first) if isinstance(first, int) else None


def effective_max_height(cap_height: int | None, requested: int | None) -> int | None:
    """The tightest positive height cap between the client caps and the request."""
    heights = [h for h in (cap_height, requested) if h is not None and h > 0]
    return min(heights) if heights else None


def decide_playback(
    caps: CapabilityProfile,
    *,
    ext: str | None,
    video_codec: str | None,
    audio_codec: str | None,
    video_codec_tag: str | None = None,
    source_height: int | None = None,
    bit_depth: int | None = None,
    hdr: str | None = None,
    audio_stream_index: int | None = None,
    default_audio_index: int | None = None,
    burn_subtitle: bool = False,
    requested_max_height: int | None = None,
) -> PlaybackDecision:
    """Decide how to deliver a source to a client (plan 1 §6.1).

    - both container and codecs in caps → ``direct``;
    - codecs in caps but container not (the MKV-with-H.264 class) → ``remux``;
    - otherwise → ``transcode``.

    Burn-in subtitles, downscaling, a colour depth the client did not confirm,
    and Dolby Vision force ``transcode`` — each needs the video re-encoded, not
    just rewrapped. A non-default audio track, an unsupported audio codec, or a
    codec *tag* the client did not confirm force at least ``remux`` (progressive
    streams can't switch/replace tracks, and a tag is fixed by copying, not
    re-encoding). Missing probe metadata degrades toward the more permissive
    choice rather than erroring.
    """
    container = normalize_container(ext)
    vcodec = normalize_video_codec(video_codec)
    acodec = normalize_audio_codec(audio_codec)

    container_ok = container is not None and container in caps.containers
    # Unknown codec → optimistic (matches assess_playability); a reprobe corrects
    # a legacy row, and remux/transcode still carry a working audio fallback.
    video_ok = vcodec is None or vcodec in caps.video_codecs
    audio_ok = acodec is None or acodec in caps.audio_codecs
    max_h = effective_max_height(caps.max_height, requested_max_height)
    too_tall = source_height is not None and max_h is not None and source_height > max_h
    non_default_audio = audio_stream_index is not None and audio_stream_index != default_audio_index
    # A discriminating tag the client did not confirm blocks *direct* play only.
    # The coded video is fine — just labelled in a way the engine refuses — so
    # this is a remux (copy + relabel), never a re-encode. Legacy rows probed
    # before the tag was recorded have ``tag is None`` and keep their old
    # behaviour until a reprobe fills it in.
    tag = normalize_codec_tag(video_codec_tag)
    discriminating = _TAG_SENSITIVE_CODECS.get(vcodec or "", frozenset())
    tag_ok = tag is None or tag not in discriminating or tag in caps.video_codec_tags
    # An unprobed row has no depth, and an unknown codec has no token to ask
    # for: both stay optimistic, like every other missing-metadata case here.
    depth_token = _HIGH_DEPTH_TOKEN_BY_CODEC.get(vcodec or "")
    depth_ok = (
        bit_depth is None
        or bit_depth <= 8
        or depth_token is None
        or depth_token in caps.video_high_depth
    )
    # Dolby Vision's base layer is HEVC, so the family and tag tests both pass
    # while the enhancement-layer signalling makes a non-DV engine refuse the
    # source outright. Nothing about that is fixable by rewrapping.
    dolby_vision = (hdr or "").strip().lower() == "dv" or tag in {"dvh1", "dvhe"}

    if burn_subtitle:
        return PlaybackDecision("transcode", "Subtitle burn-in requires transcoding")
    if not video_ok:
        return PlaybackDecision("transcode", f"{vcodec} video codec is not in client capabilities")
    if dolby_vision:
        return PlaybackDecision("transcode", "Dolby Vision is not playable without transcoding")
    if not depth_ok:
        return PlaybackDecision(
            "transcode", f"{bit_depth}-bit {vcodec} is not in client capabilities"
        )
    if too_tall:
        return PlaybackDecision(
            "transcode", f"Source height {source_height} exceeds the client height cap"
        )
    if not tag_ok:
        return PlaybackDecision(
            "remux", f"{tag} codec tag is not in client capabilities (copy and relabel)"
        )
    if not container_ok:
        label = container or "unknown"
        return PlaybackDecision("remux", f"{label} container is not in client capabilities")
    if not audio_ok:
        return PlaybackDecision("remux", f"{acodec} audio codec is not in client capabilities")
    if non_default_audio:
        return PlaybackDecision("remux", "Switching to a non-default audio track requires remux")
    return PlaybackDecision("direct", "Source container and codecs are directly playable")


# Persist vanished linked paths without attempting moved-file repair
def reconcile_missing_files(session: Session, asset_files: Iterable[AssetFile]) -> int:
    """Mark available files missing after bounded on-access path checks."""
    root = library_root_for_session(session)
    changed = 0
    for asset_file in asset_files:
        if asset_file.availability != FileAvailability.AVAILABLE:
            continue
        if Path(resolve_within_root(root, asset_file.relative_path)).is_file():
            continue
        asset_file.availability = FileAvailability.MISSING
        changed += 1
    if changed:
        session.flush()
    return changed


def resolve_file_path(session: Session, file_id: str) -> tuple[Path, AssetFile]:
    """Path-safe absolute path of an available AssetFile, for serving.

    Re-validates existence at access time: if the file has vanished since the
    last scan, the row is marked ``missing`` and a clear error is raised.
    Automatic repair is left to scan/rescan (AGENTS.md §5.3)."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.availability != FileAvailability.AVAILABLE:
        raise NotFoundError("file is missing on disk")
    if reconcile_missing_files(session, [asset_file]):
        raise NotFoundError("file is missing on disk")
    path = Path(resolve_within_root(library_root_for_session(session), asset_file.relative_path))
    return path, asset_file


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


def vtt_cache_path(library_root: Path, track_id: str) -> Path:
    """Cached WebVTT location under the library's portable
    ``.cairndex/cache/subtitles/`` (ADR-0008 phase 8)."""
    return library_package.cache_dir(library_root) / "subtitles" / track_id[:2] / f"{track_id}.vtt"


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

    library_root = library_root_for_session(session)
    dest = vtt_cache_path(library_root, track.id)
    if dest.exists() and not force:
        return dest

    abs_path = Path(resolve_within_root(library_root, source.relative_path))
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
