"""Journal Replace relocations without transferring either file's authored metadata"""

import os
from copy import deepcopy
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.domain.enums import FileAvailability, FileOpStatus, FileOpType
from cairndex.file_ops import fsmove, journal, trash
from cairndex.file_ops.paths import resolve_writable
from cairndex.media.hls import close_source_sessions
from cairndex.persistence.models import AssetFile, FileOperation


# Observe identity without reading large files or following a symlink
def observation(path: Path) -> dict[str, int]:
    stat = path.lstat()
    return {
        "device": stat.st_dev,
        "inode": stat.st_ino,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "mode": stat.st_mode,
    }


# Treat an absent or changed path as uncertain, never as permission to overwrite it
def matches(path: Path, expected: dict[str, Any]) -> bool:
    try:
        return bool(expected) and observation(path) == expected
    except OSError:
        return False


# Close path-bound encoders while retaining identity-bound derivatives for unchanged bytes
def close_media(session: Session, root: Path, relative: str) -> None:
    from cairndex.file_ops.operations import _linked_rows_under

    close_source_sessions(root / relative)
    for row in _linked_rows_under(session, relative):
        close_source_sessions(root / row.relative_path)


# Commit every displaced receipt with the parent intent before touching either file
def begin(
    session: Session,
    root: Path,
    *,
    op: FileOpType,
    planned: list[tuple[str, str, bool]],
    dest_dir: str = "",
) -> FileOperation:
    from cairndex.file_ops.operations import _linked_rows_under

    for _, destination, _ in planned:
        if any(
            source == destination
            or source.startswith(f"{destination}/")
            or destination.startswith(f"{source}/")
            for source, _, _ in planned
        ):
            raise ConflictError("A replacement destination overlaps a selected source.")
    entries: list[dict[str, Any]] = []
    operation = FileOperation(op=op, status=FileOpStatus.PENDING, payload={})
    session.add(operation)
    session.flush()
    for source, destination, replace in planned:
        entry: dict[str, Any] = {
            "source": source,
            "destination": destination,
            "original": observation(resolve_writable(root, source)),
            "source_files": {
                row.id: row.relative_path for row in _linked_rows_under(session, source)
            },
        }
        if replace:
            backup = FileOperation(
                op=FileOpType.TRASH,
                status=FileOpStatus.PENDING,
                payload={"paths": [destination], "relocation_parent": operation.id},
            )
            session.add(backup)
            session.flush()
            entry.update(
                replaced_operation_id=backup.id,
                displaced=observation(resolve_writable(root, destination)),
            )
        entries.append(entry)
    operation.payload = {"relocation_protocol": 1, "moves": entries, "dest_dir": dest_dir}
    if op is FileOpType.RENAME:
        operation.payload.update(
            source=entries[0]["source"],
            destination=entries[0]["destination"],
            replaced_operation_id=entries[0]["replaced_operation_id"],
        )
    session.commit()
    return operation


# Save progress and path metadata together so replay can finish either side of a rename
def save(session: Session, operation: FileOperation, entries: list[dict[str, Any]]) -> None:
    journal.finish_payload(session, operation, moves=deepcopy(entries))


# Resolve a prepared Trash receipt before judging its parent's source move
def settle_backup(session: Session, root: Path, entry: dict[str, Any]) -> FileOperation | None:
    from cairndex.file_ops.reconcile import _settle_trash

    backup_id = entry.get("replaced_operation_id")
    backup = session.get(FileOperation, backup_id) if backup_id else None
    if (
        backup is not None
        and backup.status is FileOpStatus.PENDING
        and not backup.payload.get("restore_started")
    ):
        stored = root / trash.stored_relative_path(backup.id, entry["destination"])
        if os.path.lexists(stored):
            _settle_trash(session, root, backup)
    return backup


