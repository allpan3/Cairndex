"""Guarded file operations inside a library root (ADR-0013 §4, plan 4 W1/W4).

Every *write* route here declares ``WriteModeRequired`` alongside its session,
so the gate is a property of the route rather than something each handler
remembers to check: a library with write mode off answers 403
``write_mode_disabled`` before any handler code runs.

Two routes deliberately do **not** declare it — the journal listing and the
trash listing. Both describe state the library already has, and hiding them
when the capability is off would make past operations invisible and trashed
files look permanently gone. Reading what happened is not writing.

Rename, New Folder, import, delete-to-trash, restore, Empty Trash, and Undo
are here; move (W3) attaches the same way.
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request, status

from cairndex.api.deps import LibrarySession, WriteModeRequired
from cairndex.api.schemas.file_ops import (
    EmptyTrashRequest,
    EmptyTrashResult,
    FileOperationPage,
    FileOperationRead,
    FileOperationResult,
    ImportResultRead,
    MakeDirectoryRequest,
    RenameRequest,
    TrashedEntryRead,
    TrashedOperationRead,
    TrashRead,
    TrashRequest,
)
from cairndex.file_ops import imports, journal, operations, trash
from cairndex.file_ops.conflicts import ConflictPolicy
from cairndex.persistence.engine import library_root_for_session
from cairndex.services.pagination import DEFAULT_LIMIT, MAX_LIMIT

router = APIRouter(prefix="/libraries/{library_id}/file-ops", tags=["file-ops"])


def _result(outcome: operations.OperationResult) -> FileOperationResult:
    return FileOperationResult(
        operation=FileOperationRead.model_validate(outcome.operation),
        path=outcome.path,
        files_updated=outcome.files_updated,
        skipped=outcome.skipped,
        failed_paths=outcome.failed_paths,
    )


@router.post("/rename", response_model=FileOperationResult, status_code=status.HTTP_200_OK)
def rename_entry(
    payload: RenameRequest, db: LibrarySession, _gate: WriteModeRequired
) -> FileOperationResult:
    """Rename one file or directory, carrying its metadata with it.

    The rename and the `AssetFile.relative_path` update happen together, so
    every id — and therefore every bundle membership, cover, subtitle link and
    cached thumbnail — survives by construction rather than by later repair.
    Renaming a directory repoints everything beneath it in the same operation.

    A destination that already exists answers 409 `conflict`, which the client
    turns into the Replace / Skip / Keep both prompt and re-issues with an
    explicit `on_conflict`.
    """
    return _result(
        operations.rename(
            db,
            library_root_for_session(db),
            path=payload.path,
            new_name=payload.new_name,
            on_conflict=payload.on_conflict,
        )
    )


@router.post("/mkdir", response_model=FileOperationResult, status_code=status.HTTP_201_CREATED)
def make_directory(
    payload: MakeDirectoryRequest, db: LibrarySession, _gate: WriteModeRequired
) -> FileOperationResult:
    """Create one new directory. Its parent must already exist."""
    return _result(operations.make_directory(db, library_root_for_session(db), path=payload.path))


@router.post("/import", response_model=ImportResultRead, status_code=status.HTTP_201_CREATED)
async def import_file(
    request: Request,
    db: LibrarySession,
    _gate: WriteModeRequired,
    dest_dir: Annotated[str, Query()] = "",
    filename: Annotated[str, Query(min_length=1, max_length=255)] = "",
    on_conflict: Annotated[ConflictPolicy, Query()] = ConflictPolicy.FAIL,
    link: Annotated[bool, Query()] = False,
) -> ImportResultRead:
    """Stream one external file into this library — the only way bytes enter it.

    **The body is the file**, raw, with the metadata in query parameters.
    Deliberately not multipart: the caller already has an open file handle or a
    `File` object, both of which stream as a body without an encoding step, and
    it keeps the server free of a form-parsing dependency for a request that is
    99.99% payload. One file per request, so each import gets its own progress,
    its own collision answer, and its own undo.

    The server never reads a path the client names — it cannot: there is no path
    in this request, only bytes.
    """
    result = await imports.import_stream(
        db,
        library_root_for_session(db),
        dest_dir=dest_dir,
        filename=filename,
        body=request.stream(),
        on_conflict=on_conflict,
        link=link,
    )
    return ImportResultRead(
        operation=FileOperationRead.model_validate(result.operation.operation),
        path=result.operation.path,
        files_updated=result.operation.files_updated,
        skipped=result.operation.skipped,
        failed_paths=result.operation.failed_paths,
        size_bytes=result.size_bytes,
    )


@router.post("/trash", response_model=FileOperationResult)
def trash_entries(
    payload: TrashRequest, db: LibrarySession, _gate: WriteModeRequired
) -> FileOperationResult:
    """Move files and folders into the library's trash — never unlink them.

    The entries are renamed into `.cairndex/trash/{operation_id}/`, which is on
    the same filesystem (so it is instant even for large videos) and inside the
    library package (so it travels with it). Linked rows keep their ids and
    become `trashed`, which is why restoring is lossless rather than a re-scan.
    """
    return _result(operations.trash_paths(db, library_root_for_session(db), paths=payload.paths))


@router.get("/trash", response_model=TrashRead)
def read_trash(db: LibrarySession) -> TrashRead:
    """List everything currently recoverable.

    Readable without write mode, like the journal: what is *in* the trash is
    part of the library's state, and hiding it when the capability is off would
    make files look permanently gone when they are not.
    """
    root = library_root_for_session(db)
    return TrashRead(
        operations=[
            TrashedOperationRead(
                operation_id=operation.id,
                deleted_at=operation.finished_at,
                entries=[
                    TrashedEntryRead(
                        original_path=entry.original_path,
                        name=entry.original_path.rsplit("/", 1)[-1],
                        file_id=entry.file_id,
                        is_directory=entry.is_directory,
                        size_bytes=_size_of(root / entry.stored_path),
                    )
                    for entry in entries
                ],
            )
            for operation, entries in operations.list_trash(db)
        ],
        size_bytes=trash.size_on_disk(root),
    )


@router.post("/trash/restore/{operation_id}", response_model=FileOperationResult)
def restore_from_trash(
    operation_id: str, db: LibrarySession, _gate: WriteModeRequired
) -> FileOperationResult:
    """Put one deletion's entries back where they came from.

    Refused as a whole if anything now occupies one of those paths: half a
    restore would leave the owner to work out which files came back.
    """
    return _result(operations.restore(db, library_root_for_session(db), operation_id=operation_id))


@router.post("/trash/empty", response_model=EmptyTrashResult)
def empty_trash(
    payload: EmptyTrashRequest, db: LibrarySession, _gate: WriteModeRequired
) -> EmptyTrashResult:
    """Permanently delete trashed entries and their metadata rows.

    **The only operation in write mode with no way back.** Everything else —
    rename, New Folder, delete, even Replace — is recoverable until this runs.
    """
    emptied = operations.empty_trash(
        db, library_root_for_session(db), older_than_days=payload.older_than_days
    )
    return EmptyTrashResult(operations_emptied=emptied)


def _size_of(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


@router.post("/{operation_id}/undo", response_model=FileOperationResult)
def undo_operation(
    operation_id: str, db: LibrarySession, _gate: WriteModeRequired
) -> FileOperationResult:
    """Apply an operation's inverse — the Undo behind every completed toast.

    Only a completed operation can be undone, and only once; the journal row is
    marked `undone` rather than deleted, so the history still explains how the
    library reached its current shape.
    """
    return _result(operations.undo(db, library_root_for_session(db), operation_id=operation_id))


@router.get("", response_model=FileOperationPage)
def list_operations(
    db: LibrarySession,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    before: Annotated[str | None, Query()] = None,
) -> FileOperationPage:
    """Newest-first history of what write mode has done to this library.

    Readable without write mode: turning the capability off must not hide what
    it did while it was on.
    """
    rows = journal.list_operations(db, limit=limit + 1, before_id=before)
    page = rows[:limit]
    return FileOperationPage(
        operations=[FileOperationRead.model_validate(row) for row in page],
        next_cursor=page[-1].id if len(rows) > limit and page else None,
    )
