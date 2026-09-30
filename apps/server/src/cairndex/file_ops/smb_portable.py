"""Authenticated SMB publication from validated, held macOS directory descriptors."""

import errno
import hashlib
import json
import os
import stat
import sys
import time
from pathlib import Path

from smbprotocol.open import FilePipePrinterAccessMask as Access  # type: ignore[import-untyped]

from cairndex.file_ops import smb_handles, smb_transport

VISIBILITY_TIMEOUT = 5.0


def _uncache(handle: int) -> None:
    import fcntl

    # Darwin F_NOCACHE followed by fsync and close discards cached file pages.
    fcntl.fcntl(handle, 48, 1)
    os.fsync(handle)


def _refresh_data(path: Path) -> None:
    handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if stat.S_ISREG(os.fstat(handle).st_mode):
            _uncache(handle)
    finally:
        os.close(handle)


def refresh(parent: int, name: str) -> None:
    """Discard stale mounted pages before reopening a source for observation."""
    if name in ("", ".", "..") or "/" in name or "\\" in name:
        raise ValueError("SMB refresh requires a single directory entry name")
    if sys.platform == "darwin":
        path = directory_path(parent) / name
        if smb_transport._mount(path) is not None:
            _refresh_data(path)


def _visible(
    source: Path, target: Path, expected: dict[str, int], *, move: bool, folder: bool
) -> None:
    """Wait for bounded mounted visibility without removing cached or arriving names.

    This checks namespace visibility, type and length only. Callers still verify
    immutable bytes or the complete private source identity before completion.
    """
    deadline = time.monotonic() + VISIBILITY_TIMEOUT
    while True:
        absent = not move
        if move:
            try:
                source.stat(follow_symlinks=False)
            except FileNotFoundError:
                absent = True
        try:
            _refresh_data(target)
            mounted = smb_transport._mounted(target)
            matches = (
                stat.S_ISDIR(mounted.st_mode)
                if folder
                else (stat.S_ISREG(mounted.st_mode) and mounted.st_size == expected["size"])
            )
        except FileNotFoundError:
            matches = False
        if absent and matches:
            return
        if time.monotonic() >= deadline:
            raise OSError(
                errno.EAGAIN, "SMB mounted visibility is pending; retain the operation for retry"
            )
        time.sleep(0.025)


def directory_path(handle: int) -> Path:
    """Resolve a held directory and refuse a detached or replaced pathname."""
    if sys.platform != "darwin":
        raise OSError(errno.ENOTSUP, "Mounted SMB descriptors require macOS")
    import fcntl

    # F_GETPATH returns the kernel path for this descriptor, not a client path.
    raw = fcntl.fcntl(handle, 50, bytes(1024))
    path = Path(os.fsdecode(raw.split(b"\0", 1)[0]))
    held, current = os.fstat(handle), path.stat(follow_symlinks=False)
    if (
        not path.is_absolute()
        or path.resolve() != path
        or not stat.S_ISDIR(held.st_mode)
        or (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino)
    ):
        raise OSError(errno.EXDEV, "The SMB parent directory changed")
    return path


def transfer(source_fd: int, source: str, target_fd: int, target: str, *, move: bool) -> bool:
    """Use a held SMB object, checked parents and an atomic no-replace request.

    A lost response remains an error. The caller retains its exact intent and
    verifies the destination on retry; this layer never guesses an outcome.
    """
    if sys.platform != "darwin":
        return False
    if any(name in ("", ".", "..") or "/" in name or "\\" in name for name in (source, target)):
        raise ValueError("SMB publication requires single directory entry names")
    origin, destination = directory_path(source_fd), directory_path(target_fd)
    with smb_transport._errors(origin, collision=True):
        mount = smb_transport._mount(origin)
        if mount is None:
            return False
        if smb_transport._mount(destination) != mount:
            raise OSError(errno.EXDEV, "SMB publication crossed a mount boundary")
        # Background exchange cannot display an unrequested Keychain prompt.
        share = smb_transport._share(mount, allow_prompt=False)
        source_path, target_path = origin / source, destination / target
        name, target_name = (
            smb_transport._name(mount, source_path),
            smb_transport._name(mount, target_path),
        )
        with share.parents(name), share.parents(target_name):
            smb_transport._challenge(share, mount, origin)
            if destination != origin:
                smb_transport._challenge(share, mount, destination)
            if directory_path(source_fd) != origin or directory_path(target_fd) != destination:
                raise OSError(errno.EXDEV, "The SMB parent directory moved")
            before = os.stat(source, dir_fd=source_fd, follow_symlinks=False)
            folder = stat.S_ISDIR(before.st_mode)
            if not stat.S_ISREG(before.st_mode) and not (move and folder):
                raise OSError(errno.EINVAL, "Unsupported SMB publication object")
            with share.open(
                name,
                access=Access.FILE_READ_ATTRIBUTES
                | (Access.DELETE if move else Access.FILE_WRITE_ATTRIBUTES),
                directory=folder,
                share_delete=move,
            ) as held:
                expected = smb_handles.observation(held)
                now = os.stat(source, dir_fd=source_fd, follow_symlinks=False)
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                    now.st_dev,
                    now.st_ino,
                    now.st_size,
                    now.st_mtime_ns,
                ):
                    raise OSError(errno.EXDEV, "The SMB source changed before publication")
                if move:
                    share.rename(held, target_name)
                else:
                    share.link(held, target_name)
                with share.open(target_name, directory=folder, share_delete=move) as published:
                    if smb_handles.observation(published) != expected:
                        raise OSError(errno.EXDEV, "The SMB publication identity changed")
            _visible(source_path, target_path, expected, move=move, folder=folder)
            if directory_path(source_fd) != origin or directory_path(target_fd) != destination:
                raise OSError(errno.EXDEV, "The SMB parent directory moved")
    return True


