"""Copy-only upload staging with exact byte retries and no client source paths."""

import hashlib
import json
import os
import stat
import threading
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, Literal

from starlette.concurrency import run_in_threadpool

from cairndex.file_ops.exclusive import relocate
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, StrictModel
from cairndex.replicas.source_files import operation_directory


class UploadProgress(StrictModel):
    state: Literal["waiting", "receiving", "ready", "interrupted"]
    received: int
    size: int | None
    # Why the server stopped the latest attempt. A refusal sent before the body
    # was read reaches a browser only as a network error, so the client asks here.
    error: str | None = None


# Only active requests live here. Progress is observational, not a durability
# checkpoint; restart uses the existing upload journal and exact-byte retry.
_active: dict[tuple[Path, str], int] = {}
_failures: dict[tuple[Path, str], str] = {}
_FAILURES_KEPT = 64
_progress_lock = threading.Lock()


def _failure_text(error: BaseException) -> str | None:
    """What the owner reads about a stopped upload; it names no path or login."""
    from cairndex.core.errors import DomainError
    from cairndex.file_ops import smb_transport

    if isinstance(error, DomainError):
        return error.message
    if isinstance(error, OSError):
        if smb_transport.access_problem(error):
            return smb_transport.access_message(error)
        return (
            "The library's storage could not save this file. "
            "Check that it is available, then try again."
        )
    # A closed request or a stopped server is already visible to the client
    return None


def _record_failure(store: CatalogStore, upload: str, error: BaseException) -> None:
    text = _failure_text(error)
    with _progress_lock:
        _failures.pop((store.path, upload), None)
        if text is not None:
            _failures[(store.path, upload)] = text
            while len(_failures) > _FAILURES_KEPT:
                _failures.pop(next(iter(_failures)))


def progress(store: CatalogStore, upload: str) -> UploadProgress:
    with store.connection(readonly=True) as db:
        row = db.execute("SELECT size,state FROM source_uploads WHERE id=?", (upload,)).fetchone()
    with _progress_lock:
        received = _active.get((store.path, upload), 0)
        error = _failures.get((store.path, upload))
    if row is None:
        return UploadProgress(state="waiting", received=0, size=None, error=error)
    return UploadProgress(
        state=row["state"],
        received=row["size"] if row["state"] == "ready" else received,
        size=row["size"],
        error=None if row["state"] == "ready" else error,
    )


async def blocks(chunks: AsyncIterator[bytes], size: int = 4 * 1024 * 1024) -> AsyncIterator[bytes]:
    """Bound SMB writes independently of small HTTP delivery fragments."""
    pending = bytearray()
    async for chunk in chunks:
        for offset in range(0, len(chunk), size):
            part = memoryview(chunk)[offset : offset + size]
            while part:
                count = min(size - len(pending), len(part))
                pending.extend(part[:count])
                part = part[count:]
                if len(pending) == size:
                    yield bytes(pending)
                    pending.clear()
    if pending:
        yield bytes(pending)


async def receive(
    store: CatalogStore,
    root: Path,
    upload: str,
    size: int,
    chunks: AsyncIterator[bytes],
    authorize: Callable[[], None],
) -> dict[str, Any]:
    """Stage one upload's exact bytes, remembering why an attempt stopped."""
    with _progress_lock:
        _failures.pop((store.path, upload), None)
    try:
        return await _receive(store, root, upload, size, chunks, authorize)
    except BaseException as error:
        _record_failure(store, upload, error)
        raise


async def _receive(
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
            "ON CONFLICT(id) DO UPDATE SET state=CASE "
            "WHEN state='ready' THEN state ELSE 'receiving' END",
            (upload, size),
        )
        # Request text selects the durable intent; recovery paths use its stored identity.
        stored_upload = str(
            db.execute("SELECT id FROM source_uploads WHERE id=?", (upload,)).fetchone()[0]
        )
    with _progress_lock:
        _active[(store.path, stored_upload)] = 0
    try:
        from cairndex.replicas.source_claims import claim

        claim(store, root, stored_upload, {"upload": upload, "size": size})
        with operation_directory(root, stored_upload, create=True) as directory:
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

                async for chunk in blocks(chunks):
                    if received + len(chunk) > size:
                        raise ReplicaError("Upload exceeds its declared byte count")
                    for offset in range(0, len(chunk), 4 * 1024 * 1024):
                        authorize()
                        block = chunk[offset : offset + 4 * 1024 * 1024]
                        await run_in_threadpool(write, block, received)
                        digest.update(block)
                        received += len(block)
                        with _progress_lock:
                            _active[(store.path, stored_upload)] = received
                if received != size:
                    raise ReplicaError("Upload delivery is incomplete")
                await run_in_threadpool(os.fsync, handle)
            finally:
                os.close(handle)
            if not complete:
                relocate(directory, "source.partial", directory, "source")
        evidence = {"algorithm": "sha256", "size": received, "digest": digest.hexdigest()}
        if prior and prior["state"] == "ready" and json.loads(prior["evidence"]) != evidence:
            raise ReplicaError("Completed upload content differs from its original evidence")
        with store.connection() as db:
            db.execute(
                "UPDATE source_uploads SET state='ready',evidence=? WHERE id=?",
                (value_text(evidence), upload),
            )
        return {"upload": upload, "size": received}
    except BaseException:
        with store.connection() as db:
            db.execute(
                "UPDATE source_uploads SET state='interrupted' WHERE id=? AND state!='ready'",
                (upload,),
            )
        raise
    finally:
        with _progress_lock:
            _active.pop((store.path, stored_upload), None)


def uploaded_version(store: CatalogStore, root: Path, upload: str, limit: int) -> dict[str, Any]:
    """Reference the verified immutable upload; apply moves it into place as the output.

    The upload already has its own durable intent and received-byte digest.
    Copying it into another file adds a complete network round trip without
    another safety boundary. Never link the editable output to it.
    """
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT evidence FROM source_uploads WHERE id=? AND state='ready'", (upload,)
        ).fetchone()
        if row is None:
            raise ReplicaError("Copy is waiting for its complete upload")
        expected: dict[str, Any] = json.loads(row[0])
    if expected["size"] > limit:
        raise ReplicaError("Upload exceeds the operation byte limit")
    with operation_directory(root, upload) as origin:
        try:
            source = os.open("source", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=origin)
        except FileNotFoundError:
            raise ReplicaError(
                "This upload was already used by a completed copy; send the file again"
            ) from None
        try:
            info = os.fstat(source)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size != expected["size"]
            ):
                raise ReplicaError("Retained upload changed after receipt")
        finally:
            os.close(source)
    return expected
