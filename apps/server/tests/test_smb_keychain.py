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


def security(monkeypatch, status=0):
    interactions, lookups, freed = [], [], []
    buffers = []

    def find(*args):
        key = (args[2][: args[1]], args[6][: args[5]], args[8][: args[7]])
        lookups.append(key)
        if status:
            return status
        # A pathless query returns the wrong share's credential, as macOS can.
        passwords = {
            (b"example.com", b"owner", b"fixtures"): b"synthetic-first-share",
            (b"example.com", b"owner", "fixtures two é".encode()): b"synthetic-second-share",
        }
        value = passwords.get(key, b"synthetic-wrong-share")
        buffer = ctypes.create_string_buffer(value)
        buffers.append(buffer)
        ctypes.cast(args[12], ctypes.POINTER(ctypes.c_uint32))[0] = len(value)
        ctypes.cast(args[13], ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(buffer)
        return 0

    api = SimpleNamespace(
        SecKeychainSetUserInteractionAllowed=Function(interactions.append),
        SecKeychainFindInternetPassword=Function(find),
        SecKeychainItemFreeContent=Function(lambda _, data: freed.append(data.value)),
    )
    monkeypatch.setattr(smb_transport.ctypes.util, "find_library", lambda _: "synthetic-security")
    monkeypatch.setattr(smb_transport.ctypes, "CDLL", lambda _: api)
    return interactions, lookups, freed


def test_same_server_and_account_select_their_own_share_login(tmp_path, monkeypatch):
    interactions, lookups, freed = security(monkeypatch)
    first = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    second = smb_transport.Mount(tmp_path, "example.com", "fixtures two é", "owner")
    assert smb_transport._password_sync(first, allow_prompt=False) == "synthetic-first-share"
    assert smb_transport._password_sync(second, allow_prompt=False) == "synthetic-second-share"
    assert [query[2] for query in lookups] == [b"fixtures", "fixtures two é".encode()]
    assert interactions == [False, True, False, True]
    assert len(freed) == 2


@pytest.mark.parametrize("status", [-25300, -25293, -25308])
def test_keychain_status_distinguishes_missing_login_from_denied_access(
    tmp_path, monkeypatch, status
):
    interactions, _, freed = security(monkeypatch, status)
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    with pytest.raises(smb_transport.SmbTransportError) as caught:
        smb_transport._password_sync(mount, allow_prompt=False)
    assert caught.value.errno == errno.EACCES
    assert caught.value.keychain_status == status
    assert ("No saved SMB login" in str(caught.value)) == (status == -25300)
    assert interactions == [False, True]
    assert not freed


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
