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
from datetime import timedelta
from pathlib import Path, PurePosixPath

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, FileOpStatus, FileOpType
from cairndex.file_ops import journal, trash
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
    ``Show/S01 extras/…``. ``autoescape`` matters: a path is LIKE-pattern data,
    and an unescaped ``_`` or ``%`` in a directory's own name would sweep
    sibling trees into the rename. The Python re-check keeps the SQL a pure
    narrowing step — no row is repointed on the pattern's say-so alone.
    """
    prefix = f"{relative_path}/"
    rows = session.scalars(
        select(AssetFile).where(
            (AssetFile.relative_path == relative_path)
            | (AssetFile.relative_path.startswith(prefix, autoescape=True))
        )
    )
    return [
        row
        for row in rows
        if row.relative_path == relative_path or row.relative_path.startswith(prefix)
    ]


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
    if not settled.replace:
        _ensure_no_linked_conflict(session, target_relative)

    operation = journal.begin(
        session,
        op=FileOpType.RENAME,
        payload={"source": source_relative, "destination": target_relative},
    )
    if settled.replace:
        # Trash-then-write (ADR-0013 §3.3): the displaced entry is deleted to the
        # trash *as its own trash operation*, and this rename records which one.
        # Making it a real deletion rather than a footnote in the rename's
        # payload is what puts it in the Trash view, restorable on its own, and
        # emptied by the same sweep as everything else — one concept, one code
        # path. Undoing this rename restores that operation.
        try:
            displaced = trash_paths(session, root, paths=[target_relative])
            journal.finish_payload(session, operation, replaced_operation_id=displaced.operation.id)
        except (OSError, ConflictError) as error:
            journal.fail(
                session,
                operation,
                _os_error_message(error) if isinstance(error, OSError) else str(error),
            )
            raise ConflictError(f"Could not move the existing {name!r} to the trash.") from error

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


def mark_rows_trashed(
    session: Session, operation_id: str, entry: trash.TrashedEntry
) -> list[trash.TrashedEntry]:
    """Flip every linked row at or under a trashed path, keeping their ids.

    Each row's ``relative_path`` moves to its location inside the trash, because
    that is where the bytes now are — and because leaving the original path
    occupied would stop anything else taking it, which is precisely what Replace
    needs to do next.
    """
    rows = _linked_rows_under(session, entry.original_path)
    if not rows:
        return [entry]

    recorded: list[trash.TrashedEntry] = []
    for row in rows:
        original = row.relative_path
        row.relative_path = trash.stored_relative_path(operation_id, original)
        row.availability = FileAvailability.TRASHED
        recorded.append(
            trash.TrashedEntry(
                original_path=original,
                stored_path=row.relative_path,
                file_id=row.id,
                is_directory=False,
            )
        )
    session.flush()
    # A trashed directory is one entry for the filesystem and N for the metadata:
    # restoring moves the directory back in one rename, but every row underneath
    # has to be repointed, so both are recorded.
    return [entry, *recorded] if entry.is_directory else recorded


def trash_paths(session: Session, root: Path, *, paths: list[str]) -> OperationResult:
    """Move files and directories into the library's trash (ADR-0013 §3.2).

    Never unlinks. Every id, bundle membership, cover, subtitle link and cache
    entry survives, so restore is lossless — the row stays, flipped to
    ``trashed``. A directory is trashed whole, under one operation, preserving
    its shape for restore.
    """
    if not paths:
        raise ValidationError("nothing to move to the trash")

    targets: list[str] = []
    for raw in paths:
        try:
            relative = _normalized(raw, what="path")
            resolved = resolve_writable(root, relative, what="path")
        except PathSafetyError as error:
            raise ValidationError(str(error)) from error
        if not os.path.lexists(resolved):
            raise NotFoundError(f"{relative!r} does not exist.")
        targets.append(relative)

    # Deleting a folder and something inside it in one gesture is an ordinary
    # multi-select. Dropping the children keeps the trash a faithful tree and
    # stops the second move failing on a path the first one already took away.
    targets = _drop_nested(targets)

    operation = journal.begin(session, op=FileOpType.TRASH, payload={"paths": targets})
    entries: list[trash.TrashedEntry] = []
    try:
        for relative in targets:
            moved = trash.move_into_trash(root, operation_id=operation.id, original_path=relative)
            entries.extend(mark_rows_trashed(session, operation.id, moved))
    except OSError as error:
        journal.fail(session, operation, _os_error_message(error))
        raise ConflictError("Could not move everything to the trash.") from error
    trash.write_meta(root, operation_id=operation.id, entries=entries)

    journal.finish(
        session,
        operation,
        entries=[entry.as_payload() for entry in entries],
        files_updated=sum(1 for entry in entries if entry.file_id),
    )
    return OperationResult(
        operation=operation,
        path=targets[0],
        files_updated=sum(1 for entry in entries if entry.file_id),
    )


def restore(session: Session, root: Path, *, operation_id: str) -> OperationResult:
    """Put a trashed operation's entries back where they came from."""
    operation = journal.get_operation(session, operation_id)
    if operation is None or operation.op is not FileOpType.TRASH:
        raise NotFoundError(f"trashed operation {operation_id!r} not found")
    if operation.status is not FileOpStatus.DONE:
        raise ConflictError(f"This deletion is {operation.status.value} and cannot be restored.")

    entries = [trash.entry_from_payload(item) for item in operation.payload.get("entries", [])]
    restored = _restore_entries(session, root, entries)

    trash.prune_operation_dir(root, operation_id)
    journal.mark_undone(session, operation)
    return OperationResult(
        operation=operation,
        path=entries[0].original_path if entries else "",
        files_updated=restored,
    )


