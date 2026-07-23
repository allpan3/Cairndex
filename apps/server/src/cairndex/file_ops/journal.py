"""The operation journal: intent recorded before the filesystem moves (ADR-0013 §3.1).

Every guarded operation follows the same three steps:

1. ``begin`` — insert a ``pending`` row **and commit it**. The commit is the
   whole point: a row that is still in an uncommitted transaction when the
   process dies leaves no trace, which is the case this table exists to prevent.
2. perform the filesystem operation;
3. ``finish`` — update the content rows and mark the operation ``done`` in one
   transaction, so metadata and status can never disagree.

A crash between (2) and (3) leaves a ``pending`` row for ``reconcile`` to
resolve on the next library open. The scanner's moved-file repair (ADR-0006)
remains the backstop below all of this: even a lost journal row looks like an
external move and heals with ``AssetFile.id`` preserved.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.time import utcnow
from cairndex.domain.enums import FileOpStatus, FileOpType
from cairndex.persistence.models import FileOperation


def begin(session: Session, *, op: FileOpType, payload: dict[str, Any]) -> FileOperation:
    """Record the intent to perform ``op`` and commit it before anything happens."""
    operation = FileOperation(op=op, status=FileOpStatus.PENDING, payload=payload)
    session.add(operation)
    # Committing mid-request is deliberate, not a leak of transaction control:
    # the row has to outlive a crash that happens one line later.
    session.commit()
    return operation


def finish(session: Session, operation: FileOperation, **payload_updates: Any) -> FileOperation:
    """Mark an operation done, optionally recording what it turned out to do.

    ``payload_updates`` carries results the caller could not know up front — the
    name a "keep both" collision settled on, the number of rows repointed — so
    Undo and the history view describe what actually happened rather than what
    was asked for.
    """
    if payload_updates:
        operation.payload = {**operation.payload, **payload_updates}
    operation.status = FileOpStatus.DONE
    operation.finished_at = utcnow()
    session.commit()
    return operation


def fail(session: Session, operation: FileOperation, error: str) -> FileOperation:
    """Mark an operation failed, in the same words the caller was given."""
    # Roll back whatever half-applied metadata the failure interrupted before
    # writing the status, so the journal's own row is not lost with it.
    session.rollback()
    session.add(operation)
    operation.status = FileOpStatus.FAILED
    operation.error = error
    operation.finished_at = utcnow()
    session.commit()
    return operation


def mark_undone(session: Session, operation: FileOperation) -> FileOperation:
    """Record that an operation's inverse was applied.

    The row stays, flipped to ``undone`` rather than deleted: a history that
    quietly drops what was reversed is a history that cannot be trusted to
    explain how a library reached its current shape.
    """
    operation.status = FileOpStatus.UNDONE
    operation.finished_at = utcnow()
    session.commit()
    return operation


def pending_operations(session: Session) -> list[FileOperation]:
    """Every operation interrupted before its metadata side completed."""
    return list(
        session.scalars(
            select(FileOperation)
            .where(FileOperation.status == FileOpStatus.PENDING)
            .order_by(FileOperation.id)
        )
    )


def get_operation(session: Session, operation_id: str) -> FileOperation | None:
    return session.get(FileOperation, operation_id)


def list_operations(
    session: Session, *, limit: int, before_id: str | None = None
) -> list[FileOperation]:
    """Newest-first page of the journal, keyed on the ULID's own time ordering."""
    query = select(FileOperation).order_by(FileOperation.id.desc()).limit(limit)
    if before_id is not None:
        query = query.where(FileOperation.id < before_id)
    return list(session.scalars(query))
