"""Read-only File Browser: library-scoped filesystem browsing.

The File Browser is the *physical* browsing surface (distinct from the logical,
bundle-first Bundle Browser). It lists real directories and files under a
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

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.domain.enums import GroupingSource, GroupingState
from cairndex.media import playback
from cairndex.media.image_support import is_openable_media
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetBundle, AssetFile, PlaybackProgress
from cairndex.scanning.media_types import classify, is_hidden_relative_path
from cairndex.services.playback_progress import resume_position as progress_resume_position

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
class FileBrowserEntry:
    name: str
    relative_path: str
    # "directory" or "file" — the filesystem entry kind, not a media kind.
    kind: str
    size_bytes: int | None
    modified_at: datetime | None
    # When the file was created / added to disk (birth time where the OS reports
    # it, else the inode change time). Distinct from modified_at. None for rows
    # built from the DB (unbundled list) where only mtime is stored.
    created_at: datetime | None
    extension: str | None
    mime_type: str | None
    # The app's media classification (video/image/subtitle/audio) or None.
    media_kind: str | None
    # True when the app can natively preview/play this file (supported/openable).
    supported: bool
    # Cheap "already linked into a bundle" hint for this exact path.
    linked: bool
    bundle_id: str | None
    # Linked-file metadata for direct/storyboard card hover preview. Unlinked
    # filesystem entries remain null rather than triggering per-card lookups
    file_id: str | None
    container: str | None
    video_codec: str | None
    # Container codec tag: hvc1-tagged HEVC previews directly, hev1-tagged does
    # not (see media/playback.py). Null on rows probed before v3.
    video_codec_tag: str | None
    audio_codec: str | None
    video_bitrate: int | None
    audio_bitrate: int | None
    audio_sample_rate: int | None
    duration: float | None
    resume_position: float | None
    # True when linked into a scan-staged *provisional* bundle — i.e. the file is
    # known but not yet in a confirmed bundle ("unbundled"). False for unlinked
    # files and for files already in a confirmed bundle.
    unbundled: bool


@dataclass(frozen=True)
class _Link:
    """A path's bundle membership, for the File Browser linked/unbundled badges."""

    bundle_id: str
    file_id: str
    container: str | None
    video_codec: str | None
    video_codec_tag: str | None
    audio_codec: str | None
    video_bitrate: int | None
    audio_bitrate: int | None
    audio_sample_rate: int | None
    duration: float | None
    resume_position: float | None
    unbundled: bool  # in a provisional/scan_suggestion bundle (not yet confirmed)


@dataclass(frozen=True)
class FileBrowserListing:
    # The relative directory being listed ("" = the library root itself).
    path: str
    entries: list[FileBrowserEntry]
    # Linked rows newly persisted as missing while listing this directory
    missing_files_updated: int


def list_entries(session: Session, *, path: str | None = None) -> FileBrowserListing:
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
    dirs: list[FileBrowserEntry] = []
    files: list[FileBrowserEntry] = []
    linked, linked_files = _linked_paths(session, rel_norm)
    observed_paths: set[str] = set()

    with os.scandir(target) as it:
        for dirent in it:
            child_rel = f"{rel_norm}/{dirent.name}" if rel_norm else dirent.name
            observed_paths.add(child_rel)
            if _is_hidden(dirent.name):
                continue
            entry = _build_entry(dirent, rel_norm, root_real, linked)
            if entry is None:
                continue  # symlink escaping the root, or vanished mid-scan
            (dirs if entry.kind == "directory" else files).append(entry)

    dirs.sort(key=lambda e: e.name.lower())
    files.sort(key=lambda e: e.name.lower())
    missing_files_updated = playback.reconcile_missing_files(
        session,
        (
            asset_file
            for asset_file in linked_files
            if asset_file.relative_path not in observed_paths
        ),
    )
    return FileBrowserListing(
        path=rel_norm,
        entries=[*dirs, *files],
        missing_files_updated=missing_files_updated,
    )


@dataclass(frozen=True)
class UnbundledFilesPage:
    items: list[FileBrowserEntry]
    total: int
    offset: int
    limit: int


