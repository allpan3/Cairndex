"""Explicit repair of missing rows to already-linked replacement paths.

The scanner intentionally avoids guessing when both a basename and network
filesystem identity change. Once the replacement path has already been linked,
rescans no longer see it as newly appeared. This module exposes the narrow,
owner-confirmed escape hatch: an exact, globally unique quick-fingerprint match
can replace the duplicate row while the original stable ``AssetFile.id`` and
its established bundle metadata survive.
"""

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError
from cairndex.core.paths import PathSafetyError, resolve_within_root
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability
from cairndex.domain.file_names import display_title_after_move
from cairndex.grouping.membership import reap_source_bundles
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import (
    AssetFile,
    BundleCursor,
    PlaybackProgress,
    SubtitleTrack,
)
from cairndex.scanning.fingerprint import quick_fingerprint


@dataclass(frozen=True)
class FileRepairCandidate:
    """One unambiguous linked replacement for a missing file row."""

    missing_file_id: str
    replacement_file_id: str
    replacement_bundle_id: str
    relative_path: str
    display_title: str


# Resolve one file only when it still belongs to the route's bundle
def _bundle_file(session: Session, bundle_id: str, file_id: str) -> AssetFile:
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise NotFoundError(f"file {file_id!r} not found in bundle {bundle_id!r}")
    return asset_file


# Re-stat a linked row so stale database fingerprints never become repair choices
def _current_quick_fingerprint(session: Session, asset_file: AssetFile) -> str | None:
    try:
        path = resolve_within_root(library_root_for_session(session), asset_file.relative_path)
        stat = Path(path).stat()
    except (OSError, PathSafetyError):
        return None
    return quick_fingerprint(stat.st_size, stat.st_mtime_ns)


def find_repair_candidate(
    session: Session, bundle_id: str, missing_file_id: str
) -> FileRepairCandidate | None:
    """Return a live 1:1 quick-fingerprint match, or ``None`` when uncertain."""
    missing = _bundle_file(session, bundle_id, missing_file_id)
    if missing.availability is not FileAvailability.MISSING or not missing.quick_fingerprint:
        return None

    root = library_root_for_session(session)
    try:
        if resolve_within_root(root, missing.relative_path).is_file():
            return None
    except PathSafetyError:
        return None

    missing_claimers = list(
        session.scalars(
            select(AssetFile).where(
                AssetFile.availability == FileAvailability.MISSING,
                AssetFile.quick_fingerprint == missing.quick_fingerprint,
                AssetFile.media_kind == missing.media_kind,
            )
        )
    )
    if len(missing_claimers) != 1:
        return None

    replacements = list(
        session.scalars(
            select(AssetFile).where(
                AssetFile.availability == FileAvailability.AVAILABLE,
                AssetFile.quick_fingerprint == missing.quick_fingerprint,
                AssetFile.media_kind == missing.media_kind,
            )
        )
    )
    current = [
        row
        for row in replacements
        if _current_quick_fingerprint(session, row) == missing.quick_fingerprint
    ]
    if len(current) != 1:
        return None

    replacement = current[0]
    return FileRepairCandidate(
        missing_file_id=missing.id,
        replacement_file_id=replacement.id,
        replacement_bundle_id=replacement.bundle_id,
        relative_path=replacement.relative_path,
        display_title=replacement.display_title,
    )


# Keep whichever progress row reflects the owner's most recent playback
def _merge_progress(session: Session, missing: AssetFile, replacement: AssetFile) -> None:
    old = session.get(PlaybackProgress, missing.id)
    new = session.get(PlaybackProgress, replacement.id)
    if new is None:
        return
    if old is None:
        old = PlaybackProgress(
            file_id=missing.id,
            bundle_id=missing.bundle_id,
            position_s=new.position_s,
            duration_s=new.duration_s,
            completed=new.completed,
            updated_at=new.updated_at,
            user_id=new.user_id,
        )
        session.add(old)
    elif new.updated_at > old.updated_at:
        old.position_s = new.position_s
        old.duration_s = new.duration_s
        old.completed = new.completed
        old.updated_at = new.updated_at
        old.user_id = new.user_id
    session.delete(new)