# Restore a displaced identity idempotently after a failed move or interrupted Undo
def restore_backup(session: Session, root: Path, entry: dict[str, Any]) -> None:
    backup = settle_backup(session, root, entry)
    if backup is None or backup.status is FileOpStatus.UNDONE:
        return
    if backup.status is not FileOpStatus.DONE and not backup.payload.get("restore_started"):
        raise ConflictError("The displaced file is not available in Trash.")
    destination = resolve_writable(root, entry["destination"])
    stored = root / trash.stored_relative_path(backup.id, entry["destination"])
    if os.path.lexists(stored):
        from cairndex.file_ops.operations import _ensure_restorable, _rename_on_disk

        recorded = [trash.entry_from_payload(item) for item in backup.payload["entries"]]
        _ensure_restorable(session, root, recorded)
        if not matches(stored, entry.get("backup_observation", entry["displaced"])):
            raise ConflictError("The displaced file changed in Trash; recovery requires review.")
        backup.status = FileOpStatus.PENDING
        journal.finish_payload(session, backup, restore_started=True)
        close_media(session, root, stored.relative_to(root).as_posix())
        _rename_on_disk(stored, destination)
    elif not matches(destination, entry.get("backup_observation", entry["displaced"])):
        raise ConflictError("Cannot identify the restored file; recovery requires review.")
    for item in backup.payload["entries"]:
        row = session.get(AssetFile, item["file_id"]) if item.get("file_id") else None
        if row is not None:
            if row.relative_path not in (item["stored_path"], item["original_path"]):
                raise ConflictError("The displaced metadata moved; recovery requires review.")
            row.relative_path = item["original_path"]
            row.availability = FileAvailability.AVAILABLE
    journal.mark_undone(session, backup)
    trash.prune_operation_dir(root, backup.id)


# Carry source metadata to the new path and retain a durable observation for Undo
def finish_entry(session: Session, root: Path, entry: dict[str, Any]) -> int:
    from cairndex.file_ops.operations import repoint_linked_rows

    updated = repoint_linked_rows(session, source=entry["source"], destination=entry["destination"])
    entry.update(
        moved_observation=observation(resolve_writable(root, entry["destination"])), done=True
    )
    entry.setdefault("files_updated", updated)
    return int(entry["files_updated"])


# Execute only the reviewed batch; a per-entry failure leaves both identities recoverable
def execute(session: Session, root: Path, operation: FileOperation) -> tuple[int, list[str]]:
    from cairndex.file_ops.operations import _rename_on_disk, trash_paths

    entries = deepcopy(operation.payload["moves"])
    updated = 0
    failed: list[str] = []
    for entry in entries:
        source = resolve_writable(root, entry["source"])
        destination = resolve_writable(root, entry["destination"])
        try:
            if not matches(source, entry["original"]):
                raise ConflictError("The source changed before it could be moved.")
            backup_id = entry.get("replaced_operation_id")
            if backup_id:
                if not matches(destination, entry["displaced"]):
                    raise ConflictError("The destination changed before it could be displaced.")
                close_media(session, root, entry["destination"])
                backup = session.get(FileOperation, backup_id)
                assert backup is not None
                trash_paths(session, root, paths=[entry["destination"]], prepared=backup)
                entry["backup_observation"] = observation(
                    root / trash.stored_relative_path(backup_id, entry["destination"])
                )
                save(session, operation, entries)
            if os.path.lexists(destination):
                raise ConflictError("The destination became occupied; nothing will overwrite it.")
            close_media(session, root, entry["source"])
            _rename_on_disk(source, destination)
            updated += finish_entry(session, root, entry)
            save(session, operation, entries)
        except (OSError, ConflictError):
            # Resolve what actually happened rather than marking moved bytes as a failed intent
            session.rollback()
            failed.append(entry["source"])
    if failed:
        return recover(session, root, operation)
    journal.finish(session, operation, moves=entries, files_updated=updated)
    return updated, failed


