"""Portable SMB publication preserves occupied names and recoverable staging."""

import errno
import os

import pytest

from cairndex.file_ops import exclusive, smb_handles, smb_portable, smb_transport
from tests.test_smb_transport import clear_sessions as clear_sessions
from tests.test_smb_transport import mounted as mounted


@pytest.fixture
def portable(mounted, monkeypatch):
    mount, share = mounted
    monkeypatch.setattr(smb_portable.sys, "platform", "darwin")
    monkeypatch.setattr(smb_portable, "_uncache", lambda _: None)
    # macOS /dev/fd links do not provide paths; the caller registers held parents.
    parents = {}
    monkeypatch.setattr(smb_portable, "directory_path", lambda fd: parents[fd])

    def rename(handle, target):
        destination = mount.point.joinpath(*target.split("\\"))
        if destination.exists():
            raise FileExistsError(errno.EEXIST, "occupied")
        handle.path.rename(destination)
        handle.path = destination

    monkeypatch.setattr(share, "rename", rename, raising=False)
    return parents, share


@pytest.mark.parametrize("move,directory", [(False, False), (True, False), (True, True)])
def test_portable_link_and_move_preserve_collision(tmp_path, portable, move, directory):
    parents, _ = portable
    source, target = tmp_path / "source", tmp_path / "target"
    if directory:
        source.mkdir()
        (source / "child").write_bytes(b"synthetic child")
        target.mkdir()
    else:
        source.write_bytes(b"synthetic source")
        target.write_bytes(b"synthetic arrival")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    try:
        with pytest.raises(FileExistsError):
            smb_portable.transfer(fd, "source", fd, "target", move=move)
        assert source.exists() and target.exists()
        assert smb_portable.transfer(fd, "source", fd, "vacant", move=move)
        assert source.exists() != move
        assert (tmp_path / "vacant").exists()
    finally:
        os.close(fd)


def test_portable_mapping_failure_does_not_publish(tmp_path, portable, monkeypatch):
    parents, _ = portable
    (tmp_path / "source").write_bytes(b"synthetic source")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path

    def refuse(*args):
        raise OSError(errno.EXDEV, "unverified mapping")

    monkeypatch.setattr(smb_transport, "_challenge", refuse)
    try:
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.transfer(fd, "source", fd, "target", move=False)
        assert (tmp_path / "source").read_bytes() == b"synthetic source"
        assert not (tmp_path / "target").exists()
    finally:
        os.close(fd)


