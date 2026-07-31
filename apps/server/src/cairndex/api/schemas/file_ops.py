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


class MoveRequest(BaseModel):
    """Move one or more files/directories into another directory."""

    # Library-relative POSIX paths, validated server-side like every other write.
    paths: list[str] = Field(min_length=1)
    # The destination directory, relative to the library root. Empty means the
    # root itself; it must already exist (New Folder is a separate operation).
    dest_dir: str = ""
    on_conflict: ConflictPolicy = ConflictPolicy.FAIL


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
    # Paths a multi-item operation could not act on. The operation still
    # completed for everything else — reported rather than raised, because
    # failing the request would lose the items that did move.
    failed_paths: list[str] = []


class ImportResultRead(FileOperationResult):
    """An import, plus what actually arrived."""

    # Bytes written. The caller can check it against what it sent — the one
    # end-to-end confirmation a streamed upload can offer.
    size_bytes: int


class TrashRequest(BaseModel):
    """Move files and/or directories into the library's trash."""

    paths: list[str] = Field(min_length=1)


class EmptyTrashRequest(BaseModel):
    """Permanently delete trashed entries. The one operation with no undo."""

    # Keep deletions newer than this many days. Omitted = empty everything,
    # which is what pressing the button means.
    older_than_days: int | None = Field(default=None, ge=1)


class TrashedEntryRead(BaseModel):
    """One entry sitting in the trash, and where it would go back to."""

    original_path: str
    name: str
    file_id: str | None
    is_directory: bool
    # Present only while the bytes are still there; null if something removed
    # them behind our back.
    size_bytes: int | None


class TrashedOperationRead(BaseModel):
    """One deletion, restorable as a unit."""

    operation_id: str
    deleted_at: datetime | None
    entries: list[TrashedEntryRead]


class TrashRead(BaseModel):
    """Everything currently recoverable, newest deletion first."""

    operations: list[TrashedOperationRead]
    # Bytes the trash occupies when every entry has recorded metadata. Null for
    # legacy/unlinked directory deletions rather than walking a network mount.
    size_bytes: int | None


class EmptyTrashResult(BaseModel):
    operations_emptied: int


class FileOperationPage(BaseModel):
    """Newest-first page of the journal."""

    operations: list[FileOperationRead]
    # Pass as `before` to fetch the next (older) page; null at the end.
    next_cursor: str | None
