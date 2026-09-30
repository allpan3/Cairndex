"""Bounded receipt exchange, independent from physical source delivery."""

import hashlib
import json
import os
from collections.abc import Generator
from pathlib import Path
from uuid import uuid4

from cairndex.file_ops.exclusive import link
from cairndex.replicas.catalog.model import TOKEN, value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import generation, open_source
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.replicas.source_files import operation_directory
from cairndex.replicas.source_receipts import dependencies, parse
from cairndex.replicas.transport import directory, read_file


def publish(root: Path, operation: str, raw: str) -> None:
    """Publish a complete receipt without replacing another writer's bytes."""
    with operation_directory(root, operation, create=True) as handle:
        encoded = raw.encode()
        try:
            if read_file(handle, "receipt.json") != encoded:
                raise ReplicaError("Source receipt name contains different immutable bytes")
            return
        except FileNotFoundError:
            pass
        temporary = ".receipt-" + uuid4().hex
        output = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=handle
        )
        try:
            with os.fdopen(output, "wb", closefd=False) as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(output)
        finally:
            os.close(output)
        try:
            link(handle, temporary, "receipt.json")
        except FileExistsError:
            if read_file(handle, "receipt.json") != encoded:
                raise ReplicaError("Concurrent source receipt publication differs") from None
        finally:
            os.unlink(temporary, dir_fd=handle)
        os.fsync(handle)


def ingest(store: CatalogStore, raw: str) -> None:
    """Retain invalid or forked receipts; never infer permission to change source paths."""
    identity = "invalid_" + checksum(raw.encode())[:48]
    state, error = "pending", None
    try:
        receipt = parse(store, raw)
        identity = receipt.operation
    except ReplicaError as failure:
        state, error = "invalid", failure.message
    with store.connection() as db:
        prior = db.execute("SELECT raw FROM source_receipts WHERE id=?", (identity,)).fetchone()
        if prior and prior[0] == raw:
            return
        if prior:
            error = "Conflicting source receipts require explicit recovery review"
            db.execute(
                "UPDATE source_receipts SET state='invalid',error=? WHERE id=?", (error, identity)
            )
            identity, state = "invalid_" + checksum(raw.encode())[:48], "invalid"
        db.execute(
            "INSERT OR IGNORE INTO source_receipts VALUES (?,?,?,?)", (identity, raw, state, error)
        )