def test_native_publication_errors_do_not_fall_back(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(smb_portable, "transfer", lambda *a, **kw: calls.append(kw))
    (tmp_path / "source").write_bytes(b"synthetic source")
    (tmp_path / "target").write_bytes(b"arrival")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(FileExistsError):
            exclusive.link(fd, "source", "target")
        assert not calls
    finally:
        os.close(fd)


def test_smb_rename_request_refuses_replacement(monkeypatch):
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(smb_handles, "_set", lambda handle, info: calls.append(info))
    tree = SimpleNamespace(is_dfs_share=False, share_name="\\\\example.com\\fixtures")
    share = smb_handles.Share(
        SimpleNamespace(tree_connect_table={1: tree}), "example.com", "fixtures"
    )
    share.rename(object(), "new-name")
    assert not calls[0]["replace_if_exists"].get_value()
    assert calls[0]["file_name"].get_value() == "new-name"


def test_server_identity_survives_move_and_binds_authority(tmp_path, portable, monkeypatch):
    from dataclasses import replace

    parents, share = portable
    (tmp_path / "source").write_bytes(b"synthetic source")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    try:
        before = smb_portable.identity(fd, "source")
        assert isinstance(before[0], str) and before[0].startswith("smb3-v1:")
        assert "example.com" not in before[0] and "owner" not in before[0]
        smb_portable.transfer(fd, "source", fd, "target", move=True)
        assert smb_portable.identity(fd, "target") == before
        share.tree.session.connection.server_guid = "server-two"
        assert smb_portable.identity(fd, "target")[0] != before[0]
        share.tree.session.connection.server_guid = "server-one"
        mount = smb_transport.mount_for(tmp_path)
        monkeypatch.setattr(smb_transport, "mount_for", lambda _: replace(mount, account="other"))
        assert smb_portable.identity(fd, "target")[0] != before[0]
    finally:
        os.close(fd)


@pytest.mark.parametrize("move", [False, True])
def test_lost_reply_retains_complete_destination_and_exact_identity(
    tmp_path, portable, monkeypatch, move
):
    parents, share = portable
    content = b"complete synthetic source"
    (tmp_path / "source").write_bytes(content)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    action = share.rename if move else share.link

    def lost_reply(handle, name):
        action(handle, name)
        raise OSError(errno.ECONNRESET, "synthetic lost response")

    monkeypatch.setattr(share, "rename" if move else "link", lost_reply)
    try:
        expected = smb_portable.identity(fd, "source")
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.transfer(fd, "source", fd, "target", move=move)
        assert (tmp_path / "target").read_bytes() == content
        assert (tmp_path / "source").exists() != move
        assert smb_portable.identity(fd, "target") == expected
    finally:
        os.close(fd)


def test_changed_server_bytes_and_symlinks_refuse_identity(tmp_path, portable, monkeypatch):
    parents, _ = portable
    (tmp_path / "source").write_bytes(b"synthetic source")
    (tmp_path / "link").symlink_to(tmp_path / "source")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    original = smb_handles.observation
    monkeypatch.setattr(smb_handles, "observation", lambda held: {**original(held), "size": 999})
    try:
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.identity(fd, "source")
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.identity(fd, "link")
        for name in ("../source", "a/b", "a\\b", "..", ""):
            with pytest.raises(ValueError):
                smb_portable.identity(fd, name)
    finally:
        os.close(fd)


def test_credential_failure_never_prompts_or_changes_source(tmp_path, portable, monkeypatch):
    parents, _ = portable
    (tmp_path / "source").write_bytes(b"synthetic source")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    prompts = []

    def unavailable(mount, *, allow_prompt):
        prompts.append(allow_prompt)
        raise OSError(errno.EACCES, "synthetic unavailable login")

    monkeypatch.setattr(smb_transport, "_share", unavailable)
    try:
        for action in (
            lambda: smb_portable.identity(fd, "source"),
            lambda: smb_portable.transfer(fd, "source", fd, "target", move=True),
        ):
            with pytest.raises(smb_transport.SmbTransportError):
                action()
        assert prompts == [False, False]
        assert (tmp_path / "source").read_bytes() == b"synthetic source"
        assert not (tmp_path / "target").exists()
    finally:
        os.close(fd)


def test_server_absence_requires_verified_parents(tmp_path, portable, monkeypatch):
    from contextlib import contextmanager

    parents, share = portable
    (tmp_path / "source").write_bytes(b"synthetic cached source")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path

    @contextmanager
    def absent(*args, **kwargs):
        raise FileNotFoundError(errno.ENOENT, "synthetic absent leaf")
        yield

    monkeypatch.setattr(share, "open", absent)
    try:
        with pytest.raises(smb_transport._FileAbsent):
            smb_portable.identity(fd, "source")
        monkeypatch.setattr(share, "parents", absent)
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.identity(fd, "source")
    finally:
        os.close(fd)


def test_repeated_root_registration_preserves_shared_session(tmp_path, mounted, monkeypatch):
    released = []
    monkeypatch.setattr(smb_transport, "_release", released.append)
    smb_transport.register_root(tmp_path)
    smb_transport.register_root(tmp_path)
    smb_transport.close_root(tmp_path)
    assert not released
    assert tmp_path in smb_transport._roots
    smb_transport.close_root(tmp_path)
    assert released == [("example.com", "owner")]
    assert tmp_path not in smb_transport._roots


@pytest.mark.parametrize("directory", [False, True])
def test_portable_journal_recovers_lost_smb_publication(tmp_path, mounted, monkeypatch, directory):
    from pathlib import Path

    from cairndex.replicas.source_files import (
        artifact_identity,
        observation,
        publish_output,
        snapshot,
        stage_output,
    )

    mount, share = mounted
    kernel_directory_path = smb_portable.directory_path
    monkeypatch.setattr(smb_portable, "_uncache", lambda _: None)
    monkeypatch.setattr(smb_portable.sys, "platform", "darwin")
    if os.uname().sysname != "Darwin":

        def kernel_directory_path(fd):
            return Path(os.readlink(f"/proc/self/fd/{fd}"))

    monkeypatch.setattr(smb_portable, "directory_path", kernel_directory_path)

    def rename(handle, target):
        destination = mount.point.joinpath(*target.split("\\"))
        if destination.exists():
            raise FileExistsError(errno.EEXIST, "occupied")
        handle.path.rename(destination)
        handle.path = destination

    from cairndex.replicas import source_files, source_trees

    monkeypatch.setattr(share, "rename", rename, raising=False)
    monkeypatch.setattr(
        exclusive, "relocate", lambda a, b, c, d: smb_portable.transfer(a, b, c, d, move=True)
    )

    monkeypatch.setattr(source_files, "relocate", exclusive.relocate)
    monkeypatch.setattr(source_trees, "relocate", exclusive.relocate)
    source = tmp_path / "source"
    if directory:
        source.mkdir()
        (source / "nested").mkdir()
        (source / "nested/child").write_bytes(b"synthetic bytes")
    else:
        source.write_bytes(b"synthetic bytes")
    seen = observation(tmp_path, "source")
    evidence = snapshot(
        tmp_path, "source", "operation", "source", seen, progress=lambda _: None, limit=1024
    )
    expected = stage_output(
        tmp_path, "operation", "operation", "source", evidence, lambda _: None, 1024
    )

    def lost_reply(handle, name):
        rename(handle, name)
        raise OSError(errno.ECONNRESET, "synthetic lost response")

    monkeypatch.setattr(share, "rename", lost_reply)
    with pytest.raises(smb_transport.SmbTransportError):
        publish_output(tmp_path, "operation", "destination", expected)
    assert artifact_identity(tmp_path, "operation", "output-stage") is None
    publish_output(tmp_path, "operation", "destination", expected)
    assert observation(tmp_path, "destination")["identity"] == expected
    leaf = "nested/child" if directory else ""
    retained = tmp_path / ".cairndex/source-operations/operation/source"
    assert (retained / leaf if leaf else retained).read_bytes() == b"synthetic bytes"


def test_visibility_timeout_preserves_a_new_arrival(tmp_path, portable, monkeypatch):
    parents, share = portable
    (tmp_path / "source").write_bytes(b"synthetic original")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    rename = share.rename

    def arriving(handle, name):
        rename(handle, name)
        (tmp_path / "source").write_bytes(b"synthetic arrival")

    monkeypatch.setattr(share, "rename", arriving)
    monkeypatch.setattr(smb_portable, "VISIBILITY_TIMEOUT", 0)
    try:
        with pytest.raises(smb_transport.SmbTransportError):
            smb_portable.transfer(fd, "source", fd, "target", move=True)
        assert (tmp_path / "source").read_bytes() == b"synthetic arrival"
        assert (tmp_path / "target").read_bytes() == b"synthetic original"
    finally:
        os.close(fd)


def test_staging_identity_is_recorded_after_writer_close(tmp_path, portable):
    parents, _ = portable
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    writer = os.open("stage", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
    try:
        os.write(writer, b"synthetic output")
        os.fsync(writer)
        before = os.fstat(writer)
    finally:
        os.close(writer)
    try:
        os.utime(tmp_path / "stage", ns=(before.st_atime_ns, before.st_mtime_ns + 10000000))
        result = smb_portable.finish_staging(fd, "stage", before)
        assert result == smb_portable.identity(fd, "stage")
        assert result[3] == before.st_mtime_ns
        assert (tmp_path / "stage").read_bytes() == b"synthetic output"
        (tmp_path / "stage").rename(tmp_path / "retained")
        (tmp_path / "stage").write_bytes(b"synthetic output")
        with pytest.raises(OSError):
            smb_portable.finish_staging(fd, "stage", before)
    finally:
        os.close(fd)


def test_refresh_discards_only_regular_mounted_file_pages(tmp_path, portable, monkeypatch):
    parents, _ = portable
    (tmp_path / "file").write_bytes(b"synthetic cache")
    (tmp_path / "folder").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "file")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    parents[fd] = tmp_path
    refreshed = []
    monkeypatch.setattr(
        smb_portable, "_uncache", lambda held: refreshed.append(os.fstat(held).st_ino)
    )
    try:
        smb_portable.refresh(fd, "file")
        smb_portable.refresh(fd, "folder")
        with pytest.raises(OSError):
            smb_portable.refresh(fd, "link")
        with pytest.raises(ValueError):
            smb_portable.refresh(fd, "../file")
        assert refreshed == [(tmp_path / "file").stat().st_ino]
        assert (tmp_path / "file").read_bytes() == b"synthetic cache"
    finally:
        os.close(fd)


def test_missing_child_is_not_interpreted_as_absent_directory(tmp_path, monkeypatch):
    from cairndex.replicas import source_trees
    from cairndex.replicas.source_files import observation

    (tmp_path / "folder").mkdir()
    (tmp_path / "folder/child").write_bytes(b"synthetic child")
    physical = source_trees.physical_identity

    def missing(parent, name=None, **kwargs):
        if name == "child":
            raise smb_transport._FileAbsent(errno.ENOENT, "synthetic stale child")
        return physical(parent, name, **kwargs)

    monkeypatch.setattr(source_trees, "physical_identity", missing)
    with pytest.raises(OSError) as caught:
        observation(tmp_path, "folder")
    assert caught.value.errno == errno.EAGAIN
