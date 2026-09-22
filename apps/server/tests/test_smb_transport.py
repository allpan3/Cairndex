"""Mounted-SMB identity, account isolation, mapping and owned-cleanup regressions"""

import errno
import os
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from smbclient import _pool
from smbprotocol.exceptions import SMBOSError
from smbprotocol.header import NtStatus

from cairndex.domain.enums import FileOpStatus, FileOpType
from cairndex.file_ops import imports, journal, smb_handles, smb_transport
from cairndex.persistence.models import FileOperation
from cairndex.registry.library_engine import _reconcile_file_operations


# Isolate task sessions from process-global dependency state
@pytest.fixture(autouse=True)
def clear_sessions():
    smb_transport._connected.clear()
    smb_transport._connections.clear()
    smb_transport._roots.clear()
    yield
    smb_transport._connected.clear()
    smb_transport._connections.clear()
    smb_transport._roots.clear()


# Model open-object identity and deletion separately from replaceable pathnames
class LocalShare:
    def __init__(self, root):
        self.root = root
        self.tree = SimpleNamespace(
            session=SimpleNamespace(connection=SimpleNamespace(server_guid="server-one"))
        )
        self.link_accounts = []

    @contextmanager
    def parents(self, name):
        yield

    @contextmanager
    def open(
        self,
        name,
        *,
        access=0,
        create=False,
        temporary=False,
        directory=False,
        share_delete=False,
        exclusive=False,
    ):
        path = self.root.joinpath(*name.split("\\"))
        flags = os.O_RDWR if create else os.O_RDONLY
        if create:
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
        handle = SimpleNamespace(
            path=path,
            fd=fd,
            write=lambda data, **kw: os.write(fd, data),
            flush=lambda: os.fsync(fd),
        )
        try:
            yield handle
        finally:
            if temporary:
                self.remove(handle)
            os.close(fd)

    def link(self, handle, destination):
        os.link(handle.path, self.root.joinpath(*destination.split("\\")))

    def remove(self, handle):
        if handle.path.exists() and handle.path.stat().st_ino == os.fstat(handle.fd).st_ino:
            handle.path.unlink()


# Exercise the production mapping and cleanup decisions with synthetic local bytes
@pytest.fixture
def mounted(tmp_path, monkeypatch):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    share = LocalShare(tmp_path)
    monkeypatch.setattr(smb_transport, "mount_for", lambda path: mount)
    monkeypatch.setattr(smb_transport, "_share", lambda *a, **kw: share)

    def observation(handle):
        stat = os.fstat(handle.fd)
        return {
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "file_id": stat.st_ino,
            "volume_serial": stat.st_dev,
        }

    monkeypatch.setattr(smb_handles, "observation", observation)
    return mount, share


# Kernel mount identities decode without accepting credentials or nested share paths
def test_mount_source_parsing_decodes_identity_without_a_password(tmp_path):
    mount = smb_transport._parse_mount(
        tmp_path.as_posix(), "//owner%20name@example.com/Video%20Archive"
    )
    assert mount == smb_transport.Mount(tmp_path, "example.com", "Video Archive", "owner name")
    for source in ("//owner:secret@example.com/videos", "//owner@example.com/videos/nested"):
        with pytest.raises(smb_transport.SmbTransportError):
            smb_transport._parse_mount(tmp_path.as_posix(), source)


# POSIX components cannot smuggle Windows separators, streams or normalized aliases
@pytest.mark.parametrize("name", ["../escape", "nested\\escape", "clip:stream", "clip.", "clip "])
def test_remote_path_mapping_rejects_escape(tmp_path, name):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport._name(mount, tmp_path / name)


