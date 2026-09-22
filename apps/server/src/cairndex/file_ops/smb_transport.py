"""Publish complete files safely through macOS SMB mounts"""

import ctypes
import ctypes.util
import errno
import os
import secrets
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import unquote, urlsplit

import smbclient  # type: ignore[import-untyped]
from smbprotocol.exceptions import SMBException  # type: ignore[import-untyped]
from smbprotocol.header import NtStatus  # type: ignore[import-untyped]
from smbprotocol.open import FilePipePrinterAccessMask as Access  # type: ignore[import-untyped]

from cairndex.file_ops import smb_handles


class SmbTransportError(OSError):
    """The direct SMB path is unavailable without weakening publication safety"""

    ntstatus: int | None = None


class _FileAbsent(FileNotFoundError):
    """A definite leaf absence after its enclosing share and directory were verified"""


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
_connected: dict[tuple[str, str], Any] = {}
_connections: dict[tuple[str, str], dict[str, Any]] = {}
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
    if not share or any(character in share for character in "/\\:\0") or parsed.port is not None:
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


# Preserve only definite file absence and occupied-name errors as ordinary filesystem outcomes
@contextmanager
def _errors(
    path: Path | None = None, *, missing: bool = False, collision: bool = False
) -> Iterator[None]:
    try:
        yield
    except (SmbTransportError, _FileAbsent):
        raise
    except (OSError, SMBException, ValueError) as error:
        status = getattr(error, "ntstatus", getattr(error, "status", None))
        code = getattr(error, "errno", None)
        absent = status in {
            NtStatus.STATUS_OBJECT_NAME_NOT_FOUND,
            NtStatus.STATUS_OBJECT_PATH_NOT_FOUND,
        }
        if missing and (absent or (status is None and code == errno.ENOENT)):
            raise _FileAbsent(errno.ENOENT, "The SMB file is absent") from None
        if collision and (status == NtStatus.STATUS_OBJECT_NAME_COLLISION or code == errno.EEXIST):
            raise FileExistsError(errno.EEXIST, "The SMB destination is occupied") from None
        if path is not None:
            with suppress(OSError):
                mount = mount_for(path)
                if mount is not None:
                    with _lock:
                        _release((mount.server, mount.account))
        failure = SmbTransportError(
            code or errno.EIO, "The SMB identity or publication path is unavailable"
        )
        failure.ntstatus = status
        raise failure from None


# Establish an isolated signed, encrypted SMB3 session for the mounted account
# Failed connections are discarded so the next attempt retrieves the exact login again
def _connect(mount: Mount, *, allow_prompt: bool) -> Any:
    key = (mount.server, mount.account)
    with _lock:
        session = _connected.get(key)
        if session is not None and session.connection.transport.connected:
            return session
        _release(key)
        cache: dict[str, Any] = {}
        _connections[key] = cache
        try:
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
                    connection_cache=cache,
                )
            finally:
                password = ""
            if (
                int(session.connection.dialect) < 0x0300
                or not session.encrypt_data
                or not session.connection.require_signing
                or session.username != mount.account
                or session.connection.server_name.lower() != mount.server.lower()
            ):
                raise SmbTransportError(
                    errno.EPROTONOSUPPORT, "Authenticated encrypted SMB3 is required"
                )
            _connected[key] = session
            return session
        except SmbTransportError:
            _release(key)
            raise
        except Exception:
            _release(key)
            raise SmbTransportError(
                errno.EACCES, "The SMB connection or saved login is unavailable"
            ) from None


# Close only this account's private pool, leaving other libraries and clients intact
def _release(key: tuple[str, str]) -> None:
    _connected.pop(key, None)
    cache = _connections.pop(key, None)
    if cache is not None:
        with suppress(Exception):
            smbclient.delete_session(key[0], port=445, connection_cache=cache, timeout=15)


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


# Refuse a disappeared or remapped library mount before interpreting file absence
def _mount(path: Path) -> Mount | None:
    mount = mount_for(path)
    with _lock:
        for root, registered in _roots.items():
            if path.is_relative_to(root) and mount != registered:
                raise SmbTransportError(errno.EXDEV, "The SMB library mount changed")
    return mount


# Bind every request directly to the mounted account and share without DFS resolution
def _share(mount: Mount, *, allow_prompt: bool) -> smb_handles.Share:
    return smb_handles.Share(_connect(mount, allow_prompt=allow_prompt), mount.server, mount.share)


