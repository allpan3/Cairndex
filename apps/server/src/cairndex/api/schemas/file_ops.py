"""Guarded file-operation schemas (ADR-0013 §4)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import FileOpStatus, FileOpType
from cairndex.file_ops.conflicts import ConflictPolicy


class RenameRequest(BaseModel):
    """Rename one file or directory in place."""

    # Library-relative POSIX path. Absolute paths, traversal, and anything inside
    # `.cairndex/` are rejected server-side (ADR-0013 §3.3).
    path: str = Field(min_length=1)
    # A single filename, not a path: renaming never moves an entry.
    new_name: str = Field(min_length=1, max_length=255)
    on_conflict: ConflictPolicy = ConflictPolicy.FAIL


class MakeDirectoryRequest(BaseModel):
    """Create one new directory at a library-relative path."""

    path: str = Field(min_length=1)


class FileOperationRead(BaseModel):
    """One journal entry, as the history view and Undo need it."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    op: FileOpType
    status: FileOpStatus
    # Operation-specific parameters plus its inverse; shape varies by `op`.
    payload: dict[str, object]
    error: str | None
    created_at: datetime
    finished_at: datetime | None


class FileOperationResult(BaseModel):
    """What an operation did, for the toast that offers to undo it."""

    operation: FileOperationRead
    # Where the entry ended up — not always what was asked for, when "keep both"
    # settled on a different name.
    path: str
    # Linked rows repointed, all keeping their ids. Zero is normal.
    files_updated: int
    # True when a `skip` policy meant nothing happened.
    skipped: bool


class FileOperationPage(BaseModel):
    """Newest-first page of the journal."""

    operations: list[FileOperationRead]
    # Pass as `before` to fetch the next (older) page; null at the end.
    next_cursor: str | None
