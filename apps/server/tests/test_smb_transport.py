"""Mounted-SMB mapping, credential and no-overwrite publication regressions"""

import errno
import os
import threading
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

from cairndex.file_ops import smb_transport


@pytest.fixture(autouse=True)
def clear_sessions():
    smb_transport._connected.clear()
    smb_transport._roots.clear()
    yield
    smb_transport._connected.clear()
    smb_transport._roots.clear()


# macOS mount identity supplies the only accepted endpoint, share and account mapping
def test_mount_source_parsing_decodes_identity_without_a_password(tmp_path: Path) -> None:
    mount = smb_transport._parse_mount(
        tmp_path.as_posix(), "//owner%20name@example.com/Video%20Archive"
    )
    assert mount == smb_transport.Mount(tmp_path, "example.com", "Video Archive", "owner name")
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport._parse_mount(tmp_path.as_posix(), "//owner:secret@example.com/videos")


# Remote paths remain inside the kernel-reported share boundary
def test_remote_path_mapping_rejects_escape(tmp_path: Path) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    assert smb_transport._remote(mount, tmp_path / "folder" / "clip.mkv") == (
        "\\\\media.local\\videos\\folder\\clip.mkv"
    )
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport._remote(mount, tmp_path.parent / "outside.mkv")


# An unanswered Keychain prompt cannot hold an import or server shutdown forever
def test_keychain_authorization_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    release = threading.Event()
    monkeypatch.setattr(smb_transport, "_KEYCHAIN_TIMEOUT", 0.01)
    monkeypatch.setattr(
        smb_transport,
        "_password_sync",
        lambda _mount, allow_prompt: release.wait(1) or "secret",
    )
    with pytest.raises(smb_transport.SmbTransportError, match="timed out"):
        smb_transport._password(mount, allow_prompt=True)
    release.set()


# Server observations are versioned and bind recovery to one server/share identity
def test_server_observation_and_recorded_mount_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    source = tmp_path / "clip.mkv"
    source.write_bytes(b"complete")
    session = SimpleNamespace(connection=SimpleNamespace(dialect=0x0311), encrypt_data=True)
    monkeypatch.setattr(smb_transport, "mount_for", lambda _path: mount)
    monkeypatch.setattr(smb_transport, "_password", lambda _mount, allow_prompt: "secret")
    monkeypatch.setattr(smb_transport.smbclient, "register_session", lambda *a, **k: session)
    monkeypatch.setattr(
        smb_transport.smbclient,
        "stat",
        lambda *a, **k: SimpleNamespace(st_size=8, st_mtime_ns=123, st_ino=456, st_dev=789),
    )
    observed = smb_transport.observation(source, allow_prompt=True)
    assert observed == {
        "kind": "smb3",
        "version": 1,
        "server": "media.local",
        "share": "videos",
        "size": 8,
        "mtime_ns": 123,
        "file_id": 456,
        "volume_serial": 789,
    }
    changed = {**observed, "share": "other"}
    with pytest.raises(smb_transport.SmbTransportError, match="recorded share"):
        smb_transport.matches(source, changed)


# The server-side link must refuse a newcomer and leave both complete files intact
def test_publish_collision_preserves_staging_and_newcomer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    source, destination = tmp_path / "stage.part", tmp_path / "final.mkv"
    source.write_bytes(b"complete upload")
    destination.write_bytes(b"concurrent arrival")
    session = SimpleNamespace(connection=SimpleNamespace(dialect=0x0311), encrypt_data=True)
    monkeypatch.setattr(smb_transport, "mount_for", lambda _path: mount)
    monkeypatch.setattr(smb_transport, "_password", lambda _mount, allow_prompt: "secret")
    monkeypatch.setattr(smb_transport.smbclient, "register_session", lambda *a, **k: session)

    def exclusive_link(_source: str, _destination: str, **_kwargs) -> None:
        raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST))

    monkeypatch.setattr(smb_transport.smbclient, "link", exclusive_link)
    with pytest.raises(FileExistsError):
        smb_transport.publish(source, destination)
    assert source.read_bytes() == b"complete upload"
    assert destination.read_bytes() == b"concurrent arrival"


# A successful remote link becomes visible through the mount before staging cleanup
def test_publish_refreshes_mounted_destination_before_unlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    source, destination = tmp_path / "stage.part", tmp_path / "final.mkv"
    source.write_bytes(b"complete upload")
    session = SimpleNamespace(connection=SimpleNamespace(dialect=0x0311), encrypt_data=True)
    monkeypatch.setattr(smb_transport, "mount_for", lambda _path: mount)
    monkeypatch.setattr(smb_transport, "_password", lambda _mount, allow_prompt: "secret")
    monkeypatch.setattr(smb_transport.smbclient, "register_session", lambda *a, **k: session)

    def local(remote: str) -> Path:
        return tmp_path / PureWindowsPath(remote).name

    monkeypatch.setattr(
        smb_transport.smbclient,
        "link",
        lambda source_remote, destination_remote, **_kwargs: os.link(
            local(source_remote), local(destination_remote)
        ),
    )
    assert smb_transport.publish(source, destination)
    assert not source.exists()
    assert destination.read_bytes() == b"complete upload"


# One library release keeps a shared server session until its last library closes
def test_close_root_releases_only_the_last_server_library(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = smb_transport.Mount(tmp_path, "media.local", "videos", "owner")
    first, second = tmp_path / "first", tmp_path / "second"
    smb_transport._connected.update({("media.local", "owner"), ("media.local", "other")})
    smb_transport._roots.update({first: mount, second: mount})
    deleted: list[str] = []
    monkeypatch.setattr(
        smb_transport.smbclient,
        "delete_session",
        lambda server, **_kwargs: deleted.append(server),
    )
    smb_transport.close_root(first)
    assert deleted == []
    smb_transport.close_root(second)
    assert deleted == ["media.local"]
    assert smb_transport._connected == set()