# Reconcile observed moves and roll back displacement when the source never moved
def recover(session: Session, root: Path, operation: FileOperation) -> tuple[int, list[str]]:
    if operation.payload.get("undo_started"):
        return undo(session, root, operation), []
    entries = deepcopy(operation.payload["moves"])
    updated = 0
    failed: list[str] = []
    leftovers: list[str] = []
    for entry in entries:
        backup = settle_backup(session, root, entry)
        source = resolve_writable(root, entry["source"])
        destination = resolve_writable(root, entry["destination"])
        expected = entry.get("moved_observation", entry["original"])
        moved = not os.path.lexists(source) and matches(destination, expected)
        marked = fsmove.marker_names_source(destination, source)
        if moved or marked:
            if backup is not None and backup.status is not FileOpStatus.DONE:
                raise ConflictError("The displaced receipt requires recovery before the move.")
            updated += finish_entry(session, root, entry)
            if os.path.lexists(source):
                leftovers.append(entry["source"])
            save(session, operation, entries)
            fsmove.clear_marker(destination)
        else:
            failed.append(entry["source"])
            if (
                matches(source, entry["original"])
                and not os.path.lexists(destination)
                and backup is not None
            ):
                restore_backup(session, root, entry)
            if backup is not None and backup.status is FileOpStatus.PENDING:
                journal.fail(session, backup, "interrupted before displacement")
    completed = [entry for entry in entries if entry.get("done")]
    if not completed:
        journal.fail(session, operation, "interrupted or changed before the move could complete")
        raise ConflictError("The move did not complete; any displaced file remains recoverable.")
    journal.finish(
        session,
        operation,
        moves=completed,
        files_updated=updated,
        failed_paths=failed,
        failed_moves=[entry for entry in entries if not entry.get("done")],
        leftover_source_paths=leftovers,
        reconciled=True,
    )
    return updated, failed


# Journal the inverse before moving A home or restoring B; later metadata edits stay live
def undo(session: Session, root: Path, operation: FileOperation) -> int:
    from cairndex.file_ops.operations import (
        _ensure_move_reversible,
        _rename_on_disk,
        repoint_linked_rows,
    )

    entries = deepcopy(operation.payload["moves"])
    if not operation.payload.get("undo_started"):
        _ensure_move_reversible(session, root, entries)
        for entry in entries:
            for file_id, original in entry.get("source_files", {}).items():
                row = session.get(AssetFile, file_id)
                expected_path = entry["destination"] + original[len(entry["source"]) :]
                if row is not None and row.relative_path != expected_path:
                    raise ConflictError(
                        "The moved identity moved again; undo its newer operation first."
                    )
            if not matches(
                resolve_writable(root, entry["destination"]), entry["moved_observation"]
            ):
                raise ConflictError(
                    "The moved file changed or moved again; undo its newer operation first."
                )
            backup = settle_backup(session, root, entry)
            if backup is not None:
                stored = root / trash.stored_relative_path(backup.id, entry["destination"])
                if backup.status is not FileOpStatus.DONE or not matches(
                    stored, entry.get("backup_observation", entry["displaced"])
                ):
                    raise ConflictError("The displaced file is no longer recoverable by this Undo.")
        operation.status = FileOpStatus.PENDING
        journal.finish_payload(session, operation, undo_started=True)
    updated = 0
    for entry in reversed(entries):
        source = resolve_writable(root, entry["source"])
        destination = resolve_writable(root, entry["destination"])
        returned = matches(source, entry.get("returned_observation", entry["moved_observation"]))
        if not returned:
            if os.path.lexists(source) or not matches(destination, entry["moved_observation"]):
                raise ConflictError("The Undo paths changed; recovery requires review.")
            close_media(session, root, entry["destination"])
            _rename_on_disk(destination, source)
        if not entry.get("returned_observation"):
            updated += repoint_linked_rows(
                session, source=entry["destination"], destination=entry["source"]
            )
            entry["returned_observation"] = observation(source)
            save(session, operation, entries)
        restore_backup(session, root, entry)
    journal.mark_undone(session, operation)
    return updated
