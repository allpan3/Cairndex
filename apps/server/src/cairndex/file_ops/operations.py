"""Rename and New Folder — the first operations that actually touch files.

The product advantage these exist to deliver (ADR-0013 §4, plan 4 §1): **when
Cairndex performs the move itself, no repair is ever needed.** The filesystem
operation and the ``AssetFile.relative_path`` update happen together, so
``AssetFile.id`` is preserved by construction and every bundle membership, tag,
collection, cover, subtitle link and cache entry survives. That is strictly
better than an external rename plus scanner repair (ADR-0006), which has to
*infer* what happened after the fact.

Renaming a directory repoints every row beneath it in one operation, computed in
Python rather than with a SQL ``LIKE`` rewrite: the prefix has to be matched on
path *segments*, and ``LIKE 'Show%'`` would happily also match ``Showcase/``.
"""

import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.domain.enums import FileOpStatus, FileOpType
from cairndex.file_ops import journal
from cairndex.file_ops.conflicts import ConflictPolicy, resolve_collision
from cairndex.file_ops.paths import join_relative, parent_of, resolve_writable, validate_name
from cairndex.persistence.models import AssetFile, FileOperation


@dataclass(frozen=True)
class OperationResult:
    """What an operation did, for the client's toast and its Undo button."""

    operation: FileOperation
    # The path the entry ended up at — not always the one asked for, because
    # "keep both" settles on a different name.
    path: str
    # Linked rows repointed. Zero is normal: renaming an unlinked file, or a
    # directory containing none, is still a perfectly good rename.
    files_updated: int
    # True when a "skip" policy meant nothing happened at all.
    skipped: bool = False


def _linked_rows_under(session: Session, relative_path: str) -> list[AssetFile]:
    """Every linked row at ``relative_path`` or beneath it, as a directory.

    Segment-aware: ``Show/S01`` matches ``Show/S01/ep1.mkv`` but never
    ``Show/S01 extras/…``. The indexed ``directory_path`` narrows the scan for
    the common case; the exact-path row is fetched alongside it because a file
    is not under its own directory prefix.
    """
    prefix = f"{relative_path}/"
    return list(
        session.scalars(
            select(AssetFile).where(
                (AssetFile.relative_path == relative_path)
                | (AssetFile.relative_path.startswith(prefix))
            )
        )
    )


def repoint_linked_rows(session: Session, *, source: str, destination: str) -> int:
    """Move every linked row at or under ``source`` to ``destination``.

    Each row keeps its id, which is what makes bundle membership, covers,
    subtitle links, notes, ratings and cache identity survive the rename. Shared
    with the reconciler, which applies exactly this metadata side to an
    operation whose filesystem half already happened.
    """
    rows = _linked_rows_under(session, source)
    for row in rows:
        if row.relative_path == source:
            row.relative_path = destination
        else:
            row.relative_path = destination + row.relative_path[len(source) :]
    return len(rows)


def _ensure_no_linked_conflict(session: Session, destination: str) -> None:
    """Refuse a destination another linked row already claims.

    ``asset_files.relative_path`` is unique, so proceeding would raise an
    IntegrityError *after* the file had already moved on disk — the one ordering
    that leaves the filesystem and the database disagreeing.
    """
    taken = session.scalar(select(AssetFile.id).where(AssetFile.relative_path == destination))
    if taken is not None:
        raise ConflictError(f"Another file is already recorded at {destination!r}.")


def rename(
    session: Session,
    root: Path,
    *,
    path: str,
    new_name: str,
    on_conflict: ConflictPolicy = ConflictPolicy.FAIL,
) -> OperationResult:
    """Rename one file or directory in place, carrying its metadata with it."""
    try:
        source_relative = _normalized(path, what="source")
        name = validate_name(new_name)
        source = resolve_writable(root, source_relative, what="source")
    except PathSafetyError as error:
        raise ValidationError(str(error)) from error

    if not os.path.lexists(source):
        raise NotFoundError(f"{source_relative!r} does not exist.")

    parent = parent_of(source_relative)
    target_relative = join_relative(parent, name)
    if target_relative == source_relative:
        # A no-op rename is not an error, but it must not journal an operation
        # whose inverse would be indistinguishable from the thing itself.
        return OperationResult(
            operation=_noop(session, source_relative), path=source_relative, files_updated=0
        )

    settled = resolve_collision(
        root, relative_path=target_relative, policy=on_conflict, name=name, parent=parent
    )
    if settled.skip:
        return OperationResult(
            operation=_noop(session, source_relative),
            path=source_relative,
            files_updated=0,
            skipped=True,
        )
    target_relative = settled.relative_path

    try:
        destination = resolve_writable(root, target_relative, what="destination")
    except PathSafetyError as error:
        raise ValidationError(str(error)) from error
    _ensure_no_linked_conflict(session, target_relative)

    operation = journal.begin(
        session,
        op=FileOpType.RENAME,
        payload={"source": source_relative, "destination": target_relative},
    )
    try:
        _rename_on_disk(source, destination)
    except OSError as error:
        journal.fail(session, operation, _os_error_message(error))
        raise ConflictError(f"Could not rename {source_relative!r}.") from error

    try:
        updated = repoint_linked_rows(session, source=source_relative, destination=target_relative)
        journal.finish(session, operation, files_updated=updated)
    except Exception as error:  # metadata side failed after the file moved
        # The file is at its new path and the row still points at the old one.
        # Marking the operation failed is honest, and the scanner's moved-file
        # repair is precisely the mechanism that heals this state.
        journal.fail(session, operation, "metadata update failed after the file was renamed")
        raise ConflictError(
            f"{source_relative!r} was renamed on disk, but its metadata could not be updated. "
            "A scan will reconcile it."
        ) from error

    return OperationResult(operation=operation, path=target_relative, files_updated=updated)


