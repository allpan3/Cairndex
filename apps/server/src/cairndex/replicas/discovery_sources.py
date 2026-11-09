"""Bounded read-only source inspection with pinned descriptors and explicit evidence strength"""

import hashlib
import os
import stat
import sys
from collections.abc import Iterator
from concurrent.futures import Executor, Future
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.media import generation, open_source
from cairndex.replicas.protocol import ReplicaError, checksum

SAMPLE = 64 * 1024


@dataclass(frozen=True)
class Entry:
    """A walk observation; its borrowed parent is valid only until the next step."""

    path: str
    info: os.stat_result
    parent: int
    directory: Path
    network: bool


def directory_path(handle: int) -> Path:
    """Check the held directory's kernel path without reopening its ancestors."""
    if sys.platform == "darwin":
        import fcntl

        raw = fcntl.fcntl(handle, 50, bytes(1024))  # F_GETPATH
        return Path(os.fsdecode(raw.split(b"\0", 1)[0]))
    return Path(os.readlink(f"/proc/self/fd/{handle}"))


# Directory descriptors reject every symlink component, including a replaced root
@contextmanager
def directory(root: Path, relative: str = "") -> Iterator[int]:
    parts = normalize_relative_path(relative).split("/") if relative else []
    if len(parts) > 64 or any(part.startswith(".") for part in parts):
        raise ReplicaError("Discovery directory is hidden or exceeds the depth limit")
    handles = []
    try:
        handles.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for part in parts:
            handles.append(
                os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=handles[-1])
            )
        yield handles[-1]
    finally:
        for handle in reversed(handles):
            os.close(handle)


# Yield once per directory entry so hidden files and deep folders also consume the step budget
def walk(root: Path) -> Iterator[Entry | None]:
    with directory(root) as handle:
        resolved = root.resolve(strict=True)
        if directory_path(handle) != resolved:
            raise ReplicaError("Discovery root changed; retry Update")
        yield from _walk(handle, resolved, "", 0, network=mounted_smb(root))


def _walk(
    handle: int, root: Path, relative: str, depth: int, *, network: bool
) -> Iterator[Entry | None]:
    if depth > 64:
        raise ReplicaError("Discovery reached the directory depth limit; no repairs were applied")
    with os.scandir(handle) as entries:
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink():
                yield None
                continue
            info = entry.stat(follow_symlinks=False)
            path = f"{relative}/{entry.name}" if relative else entry.name
            if stat.S_ISDIR(info.st_mode):
                yield None
                with _child(handle, entry.name) as child:
                    current = os.fstat(child)
                    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                        raise ReplicaError("Discovery directory changed; retry Update")
                    yield from _walk(child, root, path, depth + 1, network=network)
            elif stat.S_ISREG(info.st_mode):
                yield Entry(path, info, handle, root / relative, network)
            else:
                yield None


def mounted_smb(root: Path) -> bool:
    from cairndex.file_ops.smb_transport import mount_for

    try:
        return mount_for(root) is not None
    except OSError:
        return False


@contextmanager
def _child(parent: int, name: str) -> Iterator[int]:
    handle = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        yield handle
    finally:
        os.close(handle)


