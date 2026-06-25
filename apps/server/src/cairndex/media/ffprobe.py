"""Thin ffprobe adapter: run ffprobe and normalize its JSON.

Read-only — ffprobe never modifies the file. ``ffprobe`` must be on PATH;
callers should treat a missing binary or a probe failure as a recoverable,
per-file condition (the file simply stays un-probed), not a fatal error.
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class ProbeError(RuntimeError):
    """ffprobe was unavailable, timed out, or could not read the file."""


def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def ffprobe_available() -> bool:
    return ffprobe_path() is not None


def run_ffprobe(path: Path, *, timeout: float = 30.0) -> dict[str, Any]:
    """Return the raw parsed ffprobe JSON (format + streams) for ``path``."""
    exe = ffprobe_path()
    if exe is None:
        raise ProbeError("ffprobe not found on PATH")
    cmd = [
        exe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
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


def normalize_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    """Reduce ffprobe's verbose output to the fields Cairndex stores/displays."""
    fmt = raw.get("format", {})
    streams: list[dict[str, Any]] = raw.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    subtitles = [s for s in streams if s.get("codec_type") == "subtitle"]

    def _int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _float(value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    return {
        "container": fmt.get("format_name"),
        "duration": _float(fmt.get("duration")),
        "bitrate": _int(fmt.get("bit_rate")),
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "video_codec": video.get("codec_name") if video else None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "fps": _parse_fps(video.get("avg_frame_rate")) if video else None,
        "stream_count": len(streams),
        "embedded_subtitles": [
            {
                "index": s.get("index"),
                "codec": s.get("codec_name"),
                "language": (s.get("tags") or {}).get("language"),
            }
            for s in subtitles
        ],
    }