def make_directory(session: Session, root: Path, *, path: str) -> OperationResult:
    """Create one new directory. Its parent must already exist."""
    try:
        relative = _normalized(path, what="path")
        name = validate_name(PurePosixPath(relative).name)
        parent_relative = parent_of(relative)
        # Re-validate the name in place: a caller could have sent a path whose
        # last segment is fine but whose parent segments are not.
        relative = join_relative(parent_relative, name)
        destination = resolve_writable(root, relative, what="path")
        parent = resolve_writable(root, parent_relative) if parent_relative else Path(root)
    except PathSafetyError as error:
        raise ValidationError(str(error)) from error

    if not parent.is_dir():
        raise NotFoundError(f"{parent_relative or '(library root)'} does not exist.")
    if os.path.lexists(destination):
        raise ConflictError(f"{relative!r} already exists.")

    operation = journal.begin(session, op=FileOpType.MKDIR, payload={"destination": relative})
    try:
        destination.mkdir()
    except OSError as error:
        journal.fail(session, operation, _os_error_message(error))
        raise ConflictError(f"Could not create {relative!r}.") from error

    journal.finish(session, operation)
    return OperationResult(operation=operation, path=relative, files_updated=0)


def undo(session: Session, root: Path, *, operation_id: str) -> OperationResult:
    """Apply an operation's inverse and mark it undone (ADR-0013 §3.1).

    Only a ``done`` operation can be undone, and only once. A failed operation
    has nothing to reverse; a pending one is the reconciler's business, not
    Undo's.
    """
    operation = journal.get_operation(session, operation_id)
    if operation is None:
        raise NotFoundError(f"operation {operation_id!r} not found")
    if operation.status is not FileOpStatus.DONE:
        raise ConflictError(f"This operation is {operation.status.value} and cannot be undone.")

    if operation.op is FileOpType.RENAME:
        result = rename(
            session,
            root,
            path=operation.payload["destination"],
            new_name=PurePosixPath(operation.payload["source"]).name,
        )
        # The inverse rename journaled an operation of its own; the honest
        # history is "this was undone", not "two renames happened".
        session.delete(result.operation)
        journal.mark_undone(session, operation)
        return OperationResult(
            operation=operation,
            path=operation.payload["source"],
            files_updated=result.files_updated,
        )

    if operation.op is FileOpType.MKDIR:
        relative = operation.payload["destination"]
        target = resolve_writable(root, relative)
        try:
            target.rmdir()
        except FileNotFoundError:
            pass  # already gone; the intended end state either way
        except OSError as error:
            raise ConflictError(
                f"{relative!r} is not empty, so removing it is no longer just an undo."
            ) from error
        journal.mark_undone(session, operation)
        return OperationResult(operation=operation, path=relative, files_updated=0)

    raise ConflictError(f"{operation.op.value} operations cannot be undone yet.")


def _normalized(path: str, *, what: str) -> str:
    if not path:
        raise PathSafetyError(f"{what} is empty")
    return normalize_relative_path(path)


def _noop(session: Session, relative: str) -> FileOperation:
    """A completed journal row for an operation that had nothing to do.

    Recorded rather than skipped so the caller always has an operation to point
    its toast at, and so the history shows the request that was made.
    """
    operation = journal.begin(
        session, op=FileOpType.RENAME, payload={"source": relative, "destination": relative}
    )
    return journal.finish(session, operation, files_updated=0)


def _rename_on_disk(source: Path, destination: Path) -> None:
    """``os.rename`` with the two cases that break it on real storage.

    A case-only rename on a case-insensitive filesystem (an SMB share from
    macOS, or APFS as usually formatted) sees source and destination as the
    *same* file: a plain rename is a silent no-op, and an existence check on the
    destination reports the source. Going via a temporary name makes it real.
    """
    if source == destination:
        return
    if str(source).lower() == str(destination).lower() and source.parent == destination.parent:
        staging = destination.with_name(f".cairndex-rename-{os.getpid()}-{destination.name}")
        os.rename(source, staging)
        try:
            os.rename(staging, destination)
        except OSError:
            os.rename(staging, source)  # put it back rather than leave a dotfile
            raise
        return
    os.rename(source, destination)


def _os_error_message(error: OSError) -> str:
    """A short reason without echoing an absolute server path back to a client."""
    return os.strerror(error.errno) if error.errno else "filesystem error"
