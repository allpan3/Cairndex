"""Locating ffmpeg and ffprobe.

`PATH` alone is not enough once the server can be launched by something other
than a shell. A macOS app started from Finder inherits launchd's minimal
environment — `/usr/bin:/bin:/usr/sbin:/sbin` — which contains no Homebrew
prefix, so a desktop-spawned sidecar would fail to find an ffmpeg the user
definitely has installed (plan 3 D6).

Resolution order, most explicit first:

1. `CAIRNDEX_FFMPEG_PATH` / `CAIRNDEX_FFPROBE_PATH` — what the desktop shell sets
   when it spawns the sidecar against bundled binaries, and the escape hatch for
   an unusual install;
2. `PATH`, so a shell-launched server and a container behave exactly as before;
3. a short list of conventional install prefixes, which is what rescues the
   Finder-launched case when nothing was configured.
"""

import logging
import os
import shutil
from pathlib import Path

from cairndex.core.config import get_settings

logger = logging.getLogger(__name__)

# Checked only after PATH, so a deliberately-chosen binary always wins. These are
# the standard package-manager prefixes on macOS (Homebrew on Apple Silicon and
# Intel, MacPorts) and Linux.
_FALLBACK_PREFIXES: tuple[str, ...] = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
)


def _configured(name: str, explicit: Path | None) -> str | None:
    """Use the configured binary, or fall through to discovery.

    Falling through keeps a stale setting from disabling media work outright,
    but it is logged: the desktop shell sets these to *bundled* binaries, so a
    path that exists yet is not executable usually means a packaging bug (a lost
    execute bit), and silently using a system ffmpeg instead would hide it right
    up until a machine that has no system ffmpeg.
    """
    if explicit is None:
        return None
    candidate = Path(explicit).expanduser()
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    logger.warning("configured %s is not an executable file; falling back to discovery", name)
    return None


def _resolve(name: str, explicit: Path | None) -> str | None:
    configured = _configured(name, explicit)
    if configured is not None:
        return configured
    found = shutil.which(name)
    if found is not None:
        return found
    for prefix in _FALLBACK_PREFIXES:
        candidate = Path(prefix) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def ffmpeg_path() -> str | None:
    settings = get_settings()
    return _resolve("ffmpeg", settings.ffmpeg_path)


def ffprobe_path() -> str | None:
    settings = get_settings()
    return _resolve("ffprobe", settings.ffprobe_path)
