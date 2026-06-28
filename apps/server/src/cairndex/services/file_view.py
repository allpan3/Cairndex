"""Read-only File View: storage-root-scoped filesystem browsing.

The File View is the *physical* browsing surface (distinct from the logical,
bundle-first Collection View). It lists real directories and files under a
configured storage root, identified by ``storage_root_id + relative_path`` — it
never accepts or exposes an absolute server path, and never moves, renames,
deletes, or rewrites anything on disk.

This first milestone is strictly read-only. It is structured so later write-mode
operations (open-with-default-app, reveal, guarded rename/move/delete — see
``docs/adr/0006`` and Phase 7) can be layered on without a rewrite: all path
resolution already funnels through ``core.paths`` and the storage-root allowlist.
"""

from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.persistence.models import AssetFile
from cairndex.scanning.media_types import classify
from cairndex.services.storage_roots import get_storage_root

# Non-dotfile names we still hide: caches, OS/DB cruft, thumbnails. Dotfiles and
# dot-directories (e.g. .git, .DS_Store, .env) are hidden by the leading-dot
# rule below, so this list only needs the non-dot offenders.
_HIDDEN_NAMES: frozenset[str] = frozenset(
    {
        "__pycache__",
        "node_modules",
        "Thumbs.db",
        ".DS_Store",  # belt-and-suspenders; already a dotfile
    }
)


def _is_hidden(name: str) -> bool:
    return name.startswith(".") or name in _HIDDEN_NAMES


@dataclass(frozen=True)
class FileViewEntry:
    name: str
    relative_path: str
    # "directory" or "file" — the filesystem entry kind, not a media kind.
    kind: str
    size_bytes: int | None
    modified_at: datetime | None
    extension: str | None
    mime_type: str | None
    # The app's media classification (video/image/subtitle/audio) or None.
    media_kind: str | None
    # True when the app can natively preview/play this file (supported/openable).
    supported: bool
    # Cheap "already linked into a bundle" hint for this exact path.
    linked: bool
    bundle_id: str | None


@dataclass(frozen=True)
class FileViewListing:
    root_id: str
    # The relative directory being listed ("" = the storage root itself).
    path: str
    entries: list[FileViewEntry]


def list_entries(session: Session, root_id: str, *, path: str | None = None) -> FileViewListing:
    """List non-hidden directories and files directly under ``path`` in a root.

    ``path`` is a root-relative POSIX path (``None``/empty = the root itself).
    Directories are returned first, then files, each sorted case-insensitively.
    Raises ``ValidationError`` for unsafe paths or a non-directory target, and
    ``NotFoundError`` when the root is unavailable or the path does not exist.
    """
    root = get_storage_root(session, root_id)
    root_path = Path(root.canonical_path)
    if not root_path.is_dir():
        raise NotFoundError(f"storage root {root_id!r} is not currently available")

    rel = (path or "").strip()
    if not rel:
        target = root_path.resolve(strict=False)
        rel_norm = ""
    else:
        try:
            target = resolve_within_root(root_path, rel)
        except PathSafetyError as exc:
            raise ValidationError(str(exc)) from exc
        rel_norm = normalize_relative_path(rel)

    if not target.exists():
        raise NotFoundError(f"path {rel_norm!r} does not exist in storage root {root_id!r}")
    if not target.is_dir():
        raise ValidationError(f"path {rel_norm!r} is not a directory")

    root_real = root_path.resolve(strict=False)
    dirs: list[FileViewEntry] = []
    files: list[FileViewEntry] = []
    linked = _linked_paths(session, root_id, rel_norm)

    with os.scandir(target) as it:
        for dirent in it:
            if _is_hidden(dirent.name):
                continue
            entry = _build_entry(dirent, rel_norm, root_real, linked)
            if entry is None:
                continue  # symlink escaping the root, or vanished mid-scan
            (dirs if entry.kind == "directory" else files).append(entry)

    dirs.sort(key=lambda e: e.name.lower())
    files.sort(key=lambda e: e.name.lower())
    return FileViewListing(root_id=root_id, path=rel_norm, entries=[*dirs, *files])


def resolve_entry_path(session: Session, root_id: str, path: str) -> Path:
    """Resolve a root-relative file path to a safe absolute path for serving.

    Mirrors ``list_entries`` safety: rejects absolute paths, traversal, and
    symlink escapes, and confirms the target is an existing regular file (not a
    directory). Used by the read-only content endpoint so the File View can
    preview/play a file that is not linked into any bundle. Raises
    ``ValidationError`` for unsafe/non-file paths and ``NotFoundError`` when the
    root is unavailable or the file does not exist.
    """
    root = get_storage_root(session, root_id)
    root_path = Path(root.canonical_path)
    if not root_path.is_dir():
        raise NotFoundError(f"storage root {root_id!r} is not currently available")

    rel = (path or "").strip()
    if not rel:
        raise ValidationError("a file path is required")
    try:
        target = resolve_within_root(root_path, rel)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc

    rel_norm = normalize_relative_path(rel)
    if not target.exists():
        raise NotFoundError(f"path {rel_norm!r} does not exist in storage root {root_id!r}")
    if not target.is_file():
        raise ValidationError(f"path {rel_norm!r} is not a file")
    return target


def _build_entry(
    dirent: os.DirEntry[str],
    parent_rel: str,
    root_real: Path,
    linked: dict[str, str],
) -> FileViewEntry | None:
    # Reject symlinks (and any entry) whose real location escapes the root.
    try:
        real = Path(dirent.path).resolve(strict=False)
        if not real.is_relative_to(root_real):
            return None
        is_dir = dirent.is_dir()
        stat = dirent.stat()
    except OSError:
        return None

    name = dirent.name
    child_rel = f"{parent_rel}/{name}" if parent_rel else name
    modified = datetime.fromtimestamp(stat.st_mtime, UTC)

    if is_dir:
        return FileViewEntry(
            name=name,
            relative_path=child_rel,
            kind="directory",
            size_bytes=None,
            modified_at=modified,
            extension=None,
            mime_type=None,
            media_kind=None,
            supported=False,
            linked=False,
            bundle_id=None,
        )

    _, _, ext = name.rpartition(".")
    extension = ext.lower() if ext and ext != name else None
    classification = classify(name)
    bundle_id = linked.get(child_rel)
    return FileViewEntry(
        name=name,
        relative_path=child_rel,
        kind="file",
        size_bytes=stat.st_size,
        modified_at=modified,
        extension=extension,
        mime_type=mimetypes.guess_type(name)[0],
        media_kind=str(classification[0]) if classification else None,
        supported=classification is not None,
        linked=bundle_id is not None,
        bundle_id=bundle_id,
    )


def _linked_paths(session: Session, root_id: str, parent_rel: str) -> dict[str, str]:
    """Map ``relative_path -> bundle_id`` for files already linked under
    ``parent_rel`` in this root, so listed entries can show a linked badge
    without a per-file query."""
    prefix = f"{parent_rel}/" if parent_rel else ""
    stmt = select(AssetFile.relative_path, AssetFile.bundle_id).where(
        AssetFile.storage_root_id == root_id
    )
    if prefix:
        stmt = stmt.where(AssetFile.relative_path.startswith(prefix))
    # Only direct children of parent_rel matter for this listing.
    out: dict[str, str] = {}
    for rel_path, bundle_id in session.execute(stmt):
        remainder = rel_path[len(prefix) :]
        if "/" not in remainder:  # direct child, not nested nested
            out[rel_path] = bundle_id
    return out
