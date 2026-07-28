"""Thin ffprobe adapter: run ffprobe and normalize its JSON.

Read-only — ffprobe never modifies the file. The binary is located by
``media/tool_paths.py``; callers should treat a missing binary or a probe
failure as a recoverable, per-file condition (the file simply stays un-probed),
not a fatal error.
"""

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from cairndex.media.tool_paths import ffprobe_path as resolve_ffprobe

# 3 adds ``video_codec_tag``. The bump is what re-probes existing rows: a stored
# codec name alone cannot tell ``hvc1``-tagged HEVC from ``hev1``-tagged HEVC,
# and Apple engines play only the former, so without the tag the playback
# decision sends an unplayable source down the direct path (see
# ``media/playback.py``).
PROBE_VERSION = 3


class ProbeError(RuntimeError):
    """ffprobe was unavailable, timed out, or could not read the file."""


def ffprobe_path() -> str | None:
    """Resolve the ffprobe binary. See ``media/tool_paths.py`` for the order."""
    return resolve_ffprobe()


def ffprobe_available() -> bool:
    return ffprobe_path() is not None


def run_ffprobe(path: Path, *, timeout: float = 30.0) -> dict[str, Any]:
    """Return the raw parsed ffprobe JSON (format + streams) for ``path``."""
    exe = ffprobe_path()
    if exe is None:
        raise ProbeError("ffprobe not found")
    cmd = [
        exe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe timed out for {path}") from exc
    if proc.returncode != 0:
        raise ProbeError(f"ffprobe failed for {path}: {proc.stderr.decode(errors='replace')[:200]}")
    result: dict[str, Any] = json.loads(proc.stdout or b"{}")
    return result


def keyframe_times(path: Path, *, timeout: float = 60.0) -> list[float] | None:
    """Sorted video keyframe timestamps (seconds), or ``None`` on failure.

    Used to build a keyframe-accurate HLS playlist for ``-c:v copy`` remux
    sessions so advertised segment boundaries match where copy-mux can actually
    split (plan 1 §6.2 / ADR-0014). ``-skip_frame nokey`` decodes only keyframes
    so the output stays bounded even for long files. Failure (missing ffprobe,
    timeout, unreadable) returns ``None`` so callers fall back to a
    duration-derived playlist rather than erroring.
    """
    exe = ffprobe_path()
    if exe is None:
        return None
    cmd = [
        exe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_entries",
        "frame=pts_time",
        "-of",
        "csv=print_section=0",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    times: list[float] = []
    for line in proc.stdout.decode(errors="replace").splitlines():
        value = _float(line.strip().rstrip(","))
        if value is not None:
            times.append(value)
    return sorted(times) if times else None


def _parse_fps(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            denominator = float(den)
            return round(float(num) / denominator, 3) if denominator else None
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


# Coerce ffprobe number fields while treating "N/A" as absent
def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# Coerce ffprobe floating-point fields while treating "N/A" as absent
def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# Normalize ffprobe disposition flags to Python booleans
def _flag(stream: dict[str, Any], key: str) -> bool:
    return bool(_int((stream.get("disposition") or {}).get(key)) or 0)


# Extract a BCP-47-ish language tag from ffprobe stream tags
def _language(stream: dict[str, Any]) -> str | None:
    return (stream.get("tags") or {}).get("language")


# Extract a human label from ffprobe stream tags
def _title(stream: dict[str, Any]) -> str | None:
    return (stream.get("tags") or {}).get("title")


# Summarize one audio stream for future track selection
def _audio_stream(stream: dict[str, Any]) -> dict[str, Any]:
    return {
        "index": stream.get("index"),
        "codec": stream.get("codec_name"),
        "channels": _int(stream.get("channels")),
        "language": _language(stream),
        "title": _title(stream),
        "default": _flag(stream, "default"),
    }


# Preserve the legacy embedded subtitle summary consumed by SubtitleTrack sync
def _embedded_subtitle(stream: dict[str, Any]) -> dict[str, Any]:
    return {
        "index": stream.get("index"),
        "codec": stream.get("codec_name"),
        "language": _language(stream),
    }


# Summarize one subtitle stream for later player menus and decisions
def _subtitle_stream(stream: dict[str, Any]) -> dict[str, Any]:
    return {
        "index": stream.get("index"),
        "codec": stream.get("codec_name"),
        "language": _language(stream),
        "title": _title(stream),
        "default": _flag(stream, "default"),
        "forced": _flag(stream, "forced"),
    }


# Normalize ffprobe chapters to float seconds
def _chapter(chapter: dict[str, Any]) -> dict[str, Any] | None:
    start = _float(chapter.get("start_time"))
    end = _float(chapter.get("end_time"))
    if start is None or end is None:
        return None
    return {
        "start": start,
        "end": end,
        "title": (chapter.get("tags") or {}).get("title"),
    }


# Detect Dolby Vision from codec tags or side-data text
def _is_dolby_vision(video: dict[str, Any]) -> bool:
    codec_tag = str(video.get("codec_tag_string") or "").lower()
    if codec_tag in {"dvh1", "dvhe"}:
        return True
    side_data = video.get("side_data_list") or []
    return any(
        "dovi" in json.dumps(item).lower() or "dolby vision" in json.dumps(item).lower()
        for item in side_data
    )


# Classify the primary video stream's HDR signaling
def _hdr(video: dict[str, Any] | None) -> str | None:
    if video is None:
        return None
    if _is_dolby_vision(video):
        return "dv"
    transfer = str(video.get("color_transfer") or "").lower()
    if transfer == "smpte2084":
        return "hdr10"
    if transfer == "arib-std-b67":
        return "hlg"
    return None


# The container's four-character codec label, lowercased. ffprobe reports "[0][0][0][0]"
# for formats that carry no tag (MKV, WebM); that is not a label, so it becomes None.
def _codec_tag(video: dict[str, Any] | None) -> str | None:
    if video is None:
        return None
    tag = str(video.get("codec_tag_string") or "").strip().lower()
    if not tag or tag.startswith("[") or set(tag) <= {"0"}:
        return None
    return tag


# Infer bit depth from explicit raw-sample bits or pixel format
def _bit_depth(video: dict[str, Any] | None) -> int | None:
    if video is None:
        return None
    raw_bits = _int(video.get("bits_per_raw_sample"))
    if raw_bits is not None:
        return raw_bits
    pix_fmt = str(video.get("pix_fmt") or "").lower()
    if not pix_fmt or pix_fmt in {"unknown", "none"}:
        return None
    high_depth = re.search(r"(?:p|gray|gbrp)(?P<bits>10|12|14|16)(?:le|be)?$", pix_fmt)
    if high_depth:
        return int(high_depth.group("bits"))
    return 8


def normalize_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    """Reduce ffprobe's verbose output to the fields Cairndex stores/displays."""
    fmt = raw.get("format", {})
    streams: list[dict[str, Any]] = raw.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    subtitles = [s for s in streams if s.get("codec_type") == "subtitle"]
    chapters = [item for item in (_chapter(c) for c in raw.get("chapters", [])) if item is not None]

    return {
        "probe_version": PROBE_VERSION,
        "container": fmt.get("format_name"),
        "duration": _float(fmt.get("duration")),
        "bitrate": _int(fmt.get("bit_rate")),
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "video_codec": video.get("codec_name") if video else None,
        # The container's four-character codec label, kept alongside the codec
        # name because it is not cosmetic: HEVC rides as either ``hvc1`` or
        # ``hev1``, and AVFoundation refuses ``hev1`` outright.
        "video_codec_tag": _codec_tag(video),
        "audio_codec": audio.get("codec_name") if audio else None,
        "fps": _parse_fps(video.get("avg_frame_rate")) if video else None,
        "stream_count": len(streams),
        "embedded_subtitles": [_embedded_subtitle(s) for s in subtitles],
        "audio_streams": [_audio_stream(s) for s in streams if s.get("codec_type") == "audio"],
        "subtitle_streams": [_subtitle_stream(s) for s in subtitles],
        "chapters": chapters,
        "hdr": _hdr(video),
        "bit_depth": _bit_depth(video),
    }