# Move relational file references before deleting the duplicate row
def _repair_references(session: Session, missing: AssetFile, replacement: AssetFile) -> None:
    source = replacement.bundle
    target = missing.bundle

    if source.cover_file_id == replacement.id:
        source.cover_file_id = missing.id if source.id == target.id else None
    if source.primary_file_id == replacement.id:
        source.primary_file_id = missing.id if source.id == target.id else None

    cursor = session.scalar(select(BundleCursor).where(BundleCursor.file_id == replacement.id))
    if cursor is not None:
        if source.id == target.id and session.get(BundleCursor, target.id) is cursor:
            cursor.file_id = missing.id
        else:
            session.delete(cursor)

    tracks = list(
        session.scalars(
            select(SubtitleTrack).where(
                or_(
                    SubtitleTrack.video_file_id == replacement.id,
                    SubtitleTrack.source_file_id == replacement.id,
                )
            )
        )
    )
    for track in tracks:
        if track.video_file_id == replacement.id:
            equivalent = session.scalar(
                select(SubtitleTrack).where(
                    SubtitleTrack.id != track.id,
                    SubtitleTrack.video_file_id == missing.id,
                    SubtitleTrack.embedded_index == track.embedded_index,
                    SubtitleTrack.source_file_id == track.source_file_id,
                )
            )
            if equivalent is not None:
                session.delete(track)
                continue
            track.video_file_id = missing.id
            track.bundle_id = target.id
        if track.source_file_id == replacement.id:
            equivalent = session.scalar(
                select(SubtitleTrack).where(
                    SubtitleTrack.id != track.id,
                    SubtitleTrack.source_file_id == missing.id,
                )
            )
            if equivalent is not None:
                session.delete(track)
                continue
            track.source_file_id = missing.id

    _merge_progress(session, missing, replacement)


def repair_file(
    session: Session,
    bundle_id: str,
    missing_file_id: str,
    replacement_file_id: str,
) -> AssetFile:
    """Relink a missing row to its owner-confirmed unique replacement.

    The filesystem is read but never modified. The duplicate available row is
    removed only after its references have been reconciled; the missing row's
    stable id, bundle membership, notes, role, cover time, and source survive.
    """
    candidate = find_repair_candidate(session, bundle_id, missing_file_id)
    if candidate is None or candidate.replacement_file_id != replacement_file_id:
        raise ConflictError("the selected file is no longer an unambiguous repair candidate")

    missing = _bundle_file(session, bundle_id, missing_file_id)
    replacement = session.get(AssetFile, replacement_file_id)
    if replacement is None:
        raise ConflictError("the selected repair candidate no longer exists")

    source_bundle = replacement.bundle
    _repair_references(session, missing, replacement)
    session.delete(replacement)
    session.flush()

    # Same rule as every other repoint: the shown name follows the file unless it
    # is a title someone chose (owner report, 2026-07-30).
    missing.display_title = display_title_after_move(
        display_title=missing.display_title,
        old_path=missing.relative_path,
        new_path=replacement.relative_path,
    )
    missing.relative_path = replacement.relative_path
    missing.original_filename = replacement.original_filename
    missing.mime_type = replacement.mime_type or missing.mime_type
    missing.size_bytes = replacement.size_bytes
    missing.mtime = replacement.mtime
    missing.quick_fingerprint = replacement.quick_fingerprint
    missing.full_hash = missing.full_hash or replacement.full_hash
    missing.filesystem_device = replacement.filesystem_device
    missing.filesystem_inode = replacement.filesystem_inode
    missing.identity_available = replacement.identity_available
    missing.tech_metadata = replacement.tech_metadata or missing.tech_metadata
    missing.availability = FileAvailability.AVAILABLE
    missing.updated_at = utcnow()
    session.flush()

    if source_bundle.id != missing.bundle_id:
        reap_source_bundles(session, [source_bundle])
        session.flush()
    return missing
