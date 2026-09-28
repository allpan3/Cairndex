"""Pinned source paths and independent recovery copies for portable operations."""

import hashlib
import os
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any

from cairndex.core.paths import normalize_relative_path
from cairndex.file_ops.exclusive import relocate
from cairndex.file_ops.paths import validate_name
from cairndex.replicas.discovery_sources import directory
from cairndex.replicas.media import generation
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.transport import directory as metadata_directory

BLOCK = 1024 * 1024


def source_path(raw: str) -> str:
    """Reject hidden paths and noncanonical names before any filesystem access."""
    normalized = normalize_relative_path(raw)
    if not normalized or normalized != raw or len(raw.split("/")) > 64:
        raise ReplicaError("A canonical library-relative source path is required")
    for part in raw.split("/"):
        if validate_name(part) != part:
            raise ReplicaError("Source path contains an unsupported name")
    return normalized


@contextmanager
def parent(root: Path, path: str) -> Iterator[tuple[int, str]]:
    """Pin each directory without following a symlink or crossing a mount."""
    source_path(path)
    relative, _, name = path.rpartition("/")
    with directory(root, relative) as handle:
        root_info = root.stat(follow_symlinks=False)
        if os.fstat(handle).st_dev != root_info.st_dev:
            raise ReplicaError("Source operations cannot cross filesystem boundaries")
        yield handle, name


def validate_parent(root: Path, path: str, handle: int) -> None:
    """Refuse a detached or replaced parent before a source namespace mutation."""
    relative, _, _ = path.rpartition("/")
    with directory(root, relative) as current:
        before, now = os.fstat(handle), os.fstat(current)
        if (before.st_dev, before.st_ino) != (now.st_dev, now.st_ino):
            raise ReplicaError("Source parent changed; source operations are stopped")