# An unanswered Keychain prompt cannot hold shutdown indefinitely
def test_keychain_authorization_is_bounded(tmp_path, monkeypatch):
    mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner")
    release = threading.Event()
    monkeypatch.setattr(smb_transport, "_KEYCHAIN_TIMEOUT", 0.01)
    monkeypatch.setattr(
        smb_transport, "_password_sync", lambda *a, **kw: release.wait(1) or "secret"
    )
    try:
        with pytest.raises(smb_transport.SmbTransportError, match="timed out"):
            smb_transport._password(mount, allow_prompt=True)
    finally:
        release.set()


# New receipts bind account and server GUID while old receipts keep their original comparison
def test_server_observation_and_recorded_mount_identity(tmp_path, mounted, monkeypatch):
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"complete")
    current = smb_transport.observation(path)
    assert current["version"] == 2 and current["account"] == "owner"
    assert smb_transport.matches(path, current)
    legacy = {k: v for k, v in current.items() if k not in {"account", "server_guid"}}
    legacy["version"] = 1
    assert smb_transport.matches(path, legacy)
    for changed in (
        {**current, "share": "other"},
        {**current, "account": "other"},
        {**current, "server_guid": "other"},
    ):
        with pytest.raises(smb_transport.SmbTransportError):
            smb_transport.matches(path, changed)
    monkeypatch.setattr(smb_transport, "mount_for", lambda path: None)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport.matches(path, current)


# Exclusive link collisions preserve both staged uploads and independent arrivals
@pytest.mark.parametrize("probe", [False, True])
def test_link_collision_preserves_staging_and_newcomer(tmp_path, mounted, probe):
    source = tmp_path / "stage.part"
    destination = source.with_suffix(".link") if probe else tmp_path / "final.mkv"
    source.write_bytes(b"complete upload")
    destination.write_bytes(b"independent arrival")
    with pytest.raises(FileExistsError):
        if probe:
            smb_transport.check_hard_links(source)
        else:
            smb_transport.publish(source, destination)
    assert source.read_bytes() == b"complete upload"
    assert destination.read_bytes() == b"independent arrival"
    assert not list(tmp_path.glob(".cairndex-map-*"))


# A probe replaced after link creation belongs to its replacement, never to cleanup
def test_replaced_probe_is_preserved(tmp_path, mounted, monkeypatch):
    source = tmp_path / "stage.part"
    source.write_bytes(b"complete upload")
    share = mounted[1]
    link = share.link

    def replaced(handle, destination):
        link(handle, destination)
        probe = tmp_path / destination
        probe.unlink()
        probe.write_bytes(b"outsider")

    monkeypatch.setattr(share, "link", replaced)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport.check_hard_links(source)
    assert source.read_bytes() == b"complete upload"
    assert source.with_suffix(".link").read_bytes() == b"outsider"


# Positive mapping reads fresh challenge bytes and preserves complete mounted visibility
def test_publish_and_capability_cleanup(tmp_path, mounted):
    source, destination = tmp_path / "stage.part", tmp_path / "final.mkv"
    source.write_bytes(b"complete upload")
    assert smb_transport.check_hard_links(source)
    assert not source.with_suffix(".link").exists()
    assert smb_transport.publish(source, destination)
    assert not source.exists()
    assert destination.read_bytes() == b"complete upload"
    assert not list(tmp_path.glob(".cairndex-map-*"))


# A direct tree pointing elsewhere cannot pass a mounted nonce challenge
def test_different_direct_directory_refuses_before_publication(tmp_path, mounted, monkeypatch):
    alternate = tmp_path / "alternate"
    alternate.mkdir()
    source = tmp_path / "stage.part"
    source.write_bytes(b"complete upload")
    share = LocalShare(alternate)
    monkeypatch.setattr(smb_transport, "_share", lambda *a, **kw: share)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport.publish(source, tmp_path / "final.mkv")
    assert source.read_bytes() == b"complete upload"
    assert list(alternate.iterdir()) == []
    assert not (tmp_path / "final.mkv").exists()


