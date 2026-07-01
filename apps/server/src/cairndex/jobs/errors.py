"""Sanitize handler exceptions before they are stored on a job row.

Job errors are surfaced in the UI, so they must not leak private filenames or
absolute server paths (AGENTS.md security/privacy rules). We keep the exception
type and message (useful for diagnosis) but redact the library root and any
absolute paths, since those reveal the owner's directory layout and file names.
"""

import re
from pathlib import Path

# Matches POSIX absolute paths (``/srv/media/Movie (2021)/part1.mkv``) and
# Windows drive paths (``C:\Media\...``). Conservative: only spans of
# path-ish characters, so ordinary prose in a message is left intact.
_ABS_PATH = re.compile(r"(?:[A-Za-z]:\\|/)[^\s'\"]+")

_REDACTED = "<path>"


def safe_error_message(exc: BaseException, *, library_root: Path | None = None) -> str:
    """Return ``"<ExcType>: <redacted message>"`` safe to store/display.

    The library root is redacted first (so even a partial leak is caught), then
    any remaining absolute path is replaced with a placeholder.
    """
    message = str(exc).strip()
    if library_root is not None:
        message = message.replace(str(library_root), "<library>")
    message = _ABS_PATH.sub(_REDACTED, message)
    type_name = type(exc).__name__
    return f"{type_name}: {message}" if message else type_name