@contextmanager
def _opened(root: Path, path: str, entry: Entry | None) -> Iterator[int]:
    if entry is None:
        with open_source(root, path) as handle:
            yield handle
        return
    # The walk checked and retained every ancestor. Reuse its parent instead
    # of reopening the complete SMB path for every leaf.
    if directory_path(entry.parent) != entry.directory:
        raise ReplicaError("Discovery directory moved; retry Update")
    handle = os.open(
        path.rsplit("/", 1)[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=entry.parent
    )
    try:
        if not stat.S_ISREG(os.fstat(handle).st_mode):
            raise ReplicaError("Discovery source is no longer a regular file")
        yield handle
        if directory_path(entry.parent) != entry.directory:
            raise ReplicaError("Discovery directory moved; retry Update")
    finally:
        os.close(handle)


def submit(
    executor: Executor, root: Path, entry: Entry, cached: dict[str, Any] | None
) -> Future[dict[str, Any]]:
    """Give a worker its own parent before advancing the directory iterator."""
    held = replace(entry, parent=os.dup(entry.parent))
    try:
        return executor.submit(_inspect_owned, root, held, cached)
    except BaseException:
        os.close(held.parent)
        raise


def _inspect_owned(root: Path, entry: Entry, cached: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return inspect(root, entry.path, cached, entry=entry)
    finally:
        os.close(entry.parent)


# Complete small-file hashes and large-file samples are never interchangeable identity claims
def inspect(
    root: Path,
    path: str,
    cached: dict[str, Any] | None = None,
    *,
    entry: Entry | None = None,
) -> dict[str, Any]:
    if entry:
        normalize_relative_path(path)
        if entry.path != path or directory_path(entry.parent) != entry.directory:
            raise ReplicaError("Discovery directory moved; retry Update")
        if cached and cached["generation"] == generation(path, entry.info):
            return cached
    with _opened(root, path, entry) as handle:
        info = os.fstat(handle)
        token = generation(path, info)
        if entry is None and cached and cached["generation"] == token:
            return cached
        digest = hashlib.sha256()
        if info.st_size <= SAMPLE * 3:
            data = os.pread(handle, info.st_size, 0)
            if len(data) != info.st_size:
                raise ReplicaError("Source delivery is incomplete; retry Update")
            digest.update(data)
            algorithm = "sha256"
        else:
            algorithm = "sample-sha256-v1"
            for offset in (0, (info.st_size - SAMPLE) // 2, info.st_size - SAMPLE):
                data = os.pread(handle, SAMPLE, offset)
                if len(data) != SAMPLE:
                    raise ReplicaError("Source delivery is incomplete; retry Update")
                digest.update(offset.to_bytes(8, "big"))
                digest.update(data)
        if generation(path, os.fstat(handle)) != token:
            raise ReplicaError("Source changed while being read; retry Update")
        return {
            "path": path,
            "generation": token,
            "evidence": {
                "algorithm": algorithm,
                "size": info.st_size,
                "digest": digest.hexdigest(),
            },
            "device": info.st_dev,
            "inode": info.st_ino,
            "mtime": info.st_mtime_ns,
        }


# Only complete evidence creates a portable discovery identity; large samples remain private
def file_id(library: str, epoch: str, observation: dict[str, Any]) -> str:
    from cairndex.core.ids import new_id

    if observation["evidence"]["algorithm"] != "sha256":
        return new_id()
    return stable_id([library, epoch, observation["path"], observation["evidence"]])


# Use the existing 26-character identity width while retaining 130 bits of digest entropy
def stable_id(value: Any) -> str:
    import base64

    return base64.b32encode(bytes.fromhex(checksum(value_text(value).encode()))).decode()[:26]


# Revalidate each expected absence explicitly instead of inferring it from a partial folder walk
def absent(root: Path, path: str) -> bool:
    try:
        with open_source(root, path):
            return False
    except FileNotFoundError:
        return True


def confirms(
    baseline: dict[str, Any] | None, path: str, expected: dict[str, Any], new: dict[str, Any]
) -> bool:
    """Whether a complete hash still covers a same-path file seen only through samples.

    The baseline must hold that hash, the samples read with it, and an inode and
    mtime that are unchanged; the samples fix the size. The device number is not
    compared, because macOS numbers a network share anew on every mount. An edit
    outside the sampled regions that keeps size, mtime and inode stays undetected
    until Verify complete content, as it does for files whose evidence is a sample.
    """
    return (
        baseline is not None
        and baseline["path"] == path
        and expected["algorithm"] == "sha256"
        and baseline["evidence"] == expected
        and baseline.get("sample") == new["evidence"]
        and bool(baseline.get("inode"))
        and baseline.get("inode") == new["inode"]
        and baseline.get("mtime") == new["mtime"]
    )


# A sample match requires an earlier local physical identity; full evidence is portable
def matches(old: dict[str, Any], new: dict[str, Any]) -> bool:
    return old["evidence"] == new["evidence"] and (
        old["evidence"]["algorithm"] == "sha256"
        or (old.get("device"), old.get("inode")) == (new["device"], new["inode"])
        and bool(old.get("device"))
        and bool(old.get("inode"))
    )