# A successful link followed by invisible mounted bytes leaves staging for recovery
def test_visibility_failure_preserves_staging(tmp_path, mounted, monkeypatch):
    source = tmp_path / "stage.part"
    source.write_bytes(b"complete upload")
    original = smb_transport._sample

    def invisible(path):
        if path.name == "final.mkv":
            raise OSError(errno.EIO, "synthetic unavailable mount")
        return original(path)

    monkeypatch.setattr(smb_transport, "_sample", invisible)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport.publish(source, tmp_path / "final.mkv")
    assert source.read_bytes() == (tmp_path / "final.mkv").read_bytes()


# Dependency errors from identity reads retain actual journal intent and complete staging
@pytest.mark.parametrize(
    "status",
    [
        NtStatus.STATUS_ACCESS_DENIED,
        NtStatus.STATUS_NETWORK_NAME_DELETED,
        NtStatus.STATUS_USER_SESSION_DELETED,
    ],
)
def test_real_smb_error_keeps_pending_staging_then_recovers(
    session, session_factory, library_root, monkeypatch, status
):
    mount = smb_transport.Mount(library_root, "example.com", "fixtures", "owner")
    share = LocalShare(library_root)
    monkeypatch.setattr(smb_transport, "mount_for", lambda path: mount)
    monkeypatch.setattr(smb_transport, "_share", lambda *a, **kw: share)
    expected = {
        "kind": "smb3",
        "version": 1,
        "server": mount.server,
        "share": mount.share,
        "size": 15,
        "mtime_ns": 123,
        "file_id": 456,
        "volume_serial": 789,
    }
    operation = journal.begin(
        session,
        op=FileOpType.IMPORT,
        payload={"import_protocol": 3, "destination": "clip.mkv", "published": expected},
    )
    staging = imports.staging_dir(library_root) / f"{operation.id}.part"
    staging.parent.mkdir(parents=True, exist_ok=True)
    staging.write_bytes(b"complete upload")
    os.link(staging, library_root / "clip.mkv")

    def unavailable(*a, **kw):
        raise SMBOSError(status, "synthetic")

    monkeypatch.setattr(smb_handles, "observation", unavailable)
    _reconcile_file_operations(session_factory, library_root)
    session.expire_all()
    assert session.get(FileOperation, operation.id).status is FileOpStatus.PENDING
    assert staging.read_bytes() == b"complete upload"
    monkeypatch.setattr(
        smb_handles,
        "observation",
        lambda handle: {k: expected[k] for k in ("size", "mtime_ns", "file_id", "volume_serial")},
    )
    _reconcile_file_operations(session_factory, library_root)
    _reconcile_file_operations(session_factory, library_root)
    session.expire_all()
    assert session.get(FileOperation, operation.id).status is FileOpStatus.DONE
    assert not staging.exists()
    assert (library_root / "clip.mkv").read_bytes() == b"complete upload"


# Only definite leaf absence permits failed-import cleanup after a verified mapping
@pytest.mark.parametrize(
    "status", [NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND]
)
def test_definite_absence_is_not_unavailable(tmp_path, mounted, monkeypatch, status):
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"complete")
    expected = smb_transport.observation(path)

    def absent(*a, **kw):
        raise SMBOSError(status, "synthetic")

    monkeypatch.setattr(smb_handles, "observation", absent)
    from cairndex.file_ops import replacement

    assert not replacement.matches(path, expected)


