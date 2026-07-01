"""Read-only File View: library-scoped filesystem browsing.

The File View is the *physical* browsing surface (distinct from the logical,
bundle-first Collection View). It lists real directories and files under a
library's root directory, identified by a root-relative path — it never accepts
or exposes an absolute server path, and never moves, renames, deletes, or
rewrites anything on disk (ADR-0008: the library root comes from the registry).

This first milestone is strictly read-only. It is structured so later write-mode
operations (open-with-default-app, reveal, guarded rename/move/delete — see
``docs/adr/0007`` and Phase 7) can be layered on without a rewrite: all path
resolution already funnels through ``core.paths``.
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
from cairndex.domain.enums import GroupingSource, GroupingState
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.media_types import classify, is_hidden_relative_path

# Non-dotfile names we still hide: caches, OS/DB cruft, thumbnails. Dotfiles and
# dot-directories (e.g. .git, .DS_Store, .env, the .cairndex marker) are hidden
# by the leading-dot rule below, so this list only needs the non-dot offenders.
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
    # True when linked into a scan-staged *provisional* bundle — i.e. the file is
    # known but not yet in a confirmed bundle ("unbundled"). False for unlinked
    # files and for files already in a confirmed bundle.
    unbundled: bool


@dataclass(frozen=True)
class _Link:
    """A path's bundle membership, for the File View linked/unbundled badges."""

    bundle_id: str
    unbundled: bool  # in a provisional/scan_suggestion bundle (not yet confirmed)


@dataclass(frozen=True)
class FileViewListing:
    # The relative directory being listed ("" = the library root itself).
    path: str
    entries: list[FileViewEntry]


def list_entries(session: Session, *, path: str | None = None) -> FileViewListing:
    """List non-hidden directories and files directly under ``path`` in the library.

    ``path`` is a library-root-relative POSIX path (``None``/empty = the root).
    Directories are returned first, then files, each sorted case-insensitively.
    Raises ``ValidationError`` for unsafe paths or a non-directory target, and
    ``NotFoundError`` when the library root is unavailable or the path is absent.
    """
    root_path = library_root_for_session(session)
    if not root_path.is_dir():
        raise NotFoundError("the library root is not currently available")

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
        raise NotFoundError(f"path {rel_norm!r} does not exist in this library")
    if not target.is_dir():
        raise ValidationError(f"path {rel_norm!r} is not a directory")

    root_real = root_path.resolve(strict=False)
    dirs: list[FileViewEntry] = []
    files: list[FileViewEntry] = []
    linked = _linked_paths(session, rel_norm)

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
    return FileViewListing(path=rel_norm, entries=[*dirs, *files])


@dataclass(frozen=True)
class UnbundledFilesPage:
    items: list[FileViewEntry]
    total: int
    offset: int
    limit: int


def list_unbundled_files(
    session: Session, *, offset: int = 0, limit: int = 100
) -> UnbundledFilesPage:
    """A flat, cross-library page of *unbundled* files — those linked into a
    scan-staged provisional bundle and not yet confirmed (the "to-bundle queue").

    A cheap DB query (no filesystem walk): entries are built from the stored
    ``AssetFile`` rows, shaped like File View entries so one file row renders both
    the tree and this list. Ordered by path for stable pagination.
    """
    unbundled = (AssetBundle.grouping_state == GroupingState.PROVISIONAL) & (
        AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION
    )
    base = (
        select(AssetFile.relative_path, AssetFile.bundle_id, AssetFile.size_bytes, AssetFile.mtime)
        .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
        .where(unbundled)
    )
    rows = [r for r in session.execute(base).all() if not is_hidden_relative_path(r[0])]
    rows.sort(key=lambda r: r[0].lower())
    total = len(rows)
    items = [_unbundled_entry(*r) for r in rows[offset : offset + limit]]
    return UnbundledFilesPage(items=items, total=total, offset=offset, limit=limit)


def _unbundled_entry(
    relative_path: str, bundle_id: str, size_bytes: int | None, mtime: datetime | None
) -> FileViewEntry:
    name = relative_path.rsplit("/", 1)[-1]
    _, _, ext = name.rpartition(".")
    extension = ext.lower() if ext and ext != name else None
    classification = classify(name)
    return FileViewEntry(
        name=name,
        relative_path=relative_path,
        kind="file",
        size_bytes=size_bytes,
        modified_at=mtime,
        extension=extension,
        mime_type=mimetypes.guess_type(name)[0],
        media_kind=str(classification[0]) if classification else None,
        supported=classification is not None,
        linked=True,
        bundle_id=bundle_id,
        unbundled=True,
    )


def resolve_entry_path(session: Session, path: str) -> Path:
    """Resolve a library-relative file path to a safe absolute path for serving.

    Mirrors ``list_entries`` safety: rejects absolute paths, traversal, and
    symlink escapes, and confirms the target is an existing regular file (not a
    directory). Used by the read-only content endpoint so the File View can
    preview/play a file that is not linked into any bundle. Raises
    ``ValidationError`` for unsafe/non-file paths and ``NotFoundError`` when the
    library root is unavailable or the file does not exist.
    """
    root_path = library_root_for_session(session)
    if not root_path.is_dir():
        raise NotFoundError("the library root is not currently available")

    rel = (path or "").strip()
    if not rel:
        raise ValidationError("a file path is required")
    try:
        target = resolve_within_root(root_path, rel)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc

    rel_norm = normalize_relative_path(rel)
    if not target.exists():
        raise NotFoundError(f"path {rel_norm!r} does not exist in this library")
    if not target.is_file():
        raise ValidationError(f"path {rel_norm!r} is not a file")
    return target


def _build_entry(
    dirent: os.DirEntry[str],
    parent_rel: str,
    root_real: Path,
    linked: dict[str, _Link],
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
            unbundled=False,
        )

    _, _, ext = name.rpartition(".")
    extension = ext.lower() if ext and ext != name else None
    classification = classify(name)
    link = linked.get(child_rel)
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
        linked=link is not None,
        bundle_id=link.bundle_id if link is not None else None,
        unbundled=link.unbundled if link is not None else False,
    )


def _linked_paths(session: Session, parent_rel: str) -> dict[str, _Link]:
    """Map ``relative_path -> _Link`` for files already linked directly under
    ``parent_rel`` in this library, so listed entries can show the linked/
    unbundled badges without a per-file query. Joins the owning bundle to know
    whether the grouping is still provisional (scan-staged) or confirmed."""
    prefix = f"{parent_rel}/" if parent_rel else ""
    stmt = select(
        AssetFile.relative_path,
        AssetFile.bundle_id,
        AssetBundle.grouping_state,
        AssetBundle.grouping_source,
    ).join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
    if prefix:
        stmt = stmt.where(AssetFile.relative_path.startswith(prefix))
    out: dict[str, _Link] = {}
    for rel_path, bundle_id, grouping_state, grouping_source in session.execute(stmt):
        remainder = rel_path[len(prefix) :]
        if "/" not in remainder:  # direct child, not nested nested
            unbundled = (
                grouping_state is GroupingState.PROVISIONAL
                and grouping_source is GroupingSource.SCAN_SUGGESTION
            )
            out[rel_path] = _Link(bundle_id=bundle_id, unbundled=unbundled)
    return out
