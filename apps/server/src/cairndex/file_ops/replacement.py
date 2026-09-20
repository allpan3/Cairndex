"""Preserve destination metadata while journaled import replacements swap bytes"""

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, FileOpStatus, FileOpType
from cairndex.file_ops import journal, smb_transport, trash
from cairndex.file_ops.paths import resolve_writable
from cairndex.media.hls import close_source_sessions
from cairndex.ownership.lifecycle import check_work_ownership
from cairndex.persistence.models import AssetBundle, AssetFile, FileOperation, SubtitleTrack
from cairndex.scanning.fingerprint import quick_fingerprint, sqlite_filesystem_identity
from cairndex.services.collections import touch_cover_collections_for_bundle


# Identify a published upload without hashing a multi-gigabyte file on the request path
def observation(path: Path, *, allow_prompt: bool = False) -> dict[str, Any]:
    direct = smb_transport.observation(path, allow_prompt=allow_prompt)
    if direct is not None:
        return direct
    return native_observation(path)


# Preserve protocol-two receipt semantics even when the path now has direct SMB support
def native_observation(path: Path) -> dict[str, int]:
    stat = path.stat()
    return {
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "inode": stat.st_ino,
        "device": stat.st_dev,
    }


# Filesystem observations are recovery evidence, never content-duplicate proof
def matches(path: Path, expected: dict[str, Any]) -> bool:
    try:
        if expected.get("kind") == "smb3":
            return smb_transport.matches(path, expected)
        return bool(expected) and native_observation(path) == expected
    except smb_transport.SmbTransportError:
        raise
    except OSError:
        return False


# Reserve and reference the backup before moving any bytes or committing another journal row
def prepare_backup(session: Session, operation: FileOperation, *, key: str) -> FileOperation:
    backup = FileOperation(
        op=FileOpType.TRASH,
        status=FileOpStatus.PENDING,
        payload={
            "paths": [operation.payload["destination"]],
            "bytes_only": key == "replaced_operation_id"
            or bool(operation.payload.get("retained_file_id")),
            "original": operation.payload[
                "previous" if key == "replaced_operation_id" else "published"
            ],
        },
    )
    session.add(backup)
    session.flush()
    journal.finish_payload(session, operation, **{key: backup.id})
    return backup


# Keep an ordinary recoverable Trash receipt without transferring the active file's metadata
def stash(session: Session, root: Path, backup: FileOperation) -> None:
    relative = backup.payload["paths"][0]
    stored = root / trash.stored_relative_path(backup.id, relative)
    if stored.exists():
        is_directory, size = trash.path_metadata(stored)
        entry = trash.TrashedEntry(
            relative, stored.relative_to(root).as_posix(), None, is_directory, size
        )
    else:
        check_work_ownership()
        source = resolve_writable(root, relative)
        if not matches(source, backup.payload["original"]):
            raise ConflictError("The destination changed before it could be backed up.")
        entry = trash.move_into_trash(root, operation_id=backup.id, original_path=relative)
    entries = [entry]
    if not backup.payload["bytes_only"]:
        from cairndex.file_ops.operations import mark_rows_trashed

        entries = mark_rows_trashed(session, backup.id, entry)
    trash.write_meta(root, operation_id=backup.id, entries=entries)
    journal.finish(
        session,
        backup,
        entries=[item.as_payload() for item in entries],
        files_updated=sum(bool(item.file_id) for item in entries),
    )


# Refresh byte-derived state while leaving owner-authored relationships and coordinates intact
def refresh_file(session: Session, root: Path, operation: FileOperation) -> int:
    file_id = operation.payload.get("retained_file_id")
    row = session.get(AssetFile, file_id) if file_id else None
    if row is None:
        return 0
    relative = operation.payload["destination"]
    if row.relative_path != relative:
        raise ConflictError(
            "The replacement destination has moved; its metadata was left unchanged."
        )
    source = resolve_writable(root, relative)
    close_source_sessions(source)
    stat = source.stat()
    row.size_bytes = stat.st_size
    row.mtime = datetime.fromtimestamp(stat.st_mtime, UTC)
    row.quick_fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    row.filesystem_device = sqlite_filesystem_identity(stat.st_dev)
    row.filesystem_inode = sqlite_filesystem_identity(stat.st_ino)
    row.identity_available = bool(stat.st_ino)
    row.availability = FileAvailability.AVAILABLE
    row.full_hash = None
    row.tech_metadata = None
    row.mime_type = None
    bundle = session.get(AssetBundle, row.bundle_id)
    if bundle is not None:
        bundle.updated_at = utcnow()
    # Embedded stream indices describe the replaced container, unlike external subtitle links
    for track in session.scalars(
        select(SubtitleTrack).where(
            SubtitleTrack.video_file_id == row.id, SubtitleTrack.embedded_index.is_not(None)
        )
    ):
        session.delete(track)
    session.flush()
    touch_cover_collections_for_bundle(session, row.bundle_id)
    return 1


