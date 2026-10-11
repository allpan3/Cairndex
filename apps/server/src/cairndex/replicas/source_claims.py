"""Bind recovery storage to one private author and exact immutable intent."""

import os
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

from cairndex.file_ops.exclusive import relocate
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import operation_directory
from cairndex.replicas.transport import read_file


def claim(store: CatalogStore, root: Path, operation: str, intent: dict[str, Any]) -> None:
    """A shared directory cannot be reused by an independent private author.

    Atomic publication also probes no-replace support before source capture.
    A partial or foreign claim is retained and refused, never overwritten.
    """
    with store.connection(readonly=True) as db:
        author = db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]
        previous_authors = [row[0] for row in db.execute("SELECT replica FROM recovery_authors")]
    body = dict(library=store.descriptor.library_uuid, epoch=store.descriptor.epoch, intent=intent)
    allowed = {value_text(body | {"author": item}).encode() for item in [author, *previous_authors]}
    encoded = value_text(body | {"author": author}).encode()
    with operation_directory(root, operation, create=True) as handle:
        try:
            existing = read_file(handle, "claim")
        except FileNotFoundError:
            temporary = ".claim-" + uuid4().hex
            output = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=handle,
            )
            try:
                with os.fdopen(output, "wb", closefd=False) as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(output)
            finally:
                os.close(output)
            try:
                relocate(handle, temporary, handle, "claim")
            except FileExistsError:
                pass
            finally:
                with suppress(FileNotFoundError):
                    os.unlink(temporary, dir_fd=handle)
            existing = read_file(handle, "claim")
        if existing not in allowed:
            raise ReplicaError("Operation recovery storage belongs to different intent or author")


def probe(root: Path, operation: str) -> None:
    """Check actual no-replace behavior before moving any source entry."""
    with operation_directory(root, operation) as handle:
        names = [".probe-" + uuid4().hex for _ in range(2)]
        for name in names:
            fd = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=handle
            )
            os.close(fd)
        try:
            try:
                relocate(handle, names[0], handle, names[1])
            except FileExistsError:
                return
            raise ReplicaError("Storage does not enforce no-replace relocation")
        finally:
            for name in names:
                with suppress(FileNotFoundError):
                    os.unlink(name, dir_fd=handle)
