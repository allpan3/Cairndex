"""Shared ffmpeg subprocess helpers for derived-media generation."""

import subprocess

from cairndex.media.tool_paths import ffmpeg_path


# ffmpeg could not complete a requested media derivative
class FfmpegError(RuntimeError):
    """ffmpeg was unavailable, timed out, or failed."""


# Resolve ffmpeg for media jobs (configured path, then PATH, then known prefixes)
def ffmpeg_exe() -> str:
    """Resolve the ffmpeg binary. See ``media/tool_paths.py`` for the order."""
    exe = ffmpeg_path()
    if exe is None:
        raise FfmpegError("ffmpeg not found")
    return exe


# Run ffmpeg with captured stderr and a bounded timeout
def run_ffmpeg(args: list[str], *, timeout: float = 60.0, stderr_limit: int = 300) -> str:
    """Run ffmpeg with captured stderr and a bounded timeout."""
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError("ffmpeg timed out") from exc
    stderr = proc.stderr.decode(errors="replace")
    if proc.returncode != 0:
        raise FfmpegError(stderr[:stderr_limit])
    return stderr