# Roll back a failed publication only when its original destination is still vacant
def restore_backup(session: Session, root: Path, backup: FileOperation) -> None:
    relative = backup.payload["paths"][0]
    stored = root / trash.stored_relative_path(backup.id, relative)
    destination = resolve_writable(root, relative)
    if stored.exists():
        if os.path.lexists(destination):
            if not matches(destination, backup.payload["original"]):
                raise ConflictError(
                    "The destination is occupied; the previous bytes remain in Trash."
                )
            # A previous recovery can have linked the original before dropping its Trash name
            stored.unlink()
        else:
            check_work_ownership()
            publish(stored, destination)
    elif not matches(destination, backup.payload["original"]):
        raise ConflictError("The previous bytes could not be located; recovery requires review.")
    journal.mark_undone(session, backup)


# Journal Undo before stashing the current version, so restart can finish the inverse
def undo(session: Session, root: Path, operation: FileOperation) -> int:
    relative = operation.payload["destination"]
    destination = resolve_writable(root, relative)
    previous = session.get(FileOperation, operation.payload["replaced_operation_id"])
    assert previous is not None
    previous_path = root / trash.stored_relative_path(previous.id, relative)
    if not operation.payload.get("undo_started"):
        file_id = operation.payload.get("retained_file_id")
        row = session.get(AssetFile, file_id) if file_id else None
        if (file_id and (row is None or row.relative_path != relative)) or not matches(
            destination, operation.payload["published"]
        ):
            raise ConflictError(
                "The replacement has changed or moved; undo its newer operation first."
            )
        if previous.status is not FileOpStatus.DONE or not previous_path.is_file():
            raise ConflictError("The previous bytes are no longer in Trash; this cannot be undone.")
        operation.status = FileOpStatus.PENDING
        operation.payload = {**operation.payload, "undo_started": True}
        current = prepare_backup(session, operation, key="undo_trash_operation_id")
    else:
        saved_current = session.get(FileOperation, operation.payload["undo_trash_operation_id"])
        assert saved_current is not None
        current = saved_current
    if previous_path.exists():
        if current.status is FileOpStatus.PENDING:
            stash(session, root, current)
        restore_backup(session, root, previous)
    elif not matches(destination, operation.payload["previous"]):
        raise ConflictError("Cannot determine whether Undo restored the previous bytes.")
    changed = refresh_file(session, root, operation)
    for values in operation.payload.get("previous_embedded_tracks", []):
        session.add(SubtitleTrack(**values))
    journal.mark_undone(session, previous)
    journal.mark_undone(session, operation)
    return changed


# Embedded track labels belong to the old container and return with its bytes on Undo
def embedded_snapshot(session: Session, file_id: str | None) -> list[dict[str, Any]]:
    fields = (
        "id",
        "bundle_id",
        "video_file_id",
        "embedded_index",
        "language",
        "label",
        "format",
        "is_default",
        "is_forced",
        "sort_order",
        "version",
    )
    return (
        [
            {field: getattr(track, field) for field in fields}
            for track in session.scalars(
                select(SubtitleTrack).where(
                    SubtitleTrack.video_file_id == file_id,
                    SubtitleTrack.embedded_index.is_not(None),
                )
            )
        ]
        if file_id
        else []
    )


# Probe only staged bytes; interrupted probes remain in the swept staging directory
def check_hard_links(staging: Path) -> None:
    check_work_ownership()
    if smb_transport.check_hard_links(staging):
        return
    probe = staging.with_suffix(".link")
    os.link(staging, probe)
    probe.unlink()


# Commit a staged regular file without an overwrite race against an external newcomer
def publish(source: Path, destination: Path) -> None:
    check_work_ownership()
    if smb_transport.publish(source, destination):
        return
    os.link(source, destination)
    # If cleanup fails, both names hold the same bytes and recovery can finish safely
    source.unlink()
