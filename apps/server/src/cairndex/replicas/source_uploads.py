"""Copy-only upload staging with exact byte retries and no client source paths."""

import hashlib
import json
import os
import stat
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from starlette.concurrency import run_in_threadpool

from cairndex.file_ops.exclusive import relocate
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import copy_stream, operation_directory


async def receive(
    store: CatalogStore,
    root: Path,
    upload: str,
    size: int,
    chunks: AsyncIterator[bytes],
    authorize: Callable[[], None],
) -> dict[str, Any]:
    authorize()
    with store.connection() as db:
        prior = db.execute("SELECT * FROM source_uploads WHERE id=?", (upload,)).fetchone()
        if prior and (prior["size"] != size or prior["state"] == "receiving"):
            raise ReplicaError("Upload identity is busy or has different intent")
        if (
            not prior
            and db.execute("SELECT 1 FROM source_operations WHERE id=?", (upload,)).fetchone()
        ):
            raise ReplicaError("Upload identity belongs to another operation")
        db.execute(
            "INSERT INTO source_uploads VALUES (?,?,'receiving',NULL) "
            "ON CONFLICT(id) DO UPDATE SET state='receiving'",
            (upload, size),
        )
    try:
        from cairndex.replicas.source_claims import claim

        claim(store, root, upload, {"upload": upload, "size": size})
        with operation_directory(root, upload, create=True) as directory:
            complete = False
            try:
                handle = os.open("source", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                complete = True
            except FileNotFoundError:
                handle = os.open(
                    "source.partial",
                    os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=directory,
                )
            digest, received = hashlib.sha256(), 0
            try:
                info = os.fstat(handle)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > size:
                    raise ReplicaError("Upload staging is inconsistent")

                def write(block: bytes, offset: int) -> None:
                    if os.fstat(handle).st_nlink != 1:
                        raise ReplicaError("Upload staging acquired another link")
                    retained = min(len(block), max(0, info.st_size - offset))
                    if retained and os.pread(handle, retained, offset) != block[:retained]:
                        raise ReplicaError("Upload retry contains different bytes")
                    if complete and retained != len(block):
                        raise ReplicaError("Completed upload length changed")
                    view = memoryview(block)[retained:]
                    os.lseek(handle, offset + retained, os.SEEK_SET)
                    while view:
                        count = os.write(handle, view)
                        if count <= 0:
                            raise OSError("Upload staging could not be written")
                        view = view[count:]

                async for chunk in chunks:
                    if received + len(chunk) > size:
                        raise ReplicaError("Upload exceeds its declared byte count")
                    for offset in range(0, len(chunk), 1024 * 1024):
                        authorize()
                        block = chunk[offset : offset + 1024 * 1024]
                        await run_in_threadpool(write, block, received)
                        digest.update(block)
                        received += len(block)
                if received != size:
                    raise ReplicaError("Upload delivery is incomplete")
                await run_in_threadpool(os.fsync, handle)
            finally:
                os.close(handle)
            if not complete:
                relocate(directory, "source.partial", directory, "source")
        evidence = {"algorithm": "sha256", "size": received, "digest": digest.hexdigest()}
        with store.connection() as db:
            db.execute(
                "UPDATE source_uploads SET state='ready',evidence=? WHERE id=?",
                (value_text(evidence), upload),
            )
        return {"upload": upload, "size": received}
    except BaseException:
        with store.connection() as db:
            db.execute("UPDATE source_uploads SET state='interrupted' WHERE id=?", (upload,))
        raise


def snapshot_upload(
    store: CatalogStore,
    root: Path,
    upload: str,
    operation: str,
    progress: Callable[[int], None],
    limit: int,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT evidence FROM source_uploads WHERE id=? AND state='ready'", (upload,)
        ).fetchone()
        if row is None:
            raise ReplicaError("Copy is waiting for its complete upload")
        expected = json.loads(row[0])
    with (
        operation_directory(root, upload) as origin,
        operation_directory(root, operation, create=True) as target,
    ):
        source = os.open("source", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=origin)
        try:
            complete = False
            try:
                destination = os.open("source", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=target)
                complete = True
            except FileNotFoundError:
                destination = os.open(
                    "source.partial", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=target
                )
            try:
                evidence = copy_stream(source, destination, progress=progress, limit=limit)
                if evidence != expected:
                    raise ReplicaError("Upload content changed after receipt")
            finally:
                os.close(destination)
            if not complete:
                relocate(target, "source.partial", target, "source")
            return evidence
        finally:
            os.close(source)