def list_unbundled_files(
    session: Session, *, offset: int = 0, limit: int = 100
) -> UnbundledFilesPage:
    """A flat, cross-library page of *unbundled* files — those linked into a
    scan-staged provisional bundle and not yet confirmed (the "to-bundle queue").

    A cheap DB query (no filesystem walk): entries are built from the stored
    ``AssetFile`` rows, shaped like File Browser entries so one file row renders both
    the tree and this list. Ordered by path for stable pagination.
    """
    unbundled = (AssetBundle.grouping_state == GroupingState.PROVISIONAL) & (
        AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION
    )
    base = (
        select(
            AssetFile.id.label("file_id"),
            AssetFile.relative_path.label("relative_path"),
            AssetFile.bundle_id.label("bundle_id"),
            AssetFile.size_bytes.label("size_bytes"),
            AssetFile.mtime.label("mtime"),
            func.json_extract(AssetFile.tech_metadata, "$.container").label("container"),
            func.json_extract(AssetFile.tech_metadata, "$.video_codec").label("video_codec"),
            func.json_extract(AssetFile.tech_metadata, "$.video_codec_tag").label(
                "video_codec_tag"
            ),
            func.json_extract(AssetFile.tech_metadata, "$.audio_codec").label("audio_codec"),
            func.json_extract(AssetFile.tech_metadata, "$.video_bitrate").label("video_bitrate"),
            func.json_extract(AssetFile.tech_metadata, "$.audio_bitrate").label("audio_bitrate"),
            func.json_extract(AssetFile.tech_metadata, "$.audio_sample_rate").label(
                "audio_sample_rate"
            ),
            func.json_extract(AssetFile.tech_metadata, "$.duration").label("duration"),
            PlaybackProgress.position_s.label("resume_position"),
            PlaybackProgress.completed.label("progress_completed"),
        )
        .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
        .outerjoin(PlaybackProgress, PlaybackProgress.file_id == AssetFile.id)
        .where(unbundled)
    )
    rows = [
        row for row in session.execute(base).all() if not is_hidden_relative_path(row.relative_path)
    ]
    rows.sort(key=lambda row: row.relative_path.lower())
    total = len(rows)
    items = [
        _unbundled_entry(
            row.file_id,
            row.relative_path,
            row.bundle_id,
            row.size_bytes,
            row.mtime,
            row.container,
            row.video_codec,
            row.video_codec_tag,
            row.audio_codec,
            row.video_bitrate,
            row.audio_bitrate,
            row.audio_sample_rate,
            row.duration,
            progress_resume_position(row.resume_position, row.progress_completed),
        )
        for row in rows[offset : offset + limit]
    ]
    return UnbundledFilesPage(items=items, total=total, offset=offset, limit=limit)


# Shape one linked provisional row like a File Browser entry
def _unbundled_entry(
    file_id: str,
    relative_path: str,
    bundle_id: str,
    size_bytes: int | None,
    mtime: datetime | None,
    container: str | None,
    video_codec: str | None,
    video_codec_tag: str | None,
    audio_codec: str | None,
    video_bitrate: int | None,
    audio_bitrate: int | None,
    audio_sample_rate: int | None,
    duration: float | None,
    resume_position: float | None,
) -> FileBrowserEntry:
    name = relative_path.rsplit("/", 1)[-1]
    _, _, ext = name.rpartition(".")
    extension = ext.lower() if ext and ext != name else None
    classification = classify(name)
    return FileBrowserEntry(
        name=name,
        relative_path=relative_path,
        kind="file",
        size_bytes=size_bytes,
        modified_at=mtime,
        created_at=None,
        extension=extension,
        mime_type=mimetypes.guess_type(name)[0],
        media_kind=str(classification[0]) if classification else None,
        supported=is_openable_media(classification[0], relative_path) if classification else False,
        linked=True,
        bundle_id=bundle_id,
        file_id=file_id,
        container=container,
        video_codec=video_codec,
        video_codec_tag=video_codec_tag,
        audio_codec=audio_codec,
        video_bitrate=video_bitrate,
        audio_bitrate=audio_bitrate,
        audio_sample_rate=audio_sample_rate,
        duration=duration,
        resume_position=resume_position,
        unbundled=True,
    )


