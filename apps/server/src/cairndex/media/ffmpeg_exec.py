"""Shared ffmpeg subprocess helpers for derived-media generation."""

import subprocess

from cairndex.core.abort import OperationAborted, aborted
from cairndex.media.tool_paths import ffmpeg_path

# How often a running ffmpeg is checked against the abort signal. Short enough
# that stopping feels immediate, cheap enough to ignore: the check is one
# boolean call, and on the job path a registry read behind its own throttle.
_ABORT_POLL_INTERVAL = 0.25


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


# Run ffmpeg with captured stderr, a bounded timeout, and abort support
def run_ffmpeg(args: list[str], *, timeout: float = 60.0, stderr_limit: int = 300) -> str:
    """Run ffmpeg with captured stderr and a bounded timeout.

    Waits in short slices rather than one blocking call, so an abort raised
    while ffmpeg is working (``core/abort``) stops the process instead of being
    noticed a whole file later. With no abort scope in effect this behaves
    exactly as the single blocking wait it replaced: same deadline, same stderr,
    same errors.
    """
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        raise FfmpegError(str(exc)) from exc

    remaining = timeout
    while True:
        try:
            _, stderr_bytes = proc.communicate(timeout=min(_ABORT_POLL_INTERVAL, remaining))
            break
        except subprocess.TimeoutExpired:
            remaining -= _ABORT_POLL_INTERVAL
            if aborted():
                _stop(proc)
                raise OperationAborted("ffmpeg stopped") from None
            if remaining <= 0:
                _stop(proc)
                raise FfmpegError("ffmpeg timed out") from None

    stderr = stderr_bytes.decode(errors="replace")
    if proc.returncode != 0:
        raise FfmpegError(stderr[:stderr_limit])
    return stderr


# Stop a running ffmpeg and reap it, escalating if it ignores the first ask
def _stop(proc: "subprocess.Popen[bytes]") -> None:
    proc.terminate()
    try:
        proc.communicate(timeout=5.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