# Use the dependency's actual pool selection with simultaneous synthetic account sessions
def test_second_mount_uses_its_account_and_isolated_pool(tmp_path, monkeypatch):
    first = SimpleNamespace(username="first", encrypt_data=True)
    second = SimpleNamespace(username="second", encrypt_data=True)
    connection = SimpleNamespace(
        transport=SimpleNamespace(connected=True),
        session_table={1: first, 2: second},
        dialect=0x0311,
        require_signing=True,
        server_name="example.com",
    )
    first.connection = second.connection = connection
    monkeypatch.setattr(smb_transport, "_password", lambda *a, **kw: "secret")
    calls = []

    def registered(server, **kwargs):
        cache = kwargs["connection_cache"]
        calls.append((kwargs["username"], cache, kwargs["encrypt"], kwargs["require_signing"]))
        cache["example.com:445"] = connection
        return _pool.register_session(server, **kwargs)

    monkeypatch.setattr(smb_transport.smbclient, "register_session", registered)
    for account, expected in (("second", second), ("first", first), ("second", second)):
        mount = smb_transport.Mount(tmp_path, "example.com", "fixtures", account)
        assert smb_transport._connect(mount, allow_prompt=False) is expected
    assert calls[0][0] == "second" and calls[1][0] == "first"
    assert calls[0][1] is not calls[1][1]
    assert all(call[2:] == (True, True) for call in calls)


# Reconnection uses the same explicit account and a fresh private pool
def test_reconnect_and_account_scoped_library_close(tmp_path, monkeypatch):
    calls, deleted = [], []
    monkeypatch.setattr(smb_transport, "_password", lambda *a, **kw: "secret")

    def register(server, **kwargs):
        calls.append(kwargs["username"])
        return SimpleNamespace(
            username=kwargs["username"],
            encrypt_data=True,
            connection=SimpleNamespace(
                transport=SimpleNamespace(connected=True),
                dialect=0x0311,
                require_signing=True,
                server_name=server,
            ),
        )

    monkeypatch.setattr(smb_transport.smbclient, "register_session", register)
    monkeypatch.setattr(
        smb_transport.smbclient,
        "delete_session",
        lambda server, **kw: deleted.append(kw["connection_cache"]),
    )
    mounts = [
        smb_transport.Mount(tmp_path, "example.com", "fixtures", account)
        for account in ("first", "second")
    ]
    roots = [tmp_path / str(i) for i in range(3)]
    smb_transport._roots.update(zip(roots, [mounts[0], mounts[0], mounts[1]], strict=True))
    first = smb_transport._connect(mounts[0], allow_prompt=False)
    second = smb_transport._connect(mounts[1], allow_prompt=False)
    first.connection.transport.connected = False
    assert smb_transport._connect(mounts[0], allow_prompt=False) is not first
    assert calls == ["first", "second", "first"]
    deleted.clear()
    smb_transport.close_root(roots[0])
    assert not deleted
    smb_transport.close_root(roots[1])
    assert len(deleted) == 1
    assert smb_transport._connected[("example.com", "second")] is second
    smb_transport.close_root(roots[2])
    assert len(deleted) == 2 and not smb_transport._connected


# Weaker sessions cannot be reused even if a provider returned them successfully
@pytest.mark.parametrize(
    "change",
    [{"dialect": 0x0210}, {"require_signing": False}, {"server_name": "other.example.com"}],
)
def test_session_policy_refusal(tmp_path, monkeypatch, change):
    connection = SimpleNamespace(
        dialect=0x0311, require_signing=True, server_name="example.com", **{}
    )
    for key, value in change.items():
        setattr(connection, key, value)
    session = SimpleNamespace(username="owner", encrypt_data=True, connection=connection)
    monkeypatch.setattr(smb_transport, "_password", lambda *a, **kw: "secret")
    monkeypatch.setattr(smb_transport.smbclient, "register_session", lambda *a, **kw: session)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport._connect(
            smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner"), allow_prompt=False
        )
    assert not smb_transport._connected


