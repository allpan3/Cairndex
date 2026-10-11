"""Verify SMB requests stay on bound handles and refuse redirects and reparse paths"""

from types import SimpleNamespace

import pytest
from smbprotocol.exceptions import SMBResponseException
from smbprotocol.header import NtStatus, SMB2HeaderResponse

from cairndex.file_ops import smb_handles, smb_transport


# Tree construction never consults smbclient's global referral or default-account pool
@pytest.mark.parametrize("dfs", [False, True])
def test_tree_is_bound_to_exact_session_and_share(monkeypatch, dfs):
    session = SimpleNamespace(tree_connect_table={})
    calls = []

    def tree(selected, name):
        calls.append((selected, name))
        return SimpleNamespace(is_dfs_share=dfs, connect=lambda **kw: calls.append(kw))

    monkeypatch.setattr(smb_handles, "TreeConnect", tree)
    if dfs:
        with pytest.raises(ValueError, match="referrals"):
            smb_handles.Share(session, "example.com", "fixtures")
    else:
        smb_handles.Share(session, "example.com", "fixtures")
    assert calls == [(session, "\\\\example.com\\fixtures"), {"require_secure_negotiate": True}]


# Each ancestor stays held against deletion and reparse points stop traversal immediately
@pytest.mark.parametrize("reparse", [False, True])
def test_parent_handles_reject_reparse_and_close(monkeypatch, reparse):
    tree = SimpleNamespace(is_dfs_share=False, share_name="\\\\example.com\\fixtures")
    share = smb_handles.Share(
        SimpleNamespace(tree_connect_table={1: tree}), "example.com", "fixtures"
    )
    opened, closed = [], []

    def handle(selected, name):
        assert selected is tree

        def create(*args):
            assert args[3] & smb_handles.ShareAccess.FILE_SHARE_DELETE == 0
            assert args[5] & smb_handles.CreateOptions.FILE_OPEN_REPARSE_POINT
            opened.append(name)

        return SimpleNamespace(
            create=create,
            close=lambda: closed.append(name),
            file_attributes=smb_handles.FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
            if reparse and name == "folder"
            else 0,
        )

    monkeypatch.setattr(smb_handles, "Open", handle)
    if reparse:
        with pytest.raises(ValueError, match="reparse"), share.parents("folder\\child\\clip.mkv"):
            pytest.fail("reparse traversal reached the leaf")
        assert opened == ["", "folder"]
    else:
        with share.parents("folder\\child\\clip.mkv"):
            assert not closed
        assert opened == ["", "folder", "folder\\child"]
    assert closed == list(reversed(opened))


# Exclusive links and cleanup address the held object's tree/session/file ID
def test_link_and_delete_use_bound_handle(monkeypatch):
    sent = []
    connection = SimpleNamespace(
        send=lambda message, sid, tid: sent.append((message, sid, tid)),
        receive=lambda request: None,
    )
    tree = SimpleNamespace(
        is_dfs_share=False,
        share_name="\\\\example.com\\fixtures",
        session=SimpleNamespace(session_id=22),
        tree_connect_id=33,
    )
    handle = SimpleNamespace(tree_connect=tree, connection=connection, file_id=b"x" * 16)
    share = smb_handles.Share(
        SimpleNamespace(tree_connect_table={1: tree}), "example.com", "fixtures"
    )
    share.link(handle, "folder\\clip.mkv")
    share.remove(handle)
    assert all(
        sid == 22 and tid == 33 and message["file_id"].get_value() == b"x" * 16
        for message, sid, tid in sent
    )
    link = smb_handles.FileLinkInformation()
    link.unpack(sent[0][0]["buffer"].get_value())
    assert not link["replace_if_exists"].get_value()
    deletion = smb_handles.FileDispositionInformation()
    deletion.unpack(sent[1][0]["buffer"].get_value())
    assert deletion["delete_pending"].get_value()


# Raw protocol responses are normalized too, including symlink and DFS redirections
@pytest.mark.parametrize(
    "status",
    [
        NtStatus.STATUS_ACCESS_DENIED,
        NtStatus.STATUS_NETWORK_NAME_DELETED,
        NtStatus.STATUS_PATH_NOT_COVERED,
        NtStatus.STATUS_STOPPED_ON_SYMLINK,
    ],
)
def test_raw_protocol_error_is_unavailable(status):
    header = SMB2HeaderResponse()
    header["status"] = status
    with (
        pytest.raises(smb_transport.SmbTransportError) as caught,
        smb_transport._errors(missing=True),
    ):
        raise SMBResponseException(header)
    assert caught.value.ntstatus == status
    assert "example" not in str(caught.value)
