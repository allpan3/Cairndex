"""Publish complete files safely through macOS SMB mounts"""

import ctypes
import ctypes.util
import errno
import os
import sys
import threading
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import unquote, urlsplit

import smbclient  # type: ignore[import-untyped]


class SmbTransportError(OSError):
    """The direct SMB path is unavailable without weakening publication safety"""


@dataclass(frozen=True)
class Mount:
    """An authenticated macOS SMB mount and its local-to-remote path boundary"""

    point: Path
    server: str
    share: str
    account: str


class _DarwinStatfs(ctypes.Structure):
    """The macOS 64-bit-inode statfs layout through the mounted-source fields"""

    _fields_ = [
        ("f_bsize", ctypes.c_uint32),
        ("f_iosize", ctypes.c_int32),
        ("f_blocks", ctypes.c_uint64),
        ("f_bfree", ctypes.c_uint64),
        ("f_bavail", ctypes.c_uint64),
        ("f_files", ctypes.c_uint64),
        ("f_ffree", ctypes.c_uint64),
        ("f_fsid", ctypes.c_int32 * 2),
        ("f_owner", ctypes.c_uint32),
        ("f_type", ctypes.c_uint32),
        ("f_flags", ctypes.c_uint32),
        ("f_fssubtype", ctypes.c_uint32),
        ("f_fstypename", ctypes.c_char * 16),
        ("f_mntonname", ctypes.c_char * 1024),
        ("f_mntfromname", ctypes.c_char * 1024),
        ("f_flags_ext", ctypes.c_uint32),
        ("f_reserved", ctypes.c_uint32 * 7),
    ]


_lock = threading.RLock()
_keychain_lock = threading.Lock()
_connected: set[tuple[str, str]] = set()
_roots: dict[Path, Mount] = {}
_KEYCHAIN_TIMEOUT = 20.0


# Decode the kernel's nul-terminated fixed-size string fields
def _field(value: bytes) -> str:
    return value.split(b"\0", 1)[0].decode("utf-8", "strict")


# Parse only the mounted-source form emitted by macOS smbfs
def _parse_mount(point: str, source: str) -> Mount:
    parsed = urlsplit(f"smb:{source}")
    if parsed.password is not None or not parsed.hostname or not parsed.username:
        raise SmbTransportError(errno.EINVAL, "The SMB mount identity is unsupported")
    share = unquote(parsed.path.lstrip("/"))
    if not share or "/" in share:
        raise SmbTransportError(errno.EINVAL, "The SMB share identity is unsupported")
    return Mount(
        point=Path(point),
        server=unquote(parsed.hostname).lower(),
        share=share,
        account=unquote(parsed.username),
    )


# Read the enclosing mount without invoking a shell or trusting caller-supplied URLs
def mount_for(path: Path) -> Mount | None:
    if sys.platform != "darwin":
        return None
    libc_name = ctypes.util.find_library("c")
    if libc_name is None:
        raise SmbTransportError(errno.ENOSYS, "macOS filesystem inspection is unavailable")
    libc = ctypes.CDLL(libc_name, use_errno=True)
    statfs = getattr(libc, "statfs$INODE64", None) or getattr(libc, "statfs", None)
    if statfs is None:
        raise SmbTransportError(errno.ENOSYS, "macOS filesystem inspection is unavailable")
    statfs.argtypes = [ctypes.c_char_p, ctypes.POINTER(_DarwinStatfs)]
    statfs.restype = ctypes.c_int
    buffer = _DarwinStatfs()
    # Destination files may not exist; their validated parent is on the same mount
    probe = path if path.exists() else path.parent
    if statfs(os.fsencode(probe), ctypes.byref(buffer)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), probe)
    if _field(buffer.f_fstypename) != "smbfs":
        return None
    return _parse_mount(_field(buffer.f_mntonname), _field(buffer.f_mntfromname))


# Retrieve one explicitly identified internet-password item without enumerating Keychain
def _password_sync(mount: Mount, *, allow_prompt: bool) -> str:
    framework = ctypes.util.find_library("Security")
    if framework is None:
        raise SmbTransportError(errno.ENOSYS, "macOS Keychain is unavailable")
    security = ctypes.CDLL(framework)
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    security.SecKeychainFindInternetPassword.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_uint16,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
    ]
    security.SecKeychainFindInternetPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    host, account = mount.server.encode(), mount.account.encode()
    length, data = ctypes.c_uint32(), ctypes.c_void_p()
    with _keychain_lock:
        security.SecKeychainSetUserInteractionAllowed(allow_prompt)
        try:
            status = security.SecKeychainFindInternetPassword(
                None,
                len(host),
                host,
                0,
                None,
                len(account),
                account,
                0,
                None,
                0,
                int.from_bytes(b"smb ", "big"),
                0,
                ctypes.byref(length),
                ctypes.byref(data),
                None,
            )
        finally:
            security.SecKeychainSetUserInteractionAllowed(True)
    if status != 0 or not data.value:
        if data.value:
            security.SecKeychainItemFreeContent(None, data)
        raise SmbTransportError(
            errno.EACCES,
            "The saved SMB login is unavailable; allow Keychain access and retry",
        )
    try:
        return ctypes.string_at(data, length.value).decode("utf-8")
    finally:
        security.SecKeychainItemFreeContent(None, data)