def observation(root: Path, path: str) -> dict[str, Any] | None:
    """Capture a bounded precondition; hashing belongs to the operation worker."""
    with parent(root, path) as (handle, name):
        try:
            info = os.stat(name, dir_fd=handle, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISDIR(info.st_mode):
            from cairndex.replicas.source_trees import descend, identity

            with descend(handle, name) as folder:
                observed, size = identity(folder)
            return {
                "generation": generation(path, info) + ":" + observed[-1],
                "size": size,
                "identity": observed,
                "kind": "directory",
            }
        if not stat.S_ISREG(info.st_mode):
            raise ReplicaError("Source operation requires a regular file")
        return {
            "generation": generation(path, info),
            "size": info.st_size,
            "identity": [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns],
        }


def assert_observation(root: Path, path: str, expected: dict[str, Any] | None) -> None:
    """A reviewed absence is a condition, never an overwrite permission."""
    if observation(root, path) != expected:
        raise ReplicaError("Source path changed after review; prepare a new review")


@contextmanager
def operation_directory(root: Path, operation: str, *, create: bool = False) -> Iterator[int]:
    """Keep operation artifacts separate from authored catalog transport."""
    from cairndex.replicas.catalog.model import TOKEN

    if not TOKEN.fullmatch(operation):
        raise ReplicaError("Invalid source operation identity")
    with metadata_directory(
        root, [".cairndex", "source-operations", operation], create=create
    ) as handle:
        if os.fstat(handle).st_dev != root.stat(follow_symlinks=False).st_dev:
            raise ReplicaError("Recovery storage must use the source filesystem")
        yield handle


def copy_stream(
    source: int,
    destination: int,
    *,
    progress: Callable[[int], None],
    limit: int,
) -> dict[str, Any]:
    """Make an independent full copy in bounded blocks, with a stable read check.

    An external writer can change an open inode. Detect observable changes and keep
    the incomplete copy private. A digest is evidence for the bytes read, not proof
    against an adversarial writer that can conceal concurrent changes.
    """
    before = os.fstat(source)
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ReplicaError("Source exceeds the operation byte limit or is not a regular file")
    saved = os.fstat(destination)
    if (
        not stat.S_ISREG(saved.st_mode)
        or saved.st_nlink != 1
        or (saved.st_dev, saved.st_ino) == (before.st_dev, before.st_ino)
        or saved.st_size > before.st_size
    ):
        raise ReplicaError("Incomplete recovery copy does not match its source")
    digest, offset = hashlib.sha256(), 0
    while offset < before.st_size:
        progress(offset)
        if os.fstat(destination).st_nlink != 1:
            raise ReplicaError("Recovery copy acquired another link; writes are stopped")
        block = os.pread(source, min(BLOCK, before.st_size - offset), offset)
        if not block:
            raise ReplicaError("Source delivery is incomplete")
        retained = min(len(block), max(0, saved.st_size - offset))
        if retained and os.pread(destination, retained, offset) != block[:retained]:
            raise ReplicaError("Incomplete recovery copy changed; retain it for review")
        view = memoryview(block)[retained:]
        os.lseek(destination, offset + retained, os.SEEK_SET)
        while view:
            written = os.write(destination, view)
            if written <= 0:
                raise OSError("Recovery copy could not be written")
            view = view[written:]
        digest.update(block)
        offset += len(block)
    progress(offset)
    if generation("", before) != generation("", os.fstat(source)):
        raise ReplicaError("Source changed during the recovery copy")
    os.fsync(destination)
    return {"algorithm": "sha256", "size": offset, "digest": digest.hexdigest()}


def snapshot(
    root: Path,
    path: str,
    operation: str,
    name: str,
    expected: dict[str, Any],
    *,
    progress: Callable[[int], None],
    limit: int,
) -> dict[str, Any]:
    """Create a recovery version before a destructive step; never reuse partial bytes."""
    if name not in ("source", "destination", "output"):
        raise ReplicaError("Invalid recovery version name")
    with (
        parent(root, path) as (source_parent, leaf),
        operation_directory(root, operation, create=True) as target_parent,
    ):
        if expected.get("kind") == "directory":
            from cairndex.replicas.source_trees import copy_tree, descend, save_index
            from cairndex.replicas.source_trees import evidence as tree_evidence

            assert_observation(root, path, expected)
            complete = True
            try:
                os.stat(name, dir_fd=target_parent, follow_symlinks=False)
            except FileNotFoundError:
                complete = False
                with suppress(FileExistsError):
                    os.mkdir(name + ".partial", 0o700, dir_fd=target_parent)
            with (
                descend(source_parent, leaf) as source,
                descend(target_parent, name if complete else name + ".partial") as target,
            ):
                manifest = copy_tree(source, target, progress, limit, complete=complete)
            assert_observation(root, path, expected)
            save_index(target_parent, name, manifest)
            if not complete:
                relocate(target_parent, name + ".partial", target_parent, name)
            return tree_evidence(manifest)
        source = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        try:
            if generation(path, os.fstat(source)) != expected["generation"]:
                raise ReplicaError("Source changed before its recovery copy")
            complete = False
            try:
                target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=target_parent)
                complete = True
            except FileNotFoundError:
                target = os.open(
                    name + ".partial",
                    os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=target_parent,
                )
            try:
                evidence = copy_stream(source, target, progress=progress, limit=limit)
            finally:
                os.close(target)
            assert_observation(root, path, expected)
            if not complete:
                relocate(target_parent, name + ".partial", target_parent, name)
            return evidence
        finally:
            os.close(source)


def capture(root: Path, path: str, operation: str, name: str, expected: dict[str, Any]) -> None:
    """Capture a source entry without overwrite; retain unexpected bytes for recovery.

    The caller must commit intent and an independent recovery version first. The
    rename can capture a concurrent replacement. Post-validation detects that case;
    the captured bytes are retained and never assigned the reviewed file identity.
    """
    if name not in ("captured-source", "captured-destination"):
        raise ReplicaError("Invalid captured source name")
    assert_observation(root, path, expected)
    with (
        parent(root, path) as (source_parent, leaf),
        operation_directory(root, operation) as target_parent,
    ):
        validate_parent(root, path, source_parent)
        relocate(source_parent, leaf, target_parent, name)
        info = os.stat(name, dir_fd=target_parent, follow_symlinks=False)
        # Rename changes ctime on some hosts. Preserve the complete pre-rename
        # descriptor observation separately when the worker records its intent.
        actual = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
        if stat.S_ISDIR(info.st_mode):
            from cairndex.replicas.source_trees import descend, identity

            with descend(target_parent, name) as folder:
                actual, _ = identity(folder)
        if (
            not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
            or actual != expected["identity"]
        ):
            raise ReplicaError("Captured source changed; retained bytes require recovery review")


