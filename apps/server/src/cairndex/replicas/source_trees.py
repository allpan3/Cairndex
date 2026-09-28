"""Bounded directory versions with independent files and an immutable content index."""

import hashlib
import json
import os
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from typing import Any

from cairndex.file_ops.exclusive import relocate
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.transport import read_file

MAX_ENTRIES = 128


@contextmanager
def descend(handle: int, path: str) -> Iterator[int]:
    current = os.dup(handle)
    try:
        for part in path.split("/") if path else []:
            next_handle = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current
            )
            os.close(current)
            current = next_handle
        yield current
    finally:
        os.close(current)


def entries(handle: int) -> list[dict[str, Any]]:
    """Count every entry and refuse hidden, linked, special or cross-device content."""
    result: list[dict[str, Any]] = []
    device = os.fstat(handle).st_dev

    def visit(parent: int, prefix: str, depth: int) -> None:
        if depth > 64:
            raise ReplicaError("Directory operation exceeds the depth limit")
        with os.scandir(parent) as children:
            for child in children:
                if len(result) >= MAX_ENTRIES:
                    raise ReplicaError("Directory operation exceeds the 128-entry review limit")
                if child.name.startswith("."):
                    raise ReplicaError("Directory operation contains hidden entries")
                info = child.stat(follow_symlinks=False)
                is_directory = stat.S_ISDIR(info.st_mode)
                if (not is_directory and not stat.S_ISREG(info.st_mode)) or info.st_dev != device:
                    raise ReplicaError("Directory operation contains linked or unsupported entries")
                path = prefix + child.name
                from cairndex.replicas.source_files import source_path

                source_path(path)
                result.append(
                    {
                        "path": path,
                        "directory": is_directory,
                        "identity": [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns],
                    }
                )
                if is_directory:
                    with descend(parent, child.name) as nested:
                        visit(nested, path + "/", depth + 1)

    visit(handle, "", 0)
    return sorted(result, key=lambda row: row["path"])


def identity(handle: int) -> tuple[list[Any], int]:
    info = os.fstat(handle)
    rows = entries(handle)
    total = sum(row["identity"][2] for row in rows if not row["directory"])
    digest = hashlib.sha256(value_text(rows).encode()).hexdigest()
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, digest], total


def copy_tree(
    source: int, target: int, progress: Callable[[int], None], limit: int, *, complete: bool = False
) -> list[dict[str, Any]]:
    from cairndex.replicas.source_files import copy_stream

    rows = entries(source)
    size = sum(row["identity"][2] for row in rows if not row["directory"])
    if size > limit:
        raise ReplicaError("Directory operation exceeds the byte limit")
    names = {row["path"]: row["directory"] for row in rows}
    if any(names.get(row["path"]) != row["directory"] for row in entries(target)):
        raise ReplicaError("Recovery directory contains unexpected entries")
    manifest: list[dict[str, Any]] = []
    processed = 0
    for row in sorted(rows, key=lambda row: (row["path"].count("/"), row["path"])):
        progress(processed)
        path = row["path"]
        parent, _, name = path.rpartition("/")
        with descend(source, parent) as origin, descend(target, parent) as destination:
            if row["directory"]:
                if not complete:
                    with suppress(FileExistsError):
                        os.mkdir(name, 0o700, dir_fd=destination)
                    os.fsync(destination)
                with descend(destination, name):
                    pass
                manifest.append({"path": path, "directory": True})
                continue
            incoming = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=origin)
            try:
                info = os.fstat(incoming)
                if [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns] != row["identity"]:
                    raise ReplicaError("Directory contents changed before copying")
                outgoing = os.open(
                    name,
                    (os.O_RDONLY if complete else os.O_RDWR | os.O_CREAT)
                    | os.O_NOFOLLOW
                    | os.O_NONBLOCK,
                    0o600,
                    dir_fd=destination,
                )
                try:

                    def report(count: int, base: int = processed) -> None:
                        progress(base + count)

                    evidence = copy_stream(
                        incoming,
                        outgoing,
                        progress=report,
                        limit=limit,
                    )
                finally:
                    os.close(outgoing)
            finally:
                os.close(incoming)
            processed += evidence["size"]
            manifest.append({"path": path, "directory": False, "evidence": evidence})
            os.fsync(destination)
    if entries(source) != rows:
        raise ReplicaError("Directory contents changed while copying")
    os.fsync(target)
    progress(processed)
    return sorted(manifest, key=lambda row: row["path"])


def evidence(manifest: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "algorithm": "tree-sha256-v1",
        "size": sum(row["evidence"]["size"] for row in manifest if not row["directory"]),
        "digest": hashlib.sha256(value_text(manifest).encode()).hexdigest(),
    }


def save_index(handle: int, name: str, manifest: list[dict[str, Any]]) -> None:
    from uuid import uuid4

    raw = value_text(manifest).encode()
    try:
        if read_file(handle, name + "-index") != raw:
            raise ReplicaError("Directory version index changed")
        return
    except FileNotFoundError:
        pass
    temporary = ".index-" + uuid4().hex
    fd = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=handle
    )
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    try:
        relocate(handle, temporary, handle, name + "-index")
    except FileExistsError:
        if read_file(handle, name + "-index") != raw:
            raise ReplicaError("Directory version index changed") from None
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=handle)


def read_index(handle: int, name: str, expected: dict[str, Any]) -> list[dict[str, Any]]:
    from cairndex.replicas.source_files import source_path
    from cairndex.replicas.source_receipts import ContentVersion

    try:
        rows = json.loads(read_file(handle, name + "-index"))
        if not isinstance(rows, list) or len(rows) > MAX_ENTRIES:
            raise ValueError("count")
        names = set()
        for row in rows:
            if type(row["directory"]) is not bool or set(row) != (
                {"path", "directory"} if row["directory"] else {"path", "directory", "evidence"}
            ):
                raise ValueError("shape")
            source_path(row["path"])
            if row["path"] in names:
                raise ValueError("duplicate")
            names.add(row["path"])
            if not row["directory"]:
                value = ContentVersion.model_validate(row["evidence"])
                if value.algorithm != "sha256":
                    raise ValueError("nested evidence")
        if evidence(rows) != expected:
            raise ValueError("digest")
        return rows
    except (ValueError, KeyError, TypeError) as error:
        raise ReplicaError("Directory version index is incomplete or inconsistent") from error