def _restore_entries(session: Session, root: Path, entries: list[trash.TrashedEntry]) -> int:
    """Move entries back and re-point their rows. Shared by restore and undo."""
    _ensure_restorable(session, root, entries)

    for entry in _directories_first(entries):
        if not os.path.lexists(root / entry.stored_path):
            continue  # already back, e.g. carried by its restored parent directory
        try:
            trash.restore_from_trash(root, entry)
        except OSError as error:
            raise ConflictError(f"Could not restore {entry.original_path!r}.") from error

    restored = 0
    for entry in entries:
        if entry.file_id is None:
            continue
        row = session.get(AssetFile, entry.file_id)
        if row is None:
            continue
        row.relative_path = entry.original_path
        row.availability = FileAvailability.AVAILABLE
        restored += 1
    session.flush()
    return restored


def empty_trash(session: Session, root: Path, *, older_than_days: int | None = None) -> int:
    """Unlink trashed entries for good and drop their rows. The one-way door.

    Returns the number of operations emptied. ``older_than_days`` keeps recent
    deletions — the retention sweep — and defaults to emptying everything,
    because that is what pressing Empty Trash means.
    """
    cutoff = (
        utcnow() - timedelta(days=older_than_days)
        if older_than_days is not None and older_than_days > 0
        else None
    )
    emptied = 0
    for operation in journal.trashed_operations(session):
        finished = operation.finished_at
        if cutoff is not None and finished is not None and finished > cutoff:
            continue
        entries = [trash.entry_from_payload(item) for item in operation.payload.get("entries", [])]
        for entry in entries:
            trash.delete_permanently(root, entry)
            if entry.file_id is None:
                continue
            row = session.get(AssetFile, entry.file_id)
            if row is not None:
                # Metadata deletion, finally — separate from the physical
                # unlink above, and reached only through this explicit action
                # (AGENTS.md: metadata removal and file deletion stay distinct).
                session.delete(row)
        trash.prune_operation_dir(root, operation.id)
        operation.status = FileOpStatus.EMPTIED
        emptied += 1
    session.commit()
    return emptied


def list_trash(session: Session) -> list[tuple[FileOperation, list[trash.TrashedEntry]]]:
    """Everything currently recoverable, newest deletion first."""
    return [
        (operation, [trash.entry_from_payload(e) for e in operation.payload.get("entries", [])])
        for operation in journal.trashed_operations(session)
    ]


def _drop_nested(paths: list[str]) -> list[str]:
    """Remove paths already covered by an ancestor in the same request."""
    ordered = sorted(dict.fromkeys(paths))
    kept: list[str] = []
    for path in ordered:
        if any(path == parent or path.startswith(f"{parent}/") for parent in kept):
            continue
        kept.append(path)
    return kept


def _directories_first(entries: list[trash.TrashedEntry]) -> list[trash.TrashedEntry]:
    """Restore a directory before the files recorded inside it.

    Moving the directory back carries its contents in one rename; the file
    entries are then already home and skipped. The reverse order would restore
    files into a path their parent is about to take.
    """
    return sorted(entries, key=lambda entry: (not entry.is_directory, entry.original_path))


def _ensure_restorable(session: Session, root: Path, entries: list[trash.TrashedEntry]) -> None:
    """Refuse a restore whose destination is occupied, before moving anything.

    Half a restore is worse than none: the owner would have to work out which
    files came back. Checked against both the filesystem and the linked rows,
    because either can hold the path.
    """
    for entry in _directories_first(entries):
        destination = root / entry.original_path
        if os.path.lexists(destination):
            # A file inside a directory that is itself being restored is fine —
            # its parent brought it back already.
            if any(
                other.is_directory and entry.original_path.startswith(f"{other.original_path}/")
                for other in entries
            ):
                continue
            raise ConflictError(
                f"Something is already at {entry.original_path!r}. "
                "Rename or move it, then restore again."
            )
        taken = session.scalar(
            select(AssetFile.id).where(AssetFile.relative_path == entry.original_path)
        )
        if taken is not None and taken != entry.file_id:
            raise ConflictError(f"Another file is already recorded at {entry.original_path!r}.")


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

    if operation.op is FileOpType.TRASH:
        # Undoing a deletion *is* restoring it — same inverse, same journal row.
        return restore(session, root, operation_id=operation_id)

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
        # A Replace deleted something to the trash first. Undoing the rename
        # without restoring it would leave the owner with neither file where
        # they expected it — recoverable, but silently.
        replaced_id = operation.payload.get("replaced_operation_id")
        if replaced_id:
            restore(session, root, operation_id=str(replaced_id))
        journal.mark_undone(session, operation)
        return OperationResult(
            operation=operation,
            path=operation.payload["source"],
            files_updated=result.files_updated,
        )

    if operation.op is FileOpType.IMPORT:
        # Undoing an import deletes the file it created — to the trash, not with
        # an unlink, so "undo" is never the one action in the app that destroys
        # something. If the import replaced a file, that one comes back too.
        relative = operation.payload["destination"]
        if os.path.lexists(root / relative):
            trash_paths(session, root, paths=[relative])
        replaced_id = operation.payload.get("replaced_operation_id")
        if replaced_id:
            restore(session, root, operation_id=str(replaced_id))
        journal.mark_undone(session, operation)
        return OperationResult(operation=operation, path=relative, files_updated=0)

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
