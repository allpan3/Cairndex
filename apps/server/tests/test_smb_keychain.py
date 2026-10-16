"""Saved SMB logins stay scoped to the mounted share and signed application."""

import ctypes
import errno
from types import SimpleNamespace

import pytest

from cairndex import sidecar
from cairndex.file_ops import smb_authorization, smb_transport


class Function:
    def __init__(self, action):
        self.action = action

    def __call__(self, *args):
        return self.action(*args)


SHARE_LOGINS = {
    (b"example.com", b"owner", b"fixtures"): b"synthetic-first-share",
    (b"example.com", b"owner", "fixtures two é".encode()): b"synthetic-second-share",
}


def security(monkeypatch, status=0, logins=SHARE_LOGINS, read_status=0):
    """Fake Security API whose items are keyed by server, account and path.

    A server-level item has an empty path. A pathless query returns the first item
    for the server and account, whichever share it belongs to, as macOS can.
    """
    interactions, lookups, freed, reads, released = [], [], [], [], []
    buffers, items = [], list(logins.items())

    def write(length, data, value):
        buffer = ctypes.create_string_buffer(value)
        buffers.append(buffer)
        ctypes.cast(length, ctypes.POINTER(ctypes.c_uint32))[0] = len(value)
        ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(buffer)

    def find(*args):
        path = None if args[8] is None else args[8][: args[7]]
        key = (args[2][: args[1]], args[6][: args[5]], path)
        lookups.append(key)
        if status:
            return status
        if path is not None:
            if key not in logins:
                return -25300
            write(args[12], args[13], logins[key])
            return 0
        for handle, ((host, account, _), _) in enumerate(items, 1):
            if (host, account) == key[:2]:
                ctypes.cast(args[14], ctypes.POINTER(ctypes.c_void_p))[0] = handle
                return 0
        return -25300

    def copy_content(item, _, attributes, length, data):
        (_, _, path), password = items[item.value - 1]
        if attributes is not None:
            reads.append("path")
            listed = ctypes.cast(attributes, ctypes.POINTER(smb_transport._KeychainAttributes))
            attribute = listed[0].attr[0]
            attribute.length = len(path)
            if path:
                buffer = ctypes.create_string_buffer(path)
                buffers.append(buffer)
                attribute.data = ctypes.addressof(buffer)
            return 0
        reads.append("password")
        if read_status:
            return read_status
        write(length, data, password)
        return 0

    api = SimpleNamespace(
        SecKeychainSetUserInteractionAllowed=Function(interactions.append),
        SecKeychainFindInternetPassword=Function(find),
        SecKeychainItemCopyContent=Function(copy_content),
        SecKeychainItemFreeContent=Function(
            lambda attributes, _: freed.append("attributes" if attributes else "password")
        ),
        CFRelease=Function(lambda item: released.append(item.value)),
    )
    monkeypatch.setattr(smb_transport.ctypes.util, "find_library", lambda _: "synthetic-security")
    monkeypatch.setattr(smb_transport.ctypes, "CDLL", lambda _: api)
    return SimpleNamespace(
        interactions=interactions, lookups=lookups, freed=freed, reads=reads, released=released
    )


def test_same_server_and_account_select_their_own_share_login(tmp_path, monkeypatch):
    server_login = {(b"example.com", b"owner", b""): b"synthetic-server-login"}
    keychain = security(monkeypatch, logins=server_login | SHARE_LOGINS)
    first = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    second = smb_transport.Mount(tmp_path, "example.com", "fixtures two é", "owner")
    assert smb_transport._password_sync(first, allow_prompt=False) == "synthetic-first-share"
    assert smb_transport._password_sync(second, allow_prompt=False) == "synthetic-second-share"
    assert [query[2] for query in keychain.lookups] == [b"fixtures", "fixtures two é".encode()]
    assert keychain.interactions == [False, True, False, True]
    assert keychain.freed == ["password", "password"]


def test_a_login_saved_for_the_whole_server_serves_a_share_without_its_own(tmp_path, monkeypatch):
    server_login = {(b"example.com", b"owner", b""): b"synthetic-server-login"}
    keychain = security(monkeypatch, logins=server_login)
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    assert smb_transport._password_sync(mount, allow_prompt=False) == "synthetic-server-login"
    assert [query[2] for query in keychain.lookups] == [b"fixtures", None]
    assert keychain.reads == ["path", "password"]
    assert keychain.freed == ["attributes", "password"]
    assert keychain.released == [1]
    assert keychain.interactions == [False, True]


