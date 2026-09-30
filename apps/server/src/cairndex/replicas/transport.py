"""Bounded file discovery and immutable publication confined to the metadata package"""

import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from uuid import uuid4

from cairndex.file_ops import smb_transport
from cairndex.file_ops.exclusive import link
from cairndex.replicas.catalog.storage import CatalogStorage
from cairndex.replicas.protocol import MAX_BYTES, ReplicaError
from cairndex.replicas.store import Store

BATCH = 32


# Open every metadata directory relative to an already-open parent, rejecting symlinks
@contextmanager
def directory(root: Path, parts: list[str], *, create: bool = False) -> Iterator[int]:
    handles: list[int] = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.append(fd)
        for part in parts:
            if part in {"", ".", ".."} or "/" in part or "\\" in part:
                raise ReplicaError("Invalid metadata directory")
            if create:
                with suppress(FileExistsError):
                    os.mkdir(part, dir_fd=fd)
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            handles.append(fd)
        yield fd
    finally:
        for handle in reversed(handles):
            os.close(handle)


# Bound reads before parsing and refuse nonregular or linked objects
# The caller obtains names from this directory, never from an API parameter
def read_file(fd: int, name: str) -> bytes:
    handle = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ReplicaError("Unsupported metadata object")
        with os.fdopen(handle, "rb", closefd=False) as stream:
            return stream.read(MAX_BYTES + 1)
    finally:
        os.close(handle)


# Use bounded pending rows and resumable directory iterators, never a history rebuild
class Transport:
    # A descriptor pins all paths and identities before discovery begins
    def __init__(self, root: Path, store: Store | CatalogStorage) -> None:
        self.root, self.store = root, store
        info = root.stat(follow_symlinks=False)
        self._root_identity = (info.st_dev, info.st_ino)
        self._scan: Iterator[tuple[str, bytes]] | None = None
        self._repair_cursor = ""

    # Restart a discovery cycle so files inserted before an iterator are eventually visited
    def _objects(self) -> Iterator[tuple[str, bytes]]:
        for shard in range(256):
            part = f"{shard:02x}"
            try:
                with (
                    directory(self.root, [".cairndex", "replica", "objects", part]) as fd,
                    os.scandir(fd) as entries,
                ):
                    for entry in entries:
                        if entry.name.endswith(".json"):
                            try:
                                yield part + "/" + entry.name, read_file(fd, entry.name)
                            except (OSError, ReplicaError):
                                # Unreadable or unsafe entries never replace good state
                                yield part + "/" + entry.name, b""
                        else:
                            yield (
                                "ignored",
                                b"",
                            )  # Every entry consumes the per-tick work budget
            except FileNotFoundError:
                continue

    # Immutable names cannot be replaced with different bytes, including corrupt provider copies
    def publish(self, event_id: str, raw: bytes) -> None:
        with directory(
            self.root, [".cairndex", "replica", "objects", event_id[:2]], create=True
        ) as fd:
            name = event_id + ".json"
            try:
                existing = read_file(fd, name)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                if existing != raw:
                    raise ReplicaError(
                        "A published object changed; recovery from a verified archive is required"
                    )
                return
            temporary = f".{uuid4().hex}.partial"
            handle = os.open(
                temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd
            )
            try:
                with os.fdopen(handle, "wb", closefd=False) as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(handle)
            finally:
                os.close(handle)
            self.store.fault("publish_before_rename")
            try:
                link(fd, temporary, name)
            except FileExistsError:
                if read_file(fd, name) != raw:
                    raise ReplicaError(
                        "A concurrent publication changed an immutable object"
                    ) from None
            finally:
                os.unlink(temporary, dir_fd=fd)
            os.fsync(fd)
            self.store.fault("publish_after_rename")

    # One exchange tick bounds discovery, dependency retries and outbox publication separately
    def tick(self) -> None:
        smb_transport._mount(self.root)
        info = self.root.stat(follow_symlinks=False)
        if self._root_identity != (info.st_dev, info.st_ino):
            self.close()
            raise ReplicaError("Library directory changed; reopen after recovery review")
        if self._scan is None:
            self._scan = self._objects()
        for _ in range(BATCH):
            try:
                source, raw = next(self._scan)
            except StopIteration:
                self._scan = None
                break
            except (OSError, ReplicaError):
                self.close()
                raise
            if source != "ignored":
                self.store.ingest(raw, source)
        self.store.import_batch(BATCH)
        with self.store.connection() as db:
            rows = db.execute(
                "SELECT id,raw FROM events WHERE local=1 AND published=0 ORDER BY id LIMIT ?",
                (BATCH,),
            ).fetchall()
        for row in rows:
            self.publish(row["id"], row["raw"])
            self.store.fault("publish_before_receipt")
            with self.store.connection() as db:
                db.execute("UPDATE events SET published=1 WHERE id=?", (row["id"],))
        # Repair absent authored files in bounded rotations, preserving accepted history privately
        with self.store.connection() as db:
            repair = db.execute(
                (
                    "SELECT id,raw FROM events WHERE local=1 AND published=1 AND id>? "
                    "ORDER BY id LIMIT ?"
                ),
                (self._repair_cursor, BATCH),
            ).fetchall()
        for row in repair:
            self.publish(row["id"], row["raw"])
            self._repair_cursor = row["id"]
        if len(repair) < BATCH:
            self._repair_cursor = ""

    # Release directory handles during server shutdown or explicit library release
    def close(self) -> None:
        if self._scan is not None:
            close = getattr(self._scan, "close", None)
            if close:
                close()
        self._scan = None
