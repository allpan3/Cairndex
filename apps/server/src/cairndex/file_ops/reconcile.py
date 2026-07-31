"""Resolve operations interrupted between the filesystem and the database.

Runs once per library open (ADR-0013 §3.1). A ``pending`` row means the process
died after the journal was committed — so either the filesystem operation had
already happened and only the metadata update is missing, or it never happened
at all. The filesystem itself is the evidence:

* source gone, destination present → the rename happened; finish the metadata;
* source present, destination absent → it never happened; mark failed;
* **both present, and the destination looks like a completed copy of the source**
  → a cross-device move was interrupted between committing the copy and removing
  the original (see :mod:`cairndex.file_ops.fsmove`). The bytes are at the
  destination, so the metadata is finished there and the leftover original is
  *reported, not deleted* — automatic recovery removing original media is exactly
  what ADR-0013 forbids, and the owner can delete the duplicate through the
  ordinary journaled trash once they can see it;
* anything else → do not guess. Mark it failed and leave the files alone; the
  scanner's moved-file repair (ADR-0006) is the mechanism for the ambiguous
  cases, and it preserves ``AssetFile.id`` too.

Deletion and multi-move are reconciled *partially*, because they are the
operations that can be partially done. A multi-path delete interrupted halfway
has entries sitting in the trash, and failing the whole operation would leave
them there with nothing listing them — invisible to the Trash view and
unreachable by restore. A batch move interrupted halfway has some files at their
new paths and some not, and failing the whole operation would point the moved
ones at paths that no longer hold them. So in both cases whatever actually
happened on disk is recorded per entry and the operation completes. (The same
reasoning applies to a delete or move that fails mid-*request* rather than
mid-crash; the operation handles that itself, because this only ever examines
``pending`` rows and would never see it.)

Never raises. A library that cannot be reconciled must still open — refusing to
open it would turn a recoverable inconsistency into a lost library.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.domain.enums import FileOpType
from cairndex.file_ops import fsmove, imports, journal, trash
from cairndex.file_ops.operations import mark_rows_trashed, repoint_linked_rows
from cairndex.file_ops.paths import resolve_writable
from cairndex.persistence.models import FileOperation

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ReconcileReport:
    completed: int = 0
    failed: int = 0

    @property
    def total(self) -> int:
        return self.completed + self.failed


def reconcile_pending(session: Session, root: Path) -> ReconcileReport:
    """Settle every pending journal row against what is actually on disk."""
    pending = journal.pending_operations(session)
    if not pending:
        return ReconcileReport()

    completed = 0
    failed = 0
    for operation in pending:
        try:
            if _settle(session, root, operation):
                completed += 1
            else:
                failed += 1
        except Exception:
            # One unreconcilable operation must not strand the others, and must
            # not stop the library opening.
            logger.exception("could not reconcile file operation %s", operation.id)
            failed += 1
    logger.info(
        "reconciled %d interrupted file operation(s): %d completed, %d failed",
        len(pending),
        completed,
        failed,
    )
    return ReconcileReport(completed=completed, failed=failed)


def _settle(session: Session, root: Path, operation: FileOperation) -> bool:
    """Return whether the operation turned out to have completed on disk."""
    if operation.op is FileOpType.MKDIR:
        destination = operation.payload.get("destination")
        if destination and resolve_writable(root, destination).is_dir():
            journal.finish(session, operation)
            return True
        journal.fail(session, operation, "interrupted before the folder was created")
        return False

    if operation.op is FileOpType.RENAME:
        source = operation.payload.get("source")
        destination = operation.payload.get("destination")
        if not source or not destination:
            journal.fail(session, operation, "journal entry is incomplete")
            return False
        source_full = resolve_writable(root, source)
        destination_full = resolve_writable(root, destination)
        source_present = os.path.lexists(source_full)
        destination_present = os.path.lexists(destination_full)
        if not source_present and destination_present:
            updated = repoint_linked_rows(session, source=source, destination=destination)
            journal.finish(session, operation, files_updated=updated, reconciled=True)
            return True
        if source_present and not destination_present:
            journal.fail(session, operation, "interrupted before the rename took effect")
            return False
        if (
            source_present
            and destination_present
            and fsmove.marker_names_source(destination_full, source_full)
        ):
            updated = repoint_linked_rows(session, source=source, destination=destination)
            fsmove.clear_marker(destination_full)
            journal.finish(
                session,
                operation,
                files_updated=updated,
                reconciled=True,
                leftover_source_paths=[source],
            )
            return True
        fsmove.clear_marker(destination_full)
        journal.fail(session, operation, "could not determine whether the rename took effect")
        return False

    if operation.op is FileOpType.TRASH:
        return _settle_trash(session, root, operation)

    if operation.op is FileOpType.MOVE:
        return _settle_move(session, root, operation)

    if operation.op is FileOpType.IMPORT:
        # The destination existing is *not* enough to conclude the import
        # finished: a Replace-policy import whose upload died partway leaves the
        # old file still sitting at that path, and calling that success would
        # record an import of bytes that never arrived. The staging file is the
        # evidence that settles it — it exists only while an upload is
        # unfinished, and this runs before the staging sweep precisely so it is
        # still there to be read.
        staging = imports.staging_dir(root) / f"{operation.id}.part"
        if os.path.lexists(staging):
            journal.fail(session, operation, "interrupted before the upload finished")
            return False
        destination = operation.payload.get("destination")
        if destination and os.path.lexists(resolve_writable(root, destination)):
            journal.finish(session, operation, reconciled=True)
            return True
        journal.fail(session, operation, "interrupted before the upload finished")
        return False

    journal.fail(session, operation, f"cannot reconcile a {operation.op.value} operation")
    return False


def _settle_move(session: Session, root: Path, operation: FileOperation) -> bool:
    """Complete an interrupted multi-move for whatever actually moved on disk.

    A batch move is many renames under one operation, so a crash can leave some
    entries moved and some not — the same partial shape as a multi-path delete,
    and resolved the same way. Each entry is judged on its own evidence: source
    gone and destination present means that rename took effect, so its rows are
    repointed; any other state means it did not, and the file is simply left
    where it is for the scanner's moved-file repair to pick up. Completing the
    entries that made it beats failing the whole operation, which would leave
    already-moved files pointed at paths that no longer hold them.
    """
    completed: list[dict[str, str]] = []
    leftovers: list[str] = []
    files_updated = 0
    for entry in operation.payload.get("moves", []):
        source = entry.get("source")
        destination = entry.get("destination")
        if not source or not destination:
            continue
        source_full = resolve_writable(root, source)
        destination_full = resolve_writable(root, destination)
        source_present = os.path.lexists(source_full)
        destination_present = os.path.lexists(destination_full)
        if not source_present and destination_present:
            files_updated += repoint_linked_rows(session, source=source, destination=destination)
            completed.append(entry)
        elif (
            source_present
            and destination_present
            and fsmove.marker_names_source(destination_full, source_full)
        ):
            # A cross-device move that committed its copy but had not yet removed
            # the original. The destination is authoritative; the original is left
            # on disk and named here rather than deleted behind the owner's back.
            files_updated += repoint_linked_rows(session, source=source, destination=destination)
            fsmove.clear_marker(destination_full)
            completed.append(entry)
            leftovers.append(source)

    if not completed:
        journal.fail(session, operation, "interrupted before anything was moved")
        return False

    journal.finish(
        session,
        operation,
        moves=completed,
        files_updated=files_updated,
        reconciled=True,
        **({"leftover_source_paths": leftovers} if leftovers else {}),
    )
    return True


def _settle_trash(session: Session, root: Path, operation: FileOperation) -> bool:
    """Complete an interrupted deletion for whatever actually reached the trash.

    A crash partway through a multi-path delete leaves some entries moved and
    some not. Marking the whole operation failed would be the worst outcome
    available: the moved files would sit in the trash with no journal entry
    listing them, so the Trash view would not show them and restore could not
    reach them — a deletion that looks permanent and is not. So the entries that
    made it are recorded and the operation is completed; the ones that did not
    are simply still where they were.
    """
    moved: list[trash.TrashedEntry] = []
    for original in operation.payload.get("paths", []):
        stored = trash.stored_relative_path(operation.id, original)
        stored_full = root / stored
        if not os.path.lexists(stored_full):
            continue  # never made it; the file is still in place
        try:
            is_directory, size_bytes = trash.path_metadata(stored_full)
        except OSError:
            continue  # vanished between the existence check and metadata read
        entry = trash.TrashedEntry(
            original_path=original,
            stored_path=stored,
            file_id=None,
            is_directory=is_directory,
            size_bytes=size_bytes,
        )
        moved.extend(mark_rows_trashed(session, operation.id, entry))

    if not moved:
        journal.fail(session, operation, "interrupted before anything was moved to the trash")
        return False

    trash.write_meta(root, operation_id=operation.id, entries=moved)
    journal.finish(
        session,
        operation,
        entries=[entry.as_payload() for entry in moved],
        files_updated=sum(1 for entry in moved if entry.file_id),
        reconciled=True,
    )
    return True
