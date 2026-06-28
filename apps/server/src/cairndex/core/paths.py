"""Library-root path safety.

Every file location in Cairndex is stored as a library-root-relative path and
never as a client-supplied absolute path (AGENTS.md §5, §10, §12; ADR-0008).
This module is the single choke point that:

- normalizes a client-supplied relative path to a clean POSIX form, and
- resolves it against a library root while guaranteeing the result stays inside
  that root — rejecting absolute paths, parent-directory traversal, and symlink
  escapes.

Callers must route *all* externally-influenced paths through here. Relative
paths are stored in their normalized form so the ``relative_path`` uniqueness
constraint behaves consistently.
"""

from pathlib import Path, PurePosixPath


class PathSafetyError(ValueError):
    """Raised when a path is unsafe or escapes its storage root."""


def normalize_relative_path(raw: str) -> str:
    """Return a clean POSIX relative path, or raise ``PathSafetyError``.

    The result has forward slashes, no leading slash, and no ``.`` or ``..``
    segments. Anything absolute (POSIX, Windows drive, or UNC), upward-
    traversing, empty, or containing a NUL byte is rejected.
    """
    if not raw or not raw.strip():
        raise PathSafetyError("empty path")
    if "\x00" in raw:
        raise PathSafetyError("null byte in path")
    # Reject obvious absolute forms up front: POSIX root, Windows drive (C:\),
    # and UNC/backslash-rooted paths.
    if raw[0] in ("/", "\\"):
        raise PathSafetyError("absolute path is not allowed")
    if len(raw) >= 2 and raw[1] == ":":
        raise PathSafetyError("absolute path is not allowed")

    pure = PurePosixPath(raw)
    if pure.is_absolute():
        raise PathSafetyError("absolute path is not allowed")

    parts: list[str] = []
    for part in pure.parts:
        if part == ".":
            continue
        if part == "..":
            raise PathSafetyError("parent-directory traversal is not allowed")
        parts.append(part)

    if not parts:
        raise PathSafetyError("path is empty after normalization")
    return PurePosixPath(*parts).as_posix()


def resolve_within_root(canonical_root: str | Path, relative_path: str) -> Path:
    """Resolve ``relative_path`` to an absolute path contained in the root.

    The relative path is normalized first. The result is the fully resolved
    (symlinks followed) absolute path; if resolving it lands outside the root's
    real location — via ``..`` or a symlink — ``PathSafetyError`` is raised.

    Note: this validates at call time. For TOCTOU-sensitive operations (e.g.
    serving file bytes later), re-validate at access time.
    """
    normalized = normalize_relative_path(relative_path)
    root = Path(canonical_root).resolve(strict=False)
    candidate = (root / normalized).resolve(strict=False)
    if not candidate.is_relative_to(root):
        raise PathSafetyError("path escapes the storage root")
    return candidate