# Reject path syntax that Windows would reinterpret inside a validated POSIX component
def _name(mount: Mount, path: Path) -> str:
    _remote(mount, path)
    parts = path.relative_to(mount.point).parts
    if any(
        any(character in part for character in "\\:\0") or part.endswith((".", " "))
        for part in parts
    ):
        raise SmbTransportError(errno.EPERM, "The SMB path is ambiguous")
    return "\\".join(parts)


# Read a nonce through the mount while retaining the native file identity
def _mounted(path: Path, expected: bytes | None = None) -> os.stat_result:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if expected is not None and os.read(descriptor, len(expected) + 1) != expected:
            raise SmbTransportError(errno.EXDEV, "The mounted and direct SMB paths disagree")
        return info
    finally:
        os.close(descriptor)


# Refresh smbfs name caches after direct handle deletion without deleting by pathname
def _refresh_absence(path: Path) -> None:
    with suppress(OSError):
        _mounted(path)


# Prove each directory mapping with fresh bytes visible through both access paths
# Delete-on-close applies only to the exclusively created challenge handle
def _challenge(share: smb_handles.Share, mount: Mount, directory: Path) -> None:
    nonce = secrets.token_bytes(32)
    path = directory / f".cairndex-map-{secrets.token_hex(16)}"
    with share.open(
        _name(mount, path),
        access=Access.FILE_WRITE_DATA | Access.FILE_READ_ATTRIBUTES,
        create=True,
        temporary=True,
    ) as handle:
        handle.write(nonce, write_through=True)
        handle.flush()
        _mounted(path, nonce)
    _refresh_absence(path)
    if _mount(directory) != mount:
        raise SmbTransportError(errno.EXDEV, "The SMB mount changed during verification")


# Observe server identity after stabilizing only completed staging bytes
def observation(path: Path, *, allow_prompt: bool = False) -> dict[str, Any] | None:
    with _errors(path):
        mount = _mount(path)
        if mount is None:
            return None
        share = _share(mount, allow_prompt=allow_prompt)
        if path.suffix == ".part" and path.parent.name == "tmp":
            native = path.stat()
            with path.open("rb") as handle:
                os.fsync(handle.fileno())
            os.utime(path, ns=(native.st_atime_ns, native.st_mtime_ns))
        name = _name(mount, path)
        with share.parents(name):
            # Parent/mapping failures remain unavailable even when their status resembles absence
            with _errors(path):
                _challenge(share, mount, path.parent)
            with _errors(path, missing=True), share.open(name) as remote:
                observed = smb_handles.observation(remote)
        return {
            "kind": "smb3",
            "version": 2,
            "server": mount.server,
            "share": mount.share,
            "account": mount.account,
            "server_guid": str(share.tree.session.connection.server_guid),
            **observed,
        }


# Match old receipts without upgrading their evidence and bind new ones to account/server identity
def matches(path: Path, expected: dict[str, Any]) -> bool:
    with _errors(path):
        mount = _mount(path)
        if expected.get("kind") != "smb3" or expected.get("version") not in {1, 2}:
            raise SmbTransportError(errno.EINVAL, "The SMB receipt is unsupported")
        if (
            mount is None
            or expected.get("server") != mount.server
            or expected.get("share") != mount.share
        ):
            raise SmbTransportError(errno.EXDEV, "The SMB mount no longer names the recorded share")
        if expected.get("version") == 2 and expected.get("account") != mount.account:
            raise SmbTransportError(errno.EXDEV, "The SMB mount account changed")
        current = observation(path, allow_prompt=False)
        assert current is not None
        if expected.get("version") == 1:
            current = {
                key: value
                for key, value in current.items()
                if key not in {"account", "server_guid"}
            }
            current["version"] = 1
        elif expected.get("server_guid") != current["server_guid"]:
            raise SmbTransportError(errno.EXDEV, "The SMB server identity changed")
        return current == expected


