"""The library's own trash: deletion as a move, not an unlink (ADR-0013 §3.2).

Deleting never unlinks. The entry is renamed into the library package:

```text
.cairndex/trash/{op_id}/files/<original/relative/path>
.cairndex/trash/{op_id}/meta.json
```

Three properties fall out of that layout, and each is why it is that layout:

* **Same filesystem, so it is a rename** — instant even for a 60 GB video, and
  atomic, where a copy-then-delete would have a window in which the file exists
  twice or not at all.
* **Inside `.cairndex/`, so it is already invisible** to scanning and grouping,
  and it travels with the library when the folder is copied (ADR-0008). A
  library restored from a backup still has its trash.
* **One directory per operation**, holding the original relative paths as a
  real tree, so restoring a deleted folder puts every file back where it was
  without needing to reconstruct the shape from a manifest.

`meta.json` is written for the *human* case — someone poking at the package
without Cairndex, or a library whose DB was lost. The journal row is the
authority the code reads.

The trashed `AssetFile` rows keep their ids and move their `relative_path` to
the trash location, because `relative_path` means "where the bytes are" and
after a delete they really are in there. That also keeps the path's uniqueness
constraint honest: the original path is free again, so something else can take
it — which is exactly what Replace needs.
"""

import contextlib
import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from cairndex.core.time import utcnow
from cairndex.registry import library_package as pkg

META_NAME = "meta.json"
FILES_DIR = "files"


@dataclass(frozen=True)
class TrashedEntry:
    """One path moved into the trash, and how to put it back."""

    # Where it was, library-relative. What restore aims at and what the UI shows.
    original_path: str
    # Where it is now, library-relative (inside `.cairndex/trash/…`).
    stored_path: str
    # The linked row that moved with it, if any. Unlinked files are trashed too.
    file_id: str | None
    is_directory: bool

    def as_payload(self) -> dict[str, Any]:
        return {
            "original_path": self.original_path,
            "stored_path": self.stored_path,
            "file_id": self.file_id,
            "is_directory": self.is_directory,
        }


def entry_from_payload(data: dict[str, Any]) -> TrashedEntry:
    return TrashedEntry(
        original_path=str(data["original_path"]),
        stored_path=str(data["stored_path"]),
        file_id=data.get("file_id"),
        is_directory=bool(data.get("is_directory", False)),
    )


def operation_dir(root: Path, operation_id: str) -> Path:
    return pkg.trash_dir(root) / operation_id


def stored_relative_path(operation_id: str, original_path: str) -> str:
    """The library-relative path an entry takes inside the trash."""
    return f"{pkg.MARKER_DIR}/{pkg.TRASH_DIR}/{operation_id}/{FILES_DIR}/{original_path}"


def move_into_trash(root: Path, *, operation_id: str, original_path: str) -> TrashedEntry:
    """Rename one file or directory into this operation's trash directory.

    The parent chain is recreated inside the trash so the original shape is
    preserved for restore. Raises ``OSError`` on failure — the caller journals
    it; this function never decides what a failure means.
    """
    source = root / original_path
    is_directory = source.is_dir() and not source.is_symlink()
    destination = operation_dir(root, operation_id) / FILES_DIR / original_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.rename(source, destination)
    return TrashedEntry(
        original_path=original_path,
        stored_path=stored_relative_path(operation_id, original_path),
        file_id=None,
        is_directory=is_directory,
    )


def restore_from_trash(root: Path, entry: TrashedEntry) -> None:
    """Rename one entry back to where it came from.

    The destination's parent chain is recreated: a file can outlive the folder
    it was in — trash the folder, then trash something else, then restore only
    the file — and refusing to restore because an intermediate directory is gone
    would make the trash a one-way door in exactly the case it is most needed.
    """
    source = root / entry.stored_path
    destination = root / entry.original_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.rename(source, destination)


def delete_permanently(root: Path, entry: TrashedEntry) -> None:
    """Unlink one trashed entry for good. Missing is success, not an error."""
    target = root / entry.stored_path
    with contextlib.suppress(FileNotFoundError):
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()


def prune_operation_dir(root: Path, operation_id: str) -> None:
    """Remove an operation's trash directory once nothing is left in it."""
    directory = operation_dir(root, operation_id)
    with contextlib.suppress(FileNotFoundError):
        shutil.rmtree(directory)


def write_meta(
    root: Path,
    *,
    operation_id: str,
    entries: list[TrashedEntry],
    deleted_at: datetime | None = None,
) -> None:
    """Record what this trash directory holds, for anyone reading it by hand.

    Best-effort on purpose: the journal row in ``library.db`` is what the code
    restores from, so a package on a full or read-only-ish volume must not fail
    the deletion over a note nobody has read yet.
    """
    directory = operation_dir(root, operation_id)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / META_NAME).write_text(
            json.dumps(
                {
                    "operation_id": operation_id,
                    "deleted_at": (deleted_at or utcnow()).isoformat(),
                    "entries": [entry.as_payload() for entry in entries],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    except OSError:
        pass


def size_on_disk(root: Path) -> int:
    """Total bytes the trash occupies, for the "Empty Trash" confirmation.

    Walks the trash rather than summing recorded sizes: what the owner wants to
    know before emptying is how much space comes back, and that is a property of
    the filesystem, not of the metadata.
    """
    total = 0
    for directory, _sub, files in os.walk(pkg.trash_dir(root)):
        for name in files:
            if name == META_NAME:
                continue  # bookkeeping, not the owner's data
            try:
                total += (Path(directory) / name).stat().st_size
            except OSError:
                continue  # vanished mid-walk, or unreadable; not worth failing over
    return total


def is_trash_path(relative_path: str) -> bool:
    """Whether a library-relative path points inside the trash."""
    parts = PurePosixPath(relative_path).parts
    return len(parts) >= 2 and parts[0] == pkg.MARKER_DIR and parts[1] == pkg.TRASH_DIR
