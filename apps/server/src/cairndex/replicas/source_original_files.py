"""Original-object observations and no-replace relocation without reading file contents."""

import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from cairndex.file_ops.exclusive import relocate
from cairndex.file_ops.smb_portable import identity, refresh
from cairndex.file_ops.smb_transport import _FileAbsent
from cairndex.replicas.media import generation
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import operation_directory, parent, validate_parent


@contextmanager
def location(root: Path, target: dict[str, str]) -> Iterator[tuple[int, str]]:
    """Only journal-owned artifact names or validated library-relative paths."""
    if "path" in target:
        with parent(root, target["path"]) as value:
            yield value
    else:
        if target.get("name") not in {"original", "deleting"}:
            raise ReplicaError("Unsupported original-object location")
        with operation_directory(root, target["operation"]) as handle:
            relative = target.get("relative", "")
            if relative:
                from cairndex.replicas.source_files import source_path
                from cairndex.replicas.source_trees import descend

                source_path(relative)
                parent_path, _, leaf = relative.rpartition("/")
                with descend(
                    handle, target["name"] + ("/" + parent_path if parent_path else "")
                ) as nested:
                    yield nested, leaf
            else:
                yield handle, target["name"]


def observe(root: Path, target: dict[str, str]) -> dict[str, Any] | None:
    with location(root, target) as (handle, name):
        try:
            refresh(handle, name)
            held = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=handle)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(held)
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ReplicaError("Relocation requires a regular file or directory")
            return {
                "identity": identity(handle, name, held=held),
                "kind": "directory" if stat.S_ISDIR(info.st_mode) else "file",
                "size": info.st_size,
                "generation": generation(target.get("path", ""), info),
                "device": info.st_dev,
                "inode": info.st_ino,
                "mtime": info.st_mtime_ns,
            }
        except _FileAbsent:
            return None
        finally:
            os.close(held)