def identity(parent: int, name: str | None = None, *, held: int | None = None) -> list[int | str]:
    """Use native identity locally and tagged server identity on an SMB mount.

    The tag separates private SMB observations from historical native inode
    observations. These quantities never enter shared source receipts.
    """
    if name is not None and (name in ("", ".", "..") or "/" in name or "\\" in name):
        raise ValueError("SMB identity requires a single directory entry name")
    info = (
        os.fstat(held if held is not None else parent)
        if held is not None or name is None
        else os.stat(name, dir_fd=parent, follow_symlinks=False)
    )
    native: list[int | str] = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
    if sys.platform != "darwin":
        return native
    directory = directory_path(parent)
    path = directory if name is None else directory / name
    with smb_transport._errors(path):
        mount = smb_transport._mount(path)
        if mount is None:
            return native
        share = smb_transport._share(mount, allow_prompt=False)
        remote = smb_transport._name(mount, path)
        folder = stat.S_ISDIR(info.st_mode)
        if not folder and not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EINVAL, "Unsupported SMB identity object")
        with (
            share.parents(remote),
            smb_transport._errors(path, missing=True),
            share.open(remote, directory=folder) as held,
        ):
            observed = smb_handles.observation(held)
            current = (
                os.fstat(parent)
                if name is None
                else os.stat(name, dir_fd=parent, follow_symlinks=False)
            )
            if native != [current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns]:
                raise OSError(errno.EXDEV, "The mounted SMB object changed during observation")
            if not folder and (observed["size"], observed["mtime_ns"]) != (
                info.st_size,
                info.st_mtime_ns,
            ):
                raise OSError(errno.EXDEV, "The mounted and direct SMB observations disagree")
        authority = json.dumps(
            [
                mount.server,
                mount.share,
                mount.account,
                str(share.tree.session.connection.server_guid),
                observed["volume_serial"],
            ],
            separators=(",", ":"),
        )
        tag = "smb3-v1:" + hashlib.sha256(authority.encode()).hexdigest()
        return [tag, observed["file_id"], observed["size"], observed["mtime_ns"]]


def finish_staging(parent: int, name: str, before: os.stat_result) -> list[int | str]:
    """Observe owned staging after its writer closes and finalizes SMB timestamps.

    Only incomplete recovery copies and output staging may call this function.
    Original files and completed retained versions must keep their timestamps.
    """
    held = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        current = os.fstat(held)
        if (
            (before.st_dev, before.st_ino, before.st_size)
            != (current.st_dev, current.st_ino, current.st_size)
            or not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
        ):
            raise OSError(errno.EXDEV, "Completed staging changed before observation")
        if sys.platform == "darwin" and smb_transport._mount(directory_path(parent)) is not None:
            # The mounted writer's CLOSE can finalize its automatic last-write time.
            # A separate read handle sets only this owned staging object's timestamp.
            os.utime(held, ns=(before.st_atime_ns, before.st_mtime_ns))
            os.fsync(held)
        elif before.st_mtime_ns != current.st_mtime_ns:
            raise OSError(errno.EXDEV, "Completed staging changed before observation")
        return identity(parent, name, held=held)
    finally:
        os.close(held)