# Confirm bounded mounted visibility without trusting smbfs per-name inode values
# The random directory challenge and server hard-link identity establish the mapping
def _sample(path: Path) -> tuple[int, list[bytes]]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        size = os.fstat(descriptor).st_size
        chunks = []
        for offset in sorted({0, max(0, size // 2 - 2048), max(0, size - 4096)}):
            os.lseek(descriptor, offset, os.SEEK_SET)
            chunks.append(os.read(descriptor, min(4096, size - offset)))
        return size, chunks
    finally:
        os.close(descriptor)


# Prove hard-link capability before displacement and remove only the owned probe handle
def check_hard_links(staging: Path) -> bool:
    with _errors(staging, collision=True):
        mount = _mount(staging)
        if mount is None:
            return False
        share = _share(mount, allow_prompt=True)
        name = _name(mount, staging)
        probe = staging.with_suffix(".link")
        probe_name = _name(mount, probe)
        with share.parents(name):
            _challenge(share, mount, staging.parent)
            native = _sample(staging)
            with share.open(
                name, access=Access.FILE_READ_ATTRIBUTES | Access.FILE_WRITE_ATTRIBUTES
            ) as source:
                expected = smb_handles.observation(source)
                share.link(source, probe_name)
            visible = native == _sample(probe)
            # A failed link never reaches cleanup; a replaced probe never matches the held identity
            with share.open(
                probe_name, access=Access.FILE_READ_ATTRIBUTES | Access.DELETE, exclusive=True
            ) as linked:
                if smb_handles.observation(linked) != expected:
                    raise SmbTransportError(errno.EXDEV, "The SMB capability probe changed")
                try:
                    if not visible:
                        raise SmbTransportError(
                            errno.EXDEV, "The mounted and direct SMB paths disagree"
                        )
                finally:
                    share.remove(linked)
            _refresh_absence(probe)
        return True


# Publish complete bytes exclusively, prove mounted visibility and remove only the held staging name
def publish(source: Path, destination: Path) -> bool:
    with _errors(source, collision=True):
        mount = _mount(source)
        if mount is None:
            return False
        if _mount(destination) != mount:
            raise SmbTransportError(errno.EXDEV, "SMB publication crossed a mount boundary")
        share = _share(mount, allow_prompt=True)
        name, target = _name(mount, source), _name(mount, destination)
        with share.parents(name), share.parents(target):
            _challenge(share, mount, source.parent)
            if destination.parent != source.parent:
                _challenge(share, mount, destination.parent)
            native = _sample(source)
            with share.open(
                name,
                access=Access.FILE_READ_ATTRIBUTES | Access.FILE_WRITE_ATTRIBUTES,
            ) as held:
                expected = smb_handles.observation(held)
                share.link(held, target)
                with share.open(target, share_delete=True) as published:
                    if smb_handles.observation(published) != expected:
                        raise SmbTransportError(errno.EXDEV, "The SMB publication identity changed")
                if native != _sample(destination):
                    raise SmbTransportError(errno.EXDEV, "The mounted publication identity changed")
            # Exclusive cleanup breaks deferred smbfs opens before setting delete-pending
            with share.open(
                name, access=Access.FILE_READ_ATTRIBUTES | Access.DELETE, exclusive=True
            ) as cleanup:
                if smb_handles.observation(cleanup) != expected:
                    raise SmbTransportError(errno.EXDEV, "The SMB staging identity changed")
                share.remove(cleanup)
            _refresh_absence(source)
        return True


# Finish owned cleanup by server identity despite stale mounted directory entries
def remove_published_source(path: Path, expected: dict[str, Any]) -> bool:
    if expected.get("kind") != "smb3":
        return False
    try:
        if not matches(path, expected):
            raise SmbTransportError(errno.EXDEV, "The SMB cleanup identity changed")
        with _errors(path):
            mount = _mount(path)
            if mount is None:
                raise SmbTransportError(errno.EXDEV, "The SMB mount is unavailable")
            share = _share(mount, allow_prompt=False)
            name = _name(mount, path)
            with (
                share.parents(name),
                _errors(path, missing=True),
                share.open(
                    name, access=Access.FILE_READ_ATTRIBUTES | Access.DELETE, exclusive=True
                ) as held,
            ):
                identity = smb_handles.observation(held)
                if any(expected.get(key) != value for key, value in identity.items()):
                    raise SmbTransportError(errno.EXDEV, "The SMB cleanup identity changed")
                share.remove(held)
            _refresh_absence(path)
    except _FileAbsent:
        pass
    return True


# Release all private pools during server shutdown
def close_sessions() -> None:
    with _lock:
        for key in list(_connections):
            _release(key)
        _roots.clear()


# Release only this account after its last registered library closes
def close_root(root: Path) -> None:
    with _lock:
        removed = _roots.pop(root, None)
        if removed is None:
            return
        key = (removed.server, removed.account)
        if any((mount.server, mount.account) == key for mount in _roots.values()):
            return
        _release(key)
