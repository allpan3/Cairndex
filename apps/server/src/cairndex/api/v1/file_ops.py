"""Guarded file operations inside a library root (ADR-0013 §4, plan 4 W1).

Every route here declares ``WriteModeRequired`` alongside its session, so the
gate is a property of the route rather than something each handler remembers to
check: a library with write mode off answers 403 ``write_mode_disabled`` before
any handler code runs.

W1 ships the two operations that create no risk of losing bytes — rename and New
Folder — plus Undo and the journal history. Move, trash, and import follow in
later slices and attach here.
"""

from typing import Annotated

from fastapi import APIRouter, Query, status

from cairndex.api.deps import LibrarySession, WriteModeRequired
from cairndex.api.schemas.file_ops import (
    FileOperationPage,
    FileOperationRead,
    FileOperationResult,
    MakeDirectoryRequest,
    RenameRequest,
)
from cairndex.file_ops import journal, operations
from cairndex.persistence.engine import library_root_for_session
from cairndex.services.pagination import DEFAULT_LIMIT, MAX_LIMIT

router = APIRouter(prefix="/libraries/{library_id}/file-ops", tags=["file-ops"])


def _result(outcome: operations.OperationResult) -> FileOperationResult:
    return FileOperationResult(
        operation=FileOperationRead.model_validate(outcome.operation),
        path=outcome.path,
        files_updated=outcome.files_updated,
        skipped=outcome.skipped,
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