@pytest.mark.parametrize("read_status", [0, -25308])
def test_a_pathless_match_never_reads_another_shares_login(tmp_path, monkeypatch, read_status):
    other_share = {(b"example.com", b"owner", b"other"): b"synthetic-other-share"}
    keychain = security(monkeypatch, logins=other_share, read_status=read_status)
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    with pytest.raises(smb_transport.SmbTransportError) as caught:
        smb_transport._password_sync(mount, allow_prompt=False)
    assert caught.value.keychain_status == -25300
    assert keychain.reads == ["path"]
    assert keychain.released == [1]


def test_a_server_level_login_that_refuses_the_application_is_reported(tmp_path, monkeypatch):
    server_login = {(b"example.com", b"owner", b""): b"synthetic-server-login"}
    keychain = security(monkeypatch, logins=server_login, read_status=-25308)
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    with pytest.raises(smb_transport.SmbTransportError) as caught:
        smb_transport._password_sync(mount, allow_prompt=False)
    assert caught.value.keychain_status == -25308
    assert "cannot read the saved SMB login" in str(caught.value)
    assert keychain.freed == ["attributes"]
    assert keychain.released == [1]


@pytest.mark.parametrize("status", [-25300, -25293, -25308])
def test_keychain_status_distinguishes_missing_login_from_denied_access(
    tmp_path, monkeypatch, status
):
    keychain = security(monkeypatch, status)
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    with pytest.raises(smb_transport.SmbTransportError) as caught:
        smb_transport._password_sync(mount, allow_prompt=False)
    assert caught.value.errno == errno.EACCES
    assert caught.value.keychain_status == status
    assert ("No saved SMB login" in str(caught.value)) == (status == -25300)
    # Only a missing share login falls back to the server's login
    assert len(keychain.lookups) == (2 if status == -25300 else 1)
    assert keychain.interactions == [False, True]
    assert not keychain.freed


def test_sidecar_authorization_does_not_start_a_server_or_require_its_token(
    tmp_path, monkeypatch, capsys
):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    connected, closed = [], []
    monkeypatch.delenv("CAIRNDEX_LOCAL_TOKEN", raising=False)
    monkeypatch.setattr(smb_transport, "mount_for", lambda path: mount)
    monkeypatch.setattr(
        smb_transport,
        "_connect",
        lambda target, *, allow_prompt: connected.append((target, allow_prompt)),
    )
    monkeypatch.setattr(smb_transport, "close_sessions", lambda: closed.append(True))
    monkeypatch.setattr(sidecar, "bind_loopback_socket", lambda: pytest.fail("HTTP server started"))
    assert sidecar.main(["authorize-smb", str(tmp_path)]) == 0
    assert connected == [(mount, True)]
    assert closed == [True]
    assert "signed, encrypted SMB3 connection verified" in capsys.readouterr().out
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("reason", ["unmounted", "missing", "denied"])
def test_authorization_refuses_unavailable_paths_and_never_prints_private_details(
    tmp_path, monkeypatch, capsys, reason
):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    closed = []
    monkeypatch.setattr(
        smb_transport, "mount_for", lambda _: None if reason == "unmounted" else mount
    )

    def refuse(*args, **kwargs):
        raise smb_transport.SmbTransportError(errno.EACCES, "synthetic-private-credential-detail")

    monkeypatch.setattr(smb_transport, "_connect", refuse)
    monkeypatch.setattr(smb_transport, "close_sessions", lambda: closed.append(True))
    path = tmp_path / "missing" if reason == "missing" else tmp_path
    assert smb_authorization.main([str(path)]) == 1
    output = capsys.readouterr()
    assert "SMB authorization or connection failed" in output.err
    assert "synthetic-private-credential-detail" not in output.err
    assert str(path) not in output.err
    assert not output.out
    assert closed == [True]
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("status,code", [(-25293, errno.EACCES), (None, errno.ETIMEDOUT)])
def test_authorization_reports_safe_failure_codes(tmp_path, monkeypatch, capsys, status, code):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    monkeypatch.setattr(smb_transport, "mount_for", lambda _: mount)

    def refuse(*args, **kwargs):
        error = smb_transport.SmbTransportError(code, "synthetic-private-credential-detail")
        error.keychain_status = status
        raise error

    monkeypatch.setattr(smb_transport, "_connect", refuse)
    monkeypatch.setattr(smb_transport, "close_sessions", lambda: None)
    assert smb_authorization.main([str(tmp_path)]) == 1
    output = capsys.readouterr()
    assert "synthetic-private-credential-detail" not in output.err
    assert ("Security status: -25293" in output.err) == (status == -25293)
    assert ("timed out" in output.err) == (code == errno.ETIMEDOUT)