# Bound an unanswered SecurityAgent prompt so requests and shutdown can recover
def _password(mount: Mount, *, allow_prompt: bool) -> str:
    done = threading.Event()
    result: list[str] = []
    failure: list[Exception] = []

    def retrieve() -> None:
        try:
            result.append(_password_sync(mount, allow_prompt=allow_prompt))
        except Exception as error:
            failure.append(error)
        finally:
            done.set()

    threading.Thread(target=retrieve, name="smb-keychain", daemon=True).start()
    if not done.wait(_KEYCHAIN_TIMEOUT):
        raise SmbTransportError(
            errno.ETIMEDOUT,
            "SMB Keychain authorization timed out; allow access and retry",
        )
    if failure:
        raise failure[0]
    return result.pop()


# Establish one signed, encrypted SMB3 session for this server and account
def _connect(mount: Mount, *, allow_prompt: bool) -> None:
    key = (mount.server, mount.account)
    with _lock:
        if key in _connected:
            return
    password = _password(mount, allow_prompt=allow_prompt)
    try:
        session = smbclient.register_session(
            mount.server,
            username=mount.account,
            password=password,
            port=445,
            encrypt=True,
            require_signing=True,
            connection_timeout=15,
        )
    except Exception as error:
        raise SmbTransportError(
            errno.EACCES, "The SMB connection or saved login is unavailable"
        ) from error
    finally:
        password = ""
    dialect = int(session.connection.dialect)
    if dialect < 0x0300 or not session.encrypt_data:
        smbclient.delete_session(mount.server, port=445)
        raise SmbTransportError(errno.EPROTONOSUPPORT, "Encrypted SMB3 is required")
    with _lock:
        _connected.add(key)


# Retain the mounted identity for each independently open library
def register_root(root: Path) -> None:
    mount = mount_for(root)
    if mount is None:
        return
    with _lock:
        _roots[root] = mount


# Convert a validated mounted path to the same share's UNC path
def _remote(mount: Mount, path: Path) -> str:
    try:
        relative = path.relative_to(mount.point)
    except ValueError as error:
        raise SmbTransportError(errno.EPERM, "The path is outside its SMB mount") from error
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise SmbTransportError(errno.EPERM, "The SMB path is invalid")
    return str(PureWindowsPath(f"//{mount.server}/{mount.share}").joinpath(*relative.parts))


# Observe server identity after stabilizing only completed staging bytes
def observation(path: Path, *, allow_prompt: bool = False) -> dict[str, Any] | None:
    mount = mount_for(path)
    if mount is None:
        return None
    _connect(mount, allow_prompt=allow_prompt)
    if path.suffix == ".part" and path.parent.name == "tmp":
        native = path.stat()
        with path.open("rb") as handle:
            os.fsync(handle.fileno())
        os.utime(path, ns=(native.st_atime_ns, native.st_mtime_ns))
    stat = smbclient.stat(_remote(mount, path), port=445, follow_symlinks=False)
    return {
        "kind": "smb3",
        "version": 1,
        "server": mount.server,
        "share": mount.share,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "file_id": stat.st_ino,
        "volume_serial": stat.st_dev,
    }


# Match a versioned server observation without prompting during recovery
def matches(path: Path, expected: dict[str, Any]) -> bool:
    mount = mount_for(path)
    if mount is None or expected.get("kind") != "smb3" or expected.get("version") != 1:
        return False
    if expected.get("server") != mount.server or expected.get("share") != mount.share:
        raise SmbTransportError(errno.EXDEV, "The SMB mount no longer names the recorded share")
    return observation(path, allow_prompt=False) == expected


# Prove direct and mounted paths name the same file before displacing originals
def check_hard_links(staging: Path) -> bool:
    mount = mount_for(staging)
    if mount is None:
        return False
    _connect(mount, allow_prompt=True)
    probe = staging.with_suffix(".link")
    try:
        smbclient.link(_remote(mount, staging), _remote(mount, probe), port=445)
        with probe.open("rb") as visible:
            visible.read(0)
        source = smbclient.stat(_remote(mount, staging), port=445, follow_symlinks=False)
        linked = smbclient.stat(_remote(mount, probe), port=445, follow_symlinks=False)
        if (source.st_dev, source.st_ino) != (linked.st_dev, linked.st_ino):
            raise SmbTransportError(errno.EXDEV, "The mounted and direct SMB paths disagree")
    finally:
        with suppress(OSError):
            probe.unlink()
    return True


# Publish one complete staged file without overwriting a concurrent arrival
def publish(source: Path, destination: Path) -> bool:
    mount = mount_for(source)
    if mount is None:
        return False
    if mount_for(destination) != mount:
        raise SmbTransportError(errno.EXDEV, "SMB publication crossed a mount boundary")
    _connect(mount, allow_prompt=True)
    smbclient.link(_remote(mount, source), _remote(mount, destination), port=445)
    with destination.open("rb") as visible:
        visible.read(0)
    source.unlink()
    return True


# Release authenticated transport state during server shutdown
def close_sessions() -> None:
    with _lock:
        servers = {server for server, _account in _connected}
        _connected.clear()
        _roots.clear()
    for server in servers:
        with suppress(Exception):
            smbclient.delete_session(server, port=445)


# Release a server session once its last mounted library closes
def close_root(root: Path) -> None:
    with _lock:
        removed = _roots.pop(root, None)
        if removed is None:
            return
        active_servers = {mount.server for mount in _roots.values()}
        if removed.server in active_servers:
            return
        _connected.difference_update({key for key in _connected if key[0] == removed.server})
    with suppress(Exception):
        # smbclient pools one connection per server and closes all account sessions
        smbclient.delete_session(removed.server, port=445)
