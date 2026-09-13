"""Bounded read-only source inspection with pinned descriptors and explicit evidence strength"""

import hashlib
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.media import generation, open_source
from cairndex.replicas.protocol import ReplicaError, checksum

SAMPLE = 64 * 1024


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
def walk(root: Path, relative: str = "", depth: int = 0) -> Iterator[str | None]:
    if depth > 64:
        raise ReplicaError("Discovery reached the directory depth limit; no repairs were applied")
    with directory(root, relative) as handle, os.scandir(handle) as entries:
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink():
                yield None
                continue
            path = f"{relative}/{entry.name}" if relative else entry.name
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                yield None
                yield from walk(root, path, depth + 1)
            elif stat.S_ISREG(info.st_mode):
                yield path
            else:
                yield None


# Complete small-file hashes and large-file samples are never interchangeable identity claims
def inspect(root: Path, path: str, cached: dict[str, Any] | None = None) -> dict[str, Any]:
    with open_source(root, path) as handle:
        info = os.fstat(handle)
        token = generation(path, info)
        if cached and cached["generation"] == token:
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


# A sample match requires an earlier local physical identity; full evidence is portable
def matches(old: dict[str, Any], new: dict[str, Any]) -> bool:
    return old["evidence"] == new["evidence"] and (
        old["evidence"]["algorithm"] == "sha256"
        or (old.get("device"), old.get("inode")) == (new["device"], new["inode"])
        and bool(old.get("device"))
        and bool(old.get("inode"))
    )
