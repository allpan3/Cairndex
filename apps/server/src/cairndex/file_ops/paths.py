"""Path and name validation for guarded write operations (ADR-0013 §3.3).

``core.paths`` already guarantees that a client-supplied relative path stays
inside the library root, and every read surface funnels through it. Writing
needs three more guarantees that reading never did:

1. **The library package is off limits.** ``.cairndex/`` holds the manifest, the
   library DB, and the derived cache. A rename that lands inside it — or drags a
   file out of it — would corrupt the library through an ordinary-looking file
   operation, so both source and destination are refused there.
2. **A destination that does not exist yet must still be validated.** Reads
   resolve paths that are already there; a write's target is by definition
   absent, and ``..``/symlink containment has to hold for it anyway.
3. **A name is not a path.** Rename and New Folder take a single filename, and
   the safest thing to do with a separator, a dot-name, or a trailing space in
   that position is refuse it rather than interpret it.
"""

from pathlib import Path, PurePosixPath

from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.registry.library_package import MARKER_DIR

# Names the filesystem, the shell, or Finder/Explorer will misread. Refused
# rather than sanitized: silently changing what someone typed is worse than
# telling them it will not work.
_MAX_NAME_BYTES = 255


def validate_name(raw: str) -> str:
    """Return ``raw`` as a usable single filename, or raise ``PathSafetyError``.

    Rejects separators, ``.``/``..``, control characters, and names that a
    round trip through a network share or a Windows client would mangle
    (trailing dot or space). Leading dots are rejected too: File Browser hides
    dotfiles, so creating one would look exactly like the operation failing.
    """
    name = raw.strip()
    if not name:
        raise PathSafetyError("name is empty")
    if "\x00" in name:
        raise PathSafetyError("null byte in name")
    if "/" in name or "\\" in name:
        raise PathSafetyError("a name cannot contain a path separator")
    if name in {".", ".."}:
        raise PathSafetyError("that name is reserved")
    if name.startswith("."):
        raise PathSafetyError("names starting with a dot are hidden and not allowed")
    if any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise PathSafetyError("name contains a control character")
    # Surrounding whitespace is trimmed above — an accidental trailing space in
    # a rename box is not worth an error. A trailing *dot* is different: it
    # survives on POSIX but is silently dropped by Windows and some SMB servers,
    # so the same file would answer to two names that disagree.
    if name != name.rstrip("."):
        raise PathSafetyError("a name cannot end with a dot")
    if len(name.encode("utf-8")) > _MAX_NAME_BYTES:
        raise PathSafetyError("name is too long")
    return name


def is_inside_package(relative_path: str) -> bool:
    """Whether a normalized relative path is the library package or inside it."""
    parts = PurePosixPath(relative_path).parts
    return bool(parts) and parts[0] == MARKER_DIR


def resolve_writable(root: Path, relative_path: str, *, what: str = "path") -> Path:
    """Resolve a relative path for a write, containment- and package-checked.

    Works for a destination that does not exist yet (``resolve_within_root``
    resolves non-strictly), and refuses anything at or under ``.cairndex/`` from
    either direction — by its stated path *and* by where it really resolves, so
    a symlink pointing into the package is caught too.
    """
    normalized = normalize_relative_path(relative_path)
    if is_inside_package(normalized):
        raise PathSafetyError(f"{what} is inside the library's .cairndex folder")
    resolved = resolve_within_root(root, normalized)
    package = (Path(root).resolve(strict=False) / MARKER_DIR).resolve(strict=False)
    if resolved == package or resolved.is_relative_to(package):
        raise PathSafetyError(f"{what} is inside the library's .cairndex folder")
    return resolved


def parent_of(relative_path: str) -> str:
    """The parent directory of a normalized relative path ("" for a top-level entry)."""
    return normalize_relative_path(relative_path).rpartition("/")[0]


def join_relative(parent: str, name: str) -> str:
    """Join a (possibly empty) parent directory and a validated name."""
    return f"{parent}/{name}" if parent else name


def suffixed_name(name: str, attempt: int) -> str:
    """``report.txt`` → ``report (2).txt`` — the "Keep both" naming (ADR-0013 §3.3).

    Finder's convention rather than a numeric suffix on the whole name, because
    the extension has to stay last for the file to keep opening in the same app.
    Compound extensions are deliberately not special-cased: ``.tar.gz`` becomes
    ``archive.tar (2).gz``, which is ugly but still opens, whereas guessing at
    multi-part extensions misfires on ordinary names containing dots.
    """
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem:  # no extension, or a dotfile-shaped name
        return f"{name} ({attempt})"
    return f"{stem} ({attempt}).{extension}"
