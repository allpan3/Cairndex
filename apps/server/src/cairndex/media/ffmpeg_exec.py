"""Shared ffmpeg subprocess helpers for derived-media generation."""

import shutil
import subprocess


# ffmpeg could not complete a requested media derivative
class FfmpegError(RuntimeError):
    """ffmpeg was unavailable, timed out, or failed."""


# Resolve ffmpeg from PATH for media jobs
def ffmpeg_exe() -> str:
    """Resolve ffmpeg from PATH."""
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise FfmpegError("ffmpeg not found on PATH")
    return exe


# Run ffmpeg with captured stderr and a bounded timeout
def run_ffmpeg(args: list[str], *, timeout: float = 60.0, stderr_limit: int = 300) -> None:
    """Run ffmpeg with captured stderr and a bounded timeout."""
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError("ffmpeg timed out") from exc
    if proc.returncode != 0:
        raise FfmpegError(proc.stderr.decode(errors="replace")[:stderr_limit])
