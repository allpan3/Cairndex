"""Resolve operations interrupted between the filesystem and the database.

Runs once per library open (ADR-0013 §3.1). A ``pending`` row means the process
died after the journal was committed — so either the filesystem operation had
already happened and only the metadata update is missing, or it never happened
at all. The filesystem itself is the evidence:

* source gone, destination present → the rename happened; finish the metadata;
* source present, destination absent → it never happened; mark failed;
* anything else → do not guess. Mark it failed and leave the files alone; the
  scanner's moved-file repair (ADR-0006) is the mechanism for the ambiguous
  cases, and it preserves ``AssetFile.id`` too.

A deletion is the one operation reconciled *partially*, because it is the one
that can be partially done: a multi-path delete interrupted halfway has entries
sitting in the trash, and failing the whole operation would leave them there
with nothing listing them — invisible to the Trash view and unreachable by
restore. So whatever reached the trash is recorded and the deletion completes.

Never raises. A library that cannot be reconciled must still open — refusing to
open it would turn a recoverable inconsistency into a lost library.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.domain.enums import FileOpType
from cairndex.file_ops import journal, trash
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
        source_present = os.path.lexists(resolve_writable(root, source))
        destination_present = os.path.lexists(resolve_writable(root, destination))
        if not source_present and destination_present:
            updated = repoint_linked_rows(session, source=source, destination=destination)
            journal.finish(session, operation, files_updated=updated, reconciled=True)
            return True
        if source_present and not destination_present:
            journal.fail(session, operation, "interrupted before the rename took effect")
            return False
        journal.fail(session, operation, "could not determine whether the rename took effect")
        return False

    if operation.op is FileOpType.TRASH:
        return _settle_trash(session, root, operation)

    journal.fail(session, operation, f"cannot reconcile a {operation.op.value} operation")
    return False


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
        entry = trash.TrashedEntry(
            original_path=original,
            stored_path=stored,
            file_id=None,
            is_directory=stored_full.is_dir() and not stored_full.is_symlink(),
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