def matches(seen: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    # Rename may change ctime and the mounted inode. Server identity, length and
    # last-write time remain authoritative; no claim of historical bytes is made.
    return seen is not None and (seen["identity"], seen["kind"]) == (
        expected["identity"],
        expected["kind"],
    )


def parent_identity(root: Path, target: dict[str, str]) -> list[int]:
    with location(root, target) as (handle, _):
        info = os.fstat(handle)
        return [info.st_dev, info.st_ino]


def move(
    root: Path,
    origin: dict[str, str],
    target: dict[str, str],
    expected: dict[str, Any],
    origin_parent: list[int],
    target_parent: list[int],
) -> None:
    """A lost reply resumes only when the exact object is already at its target."""
    if (
        parent_identity(root, origin) != origin_parent
        or parent_identity(root, target) != target_parent
    ):
        raise ReplicaError("Source parent changed after review; recovery review is required")
    before = observe(root, origin)
    after = observe(root, target)
    if before is None and matches(after, expected):
        return
    if not matches(before, expected):
        raise ReplicaError("Original object changed or is unavailable; recovery review is required")
    if after is not None:
        raise ReplicaError("Destination exists; choose Replace, Skip or Keep Both")
    with location(root, origin) as (source_fd, source), location(root, target) as (target_fd, name):
        for loc, handle, recorded in (
            (origin, source_fd, origin_parent),
            (target, target_fd, target_parent),
        ):
            if "path" in loc:
                validate_parent(root, loc["path"], handle)
            info = os.fstat(handle)
            if [info.st_dev, info.st_ino] != recorded:
                raise ReplicaError(
                    "Source parent changed after review; recovery review is required"
                )
        relocate(source_fd, source, target_fd, name)
        for loc, handle in ((origin, source_fd), (target, target_fd)):
            if "path" in loc:
                validate_parent(root, loc["path"], handle)
    if not matches(observe(root, target), expected) or observe(root, origin) is not None:
        raise ReplicaError("Relocated object changed; recovery review is required")


def remove_entry(handle: int, name: str, expected: list[Any], *, folder: bool) -> None:
    """Delete only a checked retained entry; SMB deletes the checked open handle."""
    import sys

    from cairndex.file_ops import smb_handles, smb_transport
    from cairndex.file_ops.smb_portable import directory_path

    if sys.platform == "darwin":
        path = directory_path(handle) / name
        mount = smb_transport._mount(path)
        if mount is not None:
            from smbprotocol.open import (  # type: ignore[import-untyped]
                FilePipePrinterAccessMask as Access,
            )

            with smb_transport._errors(path, missing=True):
                share = smb_transport._share(mount, allow_prompt=False)
                remote = smb_transport._name(mount, path)
                with share.parents(remote):
                    smb_transport._challenge(share, mount, path.parent)
                    # identity() binds authority and mounted mapping before the
                    # exclusive handle prevents substitution during deletion.
                    if identity(handle, name) != expected:
                        raise ReplicaError("Retained original changed before deletion")
                    with share.open(
                        remote,
                        access=Access.FILE_READ_ATTRIBUTES | Access.DELETE,
                        directory=folder,
                        exclusive=True,
                    ) as held:
                        actual = smb_handles.observation(held)
                        if [actual["file_id"], actual["size"], actual["mtime_ns"]] != expected[1:]:
                            raise ReplicaError("Retained original changed before deletion")
                        share.remove(held)
            return
    current = os.stat(name, dir_fd=handle, follow_symlinks=False)
    if [current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns] != expected:
        raise ReplicaError("Retained original changed before deletion")
    if folder:
        os.rmdir(name, dir_fd=handle)
    else:
        os.unlink(name, dir_fd=handle)
    os.fsync(handle)


def inventory(root: Path, target: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Bound deletion by metadata only; never follow a nested link or mount."""
    from cairndex.replicas.source_trees import descend

    result: dict[str, dict[str, Any]] = {}
    with location(root, target) as (handle, name), descend(handle, name) as base:
        device = os.fstat(base).st_dev

        def visit(parent_fd: int, prefix: str, depth: int) -> None:
            if depth > 64:
                raise ReplicaError("Retained directory exceeds the deletion depth limit")
            with os.scandir(parent_fd) as children:
                for entry in children:
                    if len(result) >= 4096:
                        raise ReplicaError("Retained directory exceeds the bounded deletion review")
                    info = entry.stat(follow_symlinks=False)
                    folder = stat.S_ISDIR(info.st_mode)
                    if info.st_dev != device or (not folder and not stat.S_ISREG(info.st_mode)):
                        raise ReplicaError(
                            "Retained directory contains a linked or unsupported entry"
                        )
                    path = prefix + entry.name
                    result[path] = {"identity": identity(parent_fd, entry.name), "folder": folder}
                    if folder:
                        with descend(parent_fd, entry.name) as child:
                            visit(child, path + "/", depth + 1)

        visit(base, "", 0)
    return result


def remove_tree(
    root: Path,
    target: dict[str, str],
    expected: dict[str, Any],
    entries: dict[str, Any],
    authorize: Any,
) -> None:
    """Resume only the reviewed remaining entries; new arrivals stop deletion."""
    from cairndex.replicas.source_trees import descend

    current = observe(root, target)
    if current is None:
        return
    if current["kind"] != "directory" or current["identity"][:2] != expected["identity"][:2]:
        raise ReplicaError("Retained directory was replaced; deletion stopped")
    remaining = inventory(root, target)
    for path, item in remaining.items():
        prior = entries.get(path)
        if (
            prior is None
            or item["folder"] != prior["folder"]
            or (
                item["identity"][:2] != prior["identity"][:2]
                if item["folder"]
                else item["identity"] != prior["identity"]
            )
        ):
            raise ReplicaError("Retained directory contents changed; deletion stopped")
    with location(root, target) as (handle, name), descend(handle, name) as base:
        if identity(handle, name)[:2] != expected["identity"][:2]:
            raise ReplicaError("Retained directory changed before deletion")
        for path in sorted(remaining, key=lambda path: (-path.count("/"), path)):
            authorize()
            relative, _, leaf = path.rpartition("/")
            with descend(base, relative) as parent_fd:
                if relative and identity(parent_fd)[:2] != entries[relative]["identity"][:2]:
                    raise ReplicaError("Retained parent changed; deletion stopped")
                item = remaining[path]
                actual = identity(parent_fd, leaf)
                if item["folder"]:
                    if actual[:2] != item["identity"][:2]:
                        raise ReplicaError("Retained child directory changed; deletion stopped")
                elif actual != item["identity"]:
                    raise ReplicaError("Retained child file changed; deletion stopped")
                remove_entry(parent_fd, leaf, actual, folder=item["folder"])
        actual = identity(handle, name)
        if actual[:2] != expected["identity"][:2]:
            raise ReplicaError("Retained directory changed before deletion")
        authorize()
        remove_entry(handle, name, actual, folder=True)