# An unavailable initial observation retains the complete upload until access returns
def test_unavailable_initial_observation_retains_upload(
    session, session_factory, library_root, monkeypatch
):
    from cairndex.core.errors import ConflictError
    from cairndex.file_ops import replacement
    from tests.test_import_replacement import upload

    observe = replacement.observation

    def unavailable(*a, **kw):
        with smb_transport._errors():
            raise SMBOSError(NtStatus.STATUS_ACCESS_DENIED, "synthetic")

    monkeypatch.setattr(replacement, "observation", unavailable)
    with pytest.raises(ConflictError):
        upload(session, library_root, b"complete upload", name="new.mkv")
    operation = journal.pending_operations(session)[0]
    staging = imports.staging_dir(library_root) / f"{operation.id}.part"
    assert staging.read_bytes() == b"complete upload"
    _reconcile_file_operations(session_factory, library_root)
    session.expire_all()
    assert session.get(FileOperation, operation.id).status is FileOpStatus.PENDING
    assert staging.exists()
    monkeypatch.setattr(replacement, "observation", observe)
    _reconcile_file_operations(session_factory, library_root)
    session.expire_all()
    assert session.get(FileOperation, operation.id).status is FileOpStatus.FAILED
    assert not staging.exists()
    assert not (library_root / "new.mkv").exists()
    upload(session, library_root, b"complete upload", name="new.mkv")
    assert (library_root / "new.mkv").read_bytes() == b"complete upload"


# Parent disappearance cannot authorize final-name absence or erase pending staging
@pytest.mark.parametrize(
    "failure", [FileNotFoundError(errno.ENOENT, "synthetic"), OSError(errno.EIO, "synthetic")]
)
def test_parent_failure_is_unavailable(tmp_path, mounted, monkeypatch, failure):
    share = mounted[1]

    @contextmanager
    def unavailable(name):
        raise failure
        yield

    monkeypatch.setattr(share, "parents", unavailable)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport.observation(tmp_path / "missing.mkv")


# Repeated Undo tolerates a stale mounted entry only after definite server-side absence
def test_cleanup_uses_server_identity_and_preserves_replacements(tmp_path, mounted):
    path = tmp_path / "stage.part"
    path.write_bytes(b"complete upload")
    expected = smb_transport.observation(path)
    assert smb_transport.remove_published_source(path, expected)
    assert not path.exists()
    assert smb_transport.remove_published_source(path, expected)
    path.write_bytes(b"outsider replacement")
    with pytest.raises(smb_transport.SmbTransportError, match="identity changed"):
        smb_transport.remove_published_source(path, expected)
    assert path.read_bytes() == b"outsider replacement"


# A replaced staging name cannot be deleted after a successful exclusive publication
def test_publication_cleanup_preserves_replaced_staging(tmp_path, mounted, monkeypatch):
    source = tmp_path / "stage.part"
    source.write_bytes(b"complete upload")
    share = mounted[1]
    open_handle = share.open

    @contextmanager
    def replaced(name, **kwargs):
        if kwargs.get("exclusive") and name == "stage.part":
            source.unlink()
            source.write_bytes(b"independent outsider")
        with open_handle(name, **kwargs) as handle:
            yield handle

    monkeypatch.setattr(share, "open", replaced)
    with pytest.raises(smb_transport.SmbTransportError, match="staging identity changed"):
        smb_transport.publish(source, tmp_path / "final.mkv")
    assert source.read_bytes() == b"independent outsider"
    assert (tmp_path / "final.mkv").read_bytes() == b"complete upload"


# A provider cannot return plaintext or another account despite the requested session policy
@pytest.mark.parametrize("encrypted,account", [(False, "owner"), (True, "other")])
def test_session_rejects_plaintext_and_wrong_account(tmp_path, monkeypatch, encrypted, account):
    connection = SimpleNamespace(dialect=0x0311, require_signing=True, server_name="example.com")
    session = SimpleNamespace(username=account, encrypt_data=encrypted, connection=connection)
    monkeypatch.setattr(smb_transport, "_password", lambda *a, **kw: "secret")
    monkeypatch.setattr(smb_transport.smbclient, "register_session", lambda *a, **kw: session)
    with pytest.raises(smb_transport.SmbTransportError):
        smb_transport._connect(
            smb_transport.Mount(tmp_path, "example.com", "fixtures", "owner"), allow_prompt=False
        )
    assert not smb_transport._connected and not smb_transport._connections