def artifact_identity(root: Path, operation: str, name: str) -> list[Any] | None:
    """Read only known operation artifact names, never a client path."""
    if name not in (
        "source",
        "destination",
        "output-stage",
        "output-stage-0",
        "output-stage-1",
        "captured-source",
        "captured-destination",
    ):
        raise ReplicaError("Unsupported source artifact")
    with operation_directory(root, operation) as handle:
        try:
            info = os.stat(name, dir_fd=handle, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISDIR(info.st_mode):
            from cairndex.replicas.source_trees import descend, identity

            with descend(handle, name) as folder:
                result, _ = identity(folder)
                return result
        if not stat.S_ISREG(info.st_mode):
            raise ReplicaError("Recovery artifact is not a regular file")
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def stage_output(
    root: Path,
    operation: str,
    version_operation: str,
    version: str,
    expected: dict[str, Any],
    progress: Callable[[int], None],
    limit: int,
    name: str = "output-stage",
) -> list[Any]:
    """Publication uses an independent copy so later edits cannot change a version."""
    if version not in ("source", "destination"):
        raise ReplicaError("Unsupported source version")
    if name not in ("output-stage", "output-stage-0", "output-stage-1"):
        raise ReplicaError("Unsupported source output")
    with (
        operation_directory(root, version_operation) as source_parent,
        operation_directory(root, operation, create=True) as target_parent,
    ):
        if expected["algorithm"] == "tree-sha256-v1":
            from cairndex.replicas.source_trees import (
                copy_tree,
                descend,
                identity,
                read_index,
            )
            from cairndex.replicas.source_trees import (
                evidence as tree_evidence,
            )

            read_index(source_parent, version, expected)
            with suppress(FileExistsError):
                os.mkdir(name, 0o700, dir_fd=target_parent)
            with descend(source_parent, version) as source, descend(target_parent, name) as target:
                manifest = copy_tree(source, target, progress, limit)
                if tree_evidence(manifest) != expected:
                    raise ReplicaError("Recovery directory differs from the recorded version")
                result, _ = identity(target)
                return result
        source = os.open(version, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        try:
            target = os.open(
                name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=target_parent
            )
            try:
                evidence = copy_stream(source, target, progress=progress, limit=limit)
                if evidence != expected:
                    raise ReplicaError("Recovery bytes differ from the recorded content version")
                info = os.fstat(target)
                return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
            finally:
                os.close(target)
        finally:
            os.close(source)


def publish_output(
    root: Path, operation: str, destination: str, expected: list[Any], stage: str = "output-stage"
) -> None:
    """Resume a no-replace publication only from its recorded physical object."""
    if stage not in ("output-stage", "output-stage-0", "output-stage-1"):
        raise ReplicaError("Unsupported source output")
    staged = artifact_identity(root, operation, stage)
    if staged is None:
        visible = observation(root, destination)
        if visible and visible["identity"] == expected:
            return
        raise ReplicaError(
            "Published output is unavailable or changed; recovery review is required"
        )
    if staged != expected:
        raise ReplicaError("Staged output changed; retained bytes require recovery review")
    with (
        operation_directory(root, operation) as source_parent,
        parent(root, destination) as (target_parent, name),
    ):
        validate_parent(root, destination, target_parent)
        relocate(source_parent, stage, target_parent, name)
    visible = observation(root, destination)
    if visible is None or visible["identity"] != expected:
        raise ReplicaError("Published output changed; recovery review is required")
