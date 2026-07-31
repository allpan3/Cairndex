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
from dataclasses import dataclass, field, replace
from datetime import timedelta
from pathlib import Path, PurePosixPath

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, FileOpStatus, FileOpType
from cairndex.domain.file_names import display_title_after_move
from cairndex.file_ops import fsmove, journal, trash
from cairndex.file_ops.conflicts import ConflictPolicy, resolve_collision
from cairndex.file_ops.paths import join_relative, parent_of, resolve_writable, validate_name
from cairndex.persistence.models import AssetBundle, AssetFile, FileOperation


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
    # Paths a multi-item operation could not act on — a permissions error on one
    # file of a multi-select delete, say. The operation still *completed* for
    # everything else, which is why this is a field on a success rather than an
    # exception: the alternative loses the items that did move.
    failed_paths: list[str] = field(default_factory=list)


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

    The shown name follows the rename under the rule in
    ``domain.file_names.display_title_after_move``, which the scanner's own
    repoint paths share. ``original_filename`` deliberately does *not* move: it
    records what the file was called when it entered the library, which is the
    whole point of keeping it separately.
    """
    rows = _linked_rows_under(session, source)
    for row in rows:
        moved_to = (
            destination
            if row.relative_path == source
            else destination + row.relative_path[len(source) :]
        )
        row.display_title = display_title_after_move(
            display_title=row.display_title, old_path=row.relative_path, new_path=moved_to
        )
        row.relative_path = moved_to
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
            operation=_noop(session, source_relative, skipped=True),
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


def move(
    session: Session,
    root: Path,
    *,
    paths: list[str],
    dest_dir: str,
    on_conflict: ConflictPolicy = ConflictPolicy.FAIL,
) -> OperationResult:
    """Move files and directories into another directory, carrying their metadata.

    A move is a rename that changes the *parent* instead of the name, so it
    inherits rename's central property: each entry keeps its ``AssetFile.id``, so
    bundle membership, covers, subtitle links and cache identity survive by
    construction rather than by later repair. A directory moves whole, one
    operation repointing every row beneath it.

    The whole multi-select is **one journal operation with one undo**. Collisions
    are resolved *before* the disk is touched, so a ``fail`` answer moves nothing
    and the client can ask; ``skip``/``suffix``/``replace`` settle per entry. Like
    a multi-file delete, a per-file filesystem error is tolerated: the entries
    that moved are recorded and the ones that did not are reported, because
    failing the whole operation would lose track of what already moved.
    """
    if not paths:
        raise ValidationError("nothing to move")

    # The destination is an *existing* directory (New Folder is its own
    # operation) or the library root. Empty means the root, which normalizing
    # would reject, so it is handled before the validator sees it.
    try:
        dest_relative = normalize_relative_path(dest_dir) if dest_dir else ""
        dest_full = (
            resolve_writable(root, dest_relative, what="destination")
            if dest_relative
            else Path(root)
        )
    except PathSafetyError as error:
        raise ValidationError(str(error)) from error
    if not dest_full.is_dir():
        raise NotFoundError(f"{dest_relative or '(library root)'} is not a directory.")

    sources: list[str] = []
    for raw in paths:
        try:
            relative = _normalized(raw, what="source")
            resolved = resolve_writable(root, relative, what="source")
        except PathSafetyError as error:
            raise ValidationError(str(error)) from error
        if not os.path.lexists(resolved):
            raise NotFoundError(f"{relative!r} does not exist.")
        sources.append(relative)

    # Moving a folder and something already inside it in one gesture: the child
    # rides along with the parent, so dropping it keeps the batch a faithful set
    # and stops a second move failing on a path the first already carried away.
    sources = _drop_nested(sources)

    # Phase 1 — decide everything before touching the disk. A `fail` collision
    # raises here, having moved nothing, which is what lets the client ask.
    planned: list[tuple[str, str, bool]] = []  # (source, destination, replace)
    claimed: set[str] = set()
    skipped_any = False
    for source_relative in sources:
        source_full = resolve_writable(root, source_relative, what="source")
        name = PurePosixPath(source_relative).name
        destination = join_relative(dest_relative, name)
        if destination == source_relative:
            continue  # already in this directory; nothing to do
        is_directory = source_full.is_dir() and not source_full.is_symlink()
        if is_directory and (
            dest_relative == source_relative or dest_relative.startswith(f"{source_relative}/")
        ):
            # A directory cannot become its own descendant; the rename would
            # either fail deep in the kernel or, worse, succeed into a loop.
            raise ValidationError(f"Cannot move {name!r} into itself.")
        settled = resolve_collision(
            root, relative_path=destination, policy=on_conflict, name=name, parent=dest_relative
        )
        if settled.skip:
            skipped_any = True
            continue
        destination = settled.relative_path
        if destination in claimed:
            # Two selected items with the same name bound for one directory. The
            # second would clobber the first on disk — the one outcome the "never
            # overwrite" rule forbids — so refuse the batch rather than pick a
            # winner. (Auto-suffixing within a batch is a W6 refinement.)
            raise ValidationError(
                f"More than one selected item would be named {name!r} in the destination."
            )
        if not settled.replace:
            _ensure_no_linked_conflict(session, destination)
        claimed.add(destination)
        planned.append((source_relative, destination, settled.replace))

    if not planned:
        # Everything was already in place or skipped; there is nothing to move,
        # but the caller still needs an operation to point its toast at.
        operation = journal.begin(
            session,
            op=FileOpType.MOVE,
            payload={
                "dest_dir": dest_relative,
                "moves": [],
                **({"skipped": True} if skipped_any else {}),
            },
        )
        journal.finish(session, operation, files_updated=0)
        return OperationResult(
            operation=operation, path=dest_relative, files_updated=0, skipped=skipped_any
        )

    operation = journal.begin(
        session,
        op=FileOpType.MOVE,
        payload={
            "dest_dir": dest_relative,
            "moves": [{"source": src, "destination": dst} for src, dst, _ in planned],
        },
    )

    # Phase 2 — perform. Each move is tolerated on its own: an OSError on one
    # (a permissions wall on a share, a cross-device boundary) records the file
    # as unmoved and carries on, rather than abandoning the ones already moved.
    performed: list[dict[str, str]] = []
    failed: list[str] = []
    error_reason = ""
    total_updated = 0
    try:
        for source_relative, destination, replace in planned:
            replaced_operation_id = ""
            try:
                if replace:
                    # Trash-then-write (ADR-0013 §3.3): the displaced entry is
                    # deleted as its own trash operation, so it lands in the Trash
                    # view and undoing this move restores it.
                    displaced = trash_paths(session, root, paths=[destination])
                    replaced_operation_id = displaced.operation.id
                source_full = resolve_writable(root, source_relative, what="source")
                destination_full = resolve_writable(root, destination, what="destination")
                _rename_on_disk(source_full, destination_full)
            except (OSError, ConflictError) as error:
                failed.append(source_relative)
                error_reason = error_reason or (
                    _os_error_message(error) if isinstance(error, OSError) else str(error)
                )
                continue
            total_updated += repoint_linked_rows(
                session, source=source_relative, destination=destination
            )
            entry = {"source": source_relative, "destination": destination}
            if replaced_operation_id:
                entry["replaced_operation_id"] = replaced_operation_id
            performed.append(entry)
    except Exception as error:  # metadata side failed after a file moved
        journal.fail(session, operation, "metadata update failed after a file was moved")
        raise ConflictError(
            "Some files were moved on disk, but their metadata could not be updated. "
            "A scan will reconcile them."
        ) from error

    if not performed:
        journal.fail(session, operation, error_reason or "nothing could be moved")
        raise ConflictError("Could not move anything.")

    journal.finish(
        session,
        operation,
        moves=performed,
        files_updated=total_updated,
        **({"failed_paths": failed, "error": error_reason} if failed else {}),
    )
    return OperationResult(
        operation=operation,
        path=performed[0]["destination"],
        files_updated=total_updated,
        failed_paths=failed,
    )


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
                size_bytes=row.size_bytes if row.size_bytes is not None else entry.size_bytes,
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
    failed: list[str] = []
    error_reason = ""

    for relative in targets:
        try:
            moved = trash.move_into_trash(root, operation_id=operation.id, original_path=relative)
        except OSError as error:
            # Keep going rather than abandoning the operation. Failing the whole
            # thing here would mark the journal row `failed` and roll back the
            # rows — while the entries moved *before* this one are already inside
            # the trash directory, listed by nothing, restorable by nothing, and
            # pruned by nothing. That is the exact state the reconciler exists to
            # prevent, and the reconciler only ever looks at `pending` rows, so
            # nothing would come along later and notice.
            failed.append(relative)
            error_reason = error_reason or _os_error_message(error)
            continue
        entries.extend(mark_rows_trashed(session, operation.id, moved))

    if not entries:
        journal.fail(session, operation, error_reason or "nothing could be moved to the trash")
        raise ConflictError("Could not move anything to the trash.")

    trash.write_meta(root, operation_id=operation.id, entries=entries)
    moved_count = sum(1 for entry in entries if entry.file_id)
    journal.finish(
        session,
        operation,
        entries=[entry.as_payload() for entry in entries],
        files_updated=moved_count,
        # Recorded on the row, so the history says which items this deletion did
        # not manage to take rather than quietly claiming all of them.
        **({"failed_paths": failed, "error": error_reason} if failed else {}),
    )
    return OperationResult(
        operation=operation,
        path=entries[0].original_path,
        files_updated=moved_count,
        failed_paths=failed,
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
    # Bundles that lose a file here, checked afterwards for having lost their last
    # one. Collected rather than acted on inline because a bundle's files can be
    # spread across several trash operations.
    touched_bundles: set[str] = set()
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
                touched_bundles.add(row.bundle_id)
                session.delete(row)
        trash.prune_operation_dir(root, operation.id)
        operation.status = FileOpStatus.EMPTIED
        emptied += 1
    session.flush()
    _drop_bundles_emptied_of_files(session, touched_bundles)
    session.commit()
    return emptied


def _drop_bundles_emptied_of_files(session: Session, bundle_ids: set[str]) -> None:
    """Remove bundles whose last file was just permanently deleted.

    "Delete this bundle and its files" leaves the bundle in place so Put back can
    return it whole (see the delete-with-files route); emptying the trash is where
    that deletion becomes final, so the husk has to go with the bytes. Without
    this it would reappear in browse the moment its last file stopped being
    hidden-by-being-trashed — an empty bundle the owner had already deleted.

    Scoped to bundles this emptying actually touched, so a deliberately empty
    bundle (New Empty Bundle, nothing added yet) is never swept up by it.
    """
    for bundle_id in bundle_ids:
        bundle = session.get(AssetBundle, bundle_id)
        if bundle is None:
            continue
        remaining = session.scalar(
            select(func.count()).select_from(AssetFile).where(AssetFile.bundle_id == bundle_id)
        )
        if not remaining:
            session.delete(bundle)
    session.flush()


def list_trash(session: Session) -> list[tuple[FileOperation, list[trash.TrashedEntry]]]:
    """Everything recoverable, with sizes from journal or linked metadata only."""
    listed = [
        (operation, [trash.entry_from_payload(e) for e in operation.payload.get("entries", [])])
        for operation in journal.trashed_operations(session)
    ]
    legacy_file_ids = {
        entry.file_id
        for _operation, entries in listed
        for entry in entries
        if entry.size_bytes is None and entry.file_id is not None
    }
    legacy_sizes: dict[str, int | None] = (
        {
            file_id: size_bytes
            for file_id, size_bytes in session.execute(
                select(AssetFile.id, AssetFile.size_bytes).where(AssetFile.id.in_(legacy_file_ids))
            )
        }
        if legacy_file_ids
        else {}
    )
    return [
        (
            operation,
            [
                replace(entry, size_bytes=legacy_sizes.get(entry.file_id))
                if entry.size_bytes is None and entry.file_id is not None
                else entry
                for entry in entries
            ],
        )
        for operation, entries in listed
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


def _replaced_operation_ids(operation: FileOperation) -> list[str]:
    """Every trash operation this one displaced a file into, for undo's sake.

    A rename or import displaces at most one file and records it at the top of
    the payload; a move can displace one per entry and records them inside
    ``moves``. Undo has to check and restore all of them.
    """
    ids: list[str] = []
    top = operation.payload.get("replaced_operation_id")
    if top:
        ids.append(str(top))
    for move in operation.payload.get("moves", []):
        replaced = move.get("replaced_operation_id")
        if replaced:
            ids.append(str(replaced))
    return ids


def _ensure_move_reversible(session: Session, root: Path, moves: list[dict[str, str]]) -> None:
    """Refuse a move-undo whose source path is now occupied, before moving anything.

    Undo moves each entry from its destination back to its source with a plain
    rename, which on POSIX silently clobbers whatever now sits at the source —
    a file imported, copied, or re-downloaded there in the meantime. Every
    sibling inverse guards against exactly this (undo-of-rename through the
    collision policy, restore through :func:`_ensure_restorable`); move is the
    one that must not be the exception. So the source of every entry that would
    actually move back — its destination still in place — is checked against
    both the filesystem and the linked rows, all-or-nothing and up front, and
    the whole undo is refused if any is taken.
    """
    for entry in moves:
        source = entry.get("source")
        destination = entry.get("destination")
        if not source or not destination:
            continue
        if not os.path.lexists(resolve_writable(root, destination)):
            # This entry will not move back (its file is already gone from the
            # destination), so nothing would be clobbered at its source.
            continue
        if os.path.lexists(resolve_writable(root, source)):
            raise ConflictError(
                f"Something is already at {source!r}, so this move can no longer be undone. "
                "Move or rename it, then undo again."
            )
        taken = session.scalar(select(AssetFile.id).where(AssetFile.relative_path == source))
        if taken is not None:
            raise ConflictError(f"Another file is already recorded at {source!r}.")


def _ensure_replacement_restorable(session: Session, operation: FileOperation) -> None:
    """Refuse an undo whose Replace can no longer be completed.

    An operation that displaced a file recorded the deletion that holds it. If
    that deletion has since been emptied, the displaced file is gone for good —
    and there is no version of "undo" worth performing, because putting the
    incoming file back where it came from would leave the destination empty
    while the journal still advertised the operation as undoable.
    """
    for replaced_id in _replaced_operation_ids(operation):
        replaced = journal.get_operation(session, replaced_id)
        if replaced is None:
            raise ConflictError(
                "The file this replaced can no longer be found, so this cannot be undone."
            )
        if replaced.status is not FileOpStatus.DONE:
            raise ConflictError(
                "The file this replaced was permanently deleted, so this can no longer be undone."
            )


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
    if operation.payload.get("skipped"):
        # A skipped operation wrote nothing, so its "destination" names a file
        # that was already there and has nothing to do with it. Reversing it
        # would move a bystander to the trash.
        raise ConflictError("This operation was skipped, so there is nothing to undo.")
    # Checked *before* anything is touched. Undo must not half-execute: if the
    # file a Replace displaced was permanently deleted, reversing the rename
    # alone would leave the destination empty and the journal still claiming the
    # operation is undoable, with the next attempt failing on a missing source.
    _ensure_replacement_restorable(session, operation)

    if operation.op is FileOpType.TRASH:
        # Undoing a deletion *is* restoring it — same inverse, same journal row.
        return restore(session, root, operation_id=operation_id)

    if operation.op is FileOpType.MOVE:
        # Move each entry back where it came from, in reverse so a directory is
        # returned before anything that rode out inside it. A Replace displaced a
        # file into the trash first; once our file is back out of that path,
        # restoring the displaced one puts it home too.
        _ensure_move_reversible(session, root, operation.payload.get("moves", []))
        moved_back = 0
        for entry in reversed(operation.payload.get("moves", [])):
            source = entry["source"]
            destination = entry["destination"]
            destination_full = resolve_writable(root, destination)
            if os.path.lexists(destination_full):
                try:
                    _rename_on_disk(destination_full, resolve_writable(root, source))
                except OSError as error:
                    raise ConflictError(f"Could not move {destination!r} back.") from error
                moved_back += repoint_linked_rows(session, source=destination, destination=source)
            replaced_id = entry.get("replaced_operation_id")
            if replaced_id:
                restore(session, root, operation_id=str(replaced_id))
        journal.mark_undone(session, operation)
        return OperationResult(
            operation=operation,
            path=operation.payload.get("dest_dir", ""),
            files_updated=moved_back,
        )

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


def _noop(session: Session, relative: str, *, skipped: bool = False) -> FileOperation:
    """A completed journal row for an operation that had nothing to do.

    Recorded rather than skipped so the caller always has an operation to point
    its toast at, and so the history shows the request that was made. ``skipped``
    marks the collision case specifically, which is what stops Undo treating the
    destination — a file this operation never touched — as its own to reverse.
    """
    operation = journal.begin(
        session,
        op=FileOpType.RENAME,
        payload={
            "source": relative,
            "destination": relative,
            **({"skipped": True} if skipped else {}),
        },
    )
    return journal.finish(session, operation, files_updated=0)


def _rename_on_disk(source: Path, destination: Path) -> None:
    """Relocate one path, handling case-only renames and cross-device moves.

    See :mod:`cairndex.file_ops.fsmove` for what those two cases are and why a
    plain ``os.rename`` is not enough for either.
    """
    fsmove.move_path(source, destination)


def _os_error_message(error: OSError) -> str:
    """A short reason without echoing an absolute server path back to a client."""
    return os.strerror(error.errno) if error.errno else "filesystem error"