class SourceTransport:
    def __init__(self, root: Path, store: CatalogStore) -> None:
        self.root, self.store = root, store
        info = root.stat(follow_symlinks=False)
        self.identity = (info.st_dev, info.st_ino)
        self.scan: Generator[str | None, None, None] | None = None
        self.verifier: Generator[None, None, None] | None = None
        self.cursor = ""
        self.pending_cursor = ""
        self.verify_cursor = ""

    def objects(self) -> Generator[str | None, None, None]:
        try:
            with (
                directory(self.root, [".cairndex", "source-operations"]) as handle,
                os.scandir(handle) as entries,
            ):
                for entry in entries:
                    yield None  # Invalid directory entries also consume the work budget.
                    if not TOKEN.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):
                        continue
                    with (
                        operation_directory(self.root, entry.name) as operation,
                        os.scandir(operation) as children,
                    ):
                        for child in children:
                            if child.name.endswith(".json"):
                                try:
                                    yield read_file(operation, child.name).decode("utf-8")
                                except (OSError, UnicodeError, ReplicaError):
                                    yield "{}"
                            else:
                                yield None
        except FileNotFoundError:
            return

    def tick(self) -> None:
        info = self.root.stat(follow_symlinks=False)
        if self.identity != (info.st_dev, info.st_ino):
            self.close()
            raise ReplicaError("Source library root changed; recovery review is required")
        if self.scan is None:
            self.scan = self.objects()
        for _ in range(32):
            try:
                raw = next(self.scan)
            except StopIteration:
                self.scan = None
                break
            if raw is not None:
                ingest(self.store, raw)
        with self.store.connection() as db:
            pending = db.execute(
                "SELECT id,raw FROM source_receipts WHERE state='pending' AND id>? "
                "ORDER BY id LIMIT 32",
                (self.pending_cursor,),
            ).fetchall()
            for row in pending:
                self.pending_cursor = row["id"]
                try:
                    if dependencies(self.store, db, parse(self.store, row["raw"])):
                        db.execute(
                            "UPDATE source_receipts SET state='accepted' WHERE id=?", (row["id"],)
                        )
                except ReplicaError as error:
                    db.execute(
                        "UPDATE source_receipts SET state='invalid',error=? WHERE id=?",
                        (error.message, row["id"]),
                    )
            if len(pending) < 32:
                self.pending_cursor = ""
            rows = db.execute(
                "SELECT id,raw FROM source_receipts WHERE state='local' AND id>? "
                "ORDER BY id LIMIT 32",
                (self.cursor,),
            ).fetchall()
        for row in rows:
            publish(self.root, row["id"], row["raw"])
            self.cursor = row["id"]
        if len(rows) < 32:
            self.cursor = ""
        if self.verifier is None:
            self.verifier = self.verify_sources()
        for _ in range(8):
            try:
                next(self.verifier)
            except StopIteration:
                self.verifier = None
                break

    def verify_sources(self) -> Generator[None, None, None]:
        """Verify only current receipt paths; missing or partial bytes remain unavailable."""
        with self.store.connection(readonly=True) as db:
            row = db.execute(
                "SELECT id,raw FROM source_receipts WHERE state='accepted' AND id>? "
                "ORDER BY id LIMIT 1",
                (self.verify_cursor,),
            ).fetchone()
        if row is None:
            self.verify_cursor = ""
            return
        self.verify_cursor = row["id"]
        receipt = parse(self.store, row["raw"])
        outputs = []
        for path, version in receipt.versions_after.items():
            if version is None:
                continue
            if version.evidence.algorithm == "tree-sha256-v1":
                with self.store.connection(readonly=True) as db:
                    rows = db.execute(
                        "SELECT p.path,u.value FROM catalog_paths p JOIN catalog_units u "
                        "ON u.unit='asset_files/'||p.entity||'/$content' "
                        "WHERE p.family='asset_files' AND p.path>=? AND p.path<? "
                        "ORDER BY p.path LIMIT 128",
                        (path + "/", path + "0"),
                    ).fetchall()
                for row in rows:
                    if row[1] and json.loads(row[1])["algorithm"] == "sha256":
                        outputs.append((row[0], json.loads(row[1])))
            else:
                outputs.append((path, version.evidence.model_dump()))
        for path, expected in outputs:
            yield
            with self.store.connection(readonly=True) as db:
                from cairndex.replicas.source_plan import path_identity

                try:
                    identity = path_identity(db, path)
                except ReplicaError:
                    # Unresolved identities cannot receive a verified local baseline.
                    continue
                if identity is None:
                    continue
                content = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?",
                    (f"asset_files/{identity}/$content",),
                ).fetchone()
                prior = db.execute(
                    "SELECT body FROM discovery_baselines WHERE file_id=?", (identity,)
                ).fetchone()
                if content is None or content[0] != value_text(expected):
                    continue
            try:
                with open_source(self.root, path) as handle:
                    info = os.fstat(handle)
                    token = generation(path, info)
                    if (
                        prior
                        and json.loads(prior[0])["generation"] == token
                        and json.loads(prior[0])["evidence"] == expected
                    ):
                        continue
                    if info.st_size != expected["size"]:
                        continue
                    digest, offset = hashlib.sha256(), 0
                    while offset < info.st_size:
                        block = os.pread(handle, min(1024 * 1024, info.st_size - offset), offset)
                        if not block:
                            break
                        digest.update(block)
                        offset += len(block)
                        yield
                    if (
                        offset != info.st_size
                        or digest.hexdigest() != expected["digest"]
                        or generation(path, os.fstat(handle)) != token
                    ):
                        continue
                from cairndex.replicas.source_files import observation

                observed = observation(self.root, path)
                if observed is None or observed["generation"] != token:
                    continue
                baseline = {
                    "path": path,
                    "generation": token,
                    "evidence": expected,
                    "device": info.st_dev,
                    "inode": info.st_ino,
                    "mtime": info.st_mtime_ns,
                }
                with self.store.connection() as db:
                    current = db.execute(
                        "SELECT value FROM catalog_units WHERE unit=?",
                        (f"asset_files/{identity}/$content",),
                    ).fetchone()
                    root_info = self.root.stat(follow_symlinks=False)
                    if (
                        self.identity != (root_info.st_dev, root_info.st_ino)
                        or path_identity(db, path) != identity
                        or current is None
                        or current[0] != value_text(expected)
                    ):
                        continue
                    db.execute(
                        "INSERT OR REPLACE INTO discovery_baselines VALUES (?,?)",
                        (identity, value_text(baseline)),
                    )
            except (OSError, ReplicaError):
                continue

    def close(self) -> None:
        if self.scan is not None:
            self.scan.close()
            self.scan = None
        if self.verifier is not None:
            self.verifier.close()
            self.verifier = None