def resolve_entry_path(session: Session, path: str) -> Path:
    """Resolve a library-relative file path to a safe absolute path for serving.

    Mirrors ``list_entries`` safety: rejects absolute paths, traversal, and
    symlink escapes, and confirms the target is an existing regular file (not a
    directory). Used by the read-only content endpoint so the File Browser can
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
) -> FileBrowserEntry | None:
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
    # st_birthtime is the true creation time on macOS/BSD; on platforms without
    # it, fall back to the inode change time (the closest available "added").
    created = datetime.fromtimestamp(getattr(stat, "st_birthtime", stat.st_ctime), UTC)

    if is_dir:
        return FileBrowserEntry(
            name=name,
            relative_path=child_rel,
            kind="directory",
            size_bytes=None,
            modified_at=modified,
            created_at=created,
            extension=None,
            mime_type=None,
            media_kind=None,
            supported=False,
            linked=False,
            bundle_id=None,
            file_id=None,
            container=None,
            video_codec=None,
            video_codec_tag=None,
            audio_codec=None,
            video_bitrate=None,
            audio_bitrate=None,
            audio_sample_rate=None,
            duration=None,
            resume_position=None,
            unbundled=False,
        )

    _, _, ext = name.rpartition(".")
    extension = ext.lower() if ext and ext != name else None
    classification = classify(name)
    link = linked.get(child_rel)
    return FileBrowserEntry(
        name=name,
        relative_path=child_rel,
        kind="file",
        size_bytes=stat.st_size,
        modified_at=modified,
        created_at=created,
        extension=extension,
        mime_type=mimetypes.guess_type(name)[0],
        media_kind=str(classification[0]) if classification else None,
        supported=is_openable_media(classification[0], child_rel) if classification else False,
        linked=link is not None,
        bundle_id=link.bundle_id if link is not None else None,
        file_id=link.file_id if link is not None else None,
        container=link.container if link is not None else None,
        video_codec=link.video_codec if link is not None else None,
        video_codec_tag=link.video_codec_tag if link is not None else None,
        audio_codec=link.audio_codec if link is not None else None,
        video_bitrate=link.video_bitrate if link is not None else None,
        audio_bitrate=link.audio_bitrate if link is not None else None,
        audio_sample_rate=link.audio_sample_rate if link is not None else None,
        duration=link.duration if link is not None else None,
        resume_position=link.resume_position if link is not None else None,
        unbundled=link.unbundled if link is not None else False,
    )


def _linked_paths(session: Session, parent_rel: str) -> tuple[dict[str, _Link], list[AssetFile]]:
    """Map ``relative_path -> _Link`` for files already linked directly under
    ``parent_rel`` in this library, so listed entries can show the linked/
    unbundled badges without a per-file query. Joins the owning bundle to know
    whether the grouping is still provisional (scan-staged) or confirmed. The
    indexed directory key keeps the request bounded to this one directory."""
    stmt = (
        select(
            AssetFile,
            PlaybackProgress.position_s,
            PlaybackProgress.completed,
            AssetBundle.grouping_state,
            AssetBundle.grouping_source,
        )
        .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
        .outerjoin(PlaybackProgress, PlaybackProgress.file_id == AssetFile.id)
        .where(AssetFile.directory_path == parent_rel)
    )
    out: dict[str, _Link] = {}
    asset_files: list[AssetFile] = []
    for (
        asset_file,
        resume_position,
        progress_completed,
        grouping_state,
        grouping_source,
    ) in session.execute(stmt):
        meta = asset_file.tech_metadata or {}
        unbundled = (
            grouping_state is GroupingState.PROVISIONAL
            and grouping_source is GroupingSource.SCAN_SUGGESTION
        )
        out[asset_file.relative_path] = _Link(
            bundle_id=asset_file.bundle_id,
            file_id=asset_file.id,
            container=meta.get("container"),
            video_codec=meta.get("video_codec"),
            video_codec_tag=meta.get("video_codec_tag"),
            audio_codec=meta.get("audio_codec"),
            video_bitrate=meta.get("video_bitrate"),
            audio_bitrate=meta.get("audio_bitrate"),
            audio_sample_rate=meta.get("audio_sample_rate"),
            duration=meta.get("duration"),
            resume_position=progress_resume_position(resume_position, progress_completed),
            unbundled=unbundled,
        )
        asset_files.append(asset_file)
    return out, asset_files
