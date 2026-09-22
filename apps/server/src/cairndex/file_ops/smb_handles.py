"""Bind publication requests to one authenticated share without following referrals"""

from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any

from smbprotocol.file_info import (  # type: ignore[import-untyped]
    FileBasicInformation,
    FileDispositionInformation,
    FileFsVolumeInformation,
    FileInternalInformation,
    FileLinkInformation,
    FileStandardInformation,
)
from smbprotocol.open import (  # type: ignore[import-untyped]
    CreateDisposition,
    CreateOptions,
    FileAttributes,
    ImpersonationLevel,
    Open,
    ShareAccess,
    SMB2QueryInfoRequest,
    SMB2QueryInfoResponse,
    SMB2SetInfoRequest,
)
from smbprotocol.open import (
    FilePipePrinterAccessMask as Access,
)
from smbprotocol.structure import DateTimeField  # type: ignore[import-untyped]
from smbprotocol.tree import TreeConnect  # type: ignore[import-untyped]


# Send metadata requests on the already-open handle's session and tree
def _request(handle: Any, message: Any) -> Any:
    tree = handle.tree_connect
    request = handle.connection.send(message, tree.session.session_id, tree.tree_connect_id)
    return handle.connection.receive(request)


# Query identity from the held object, never by reopening its pathname
def _query(handle: Any, info_type: Any, size: int | None = None) -> Any:
    info = info_type()
    request = SMB2QueryInfoRequest()
    request["info_type"] = info.INFO_TYPE
    request["file_info_class"] = info.INFO_CLASS
    request["file_id"] = handle.file_id
    request["output_buffer_length"] = size or len(info)
    response = SMB2QueryInfoResponse()
    response.unpack(_request(handle, request)["data"].get_value())
    return response.parse_buffer(info_type)


# Change only the held object using the dependency's SMB structures
def _set(handle: Any, info: Any) -> None:
    request = SMB2SetInfoRequest()
    request["info_type"] = info.INFO_TYPE
    request["file_info_class"] = info.INFO_CLASS
    request["file_id"] = handle.file_id
    request["buffer"] = info
    _request(handle, request)


# Preserve version-one identity quantities for historical journal receipts
def observation(handle: Any) -> dict[str, int]:
    basic = _query(handle, FileBasicInformation)
    volume = _query(handle, FileFsVolumeInformation, 88)
    internal = _query(handle, FileInternalInformation)
    standard = _query(handle, FileStandardInformation)
    return {
        "size": standard["end_of_file"].get_value(),
        "mtime_ns": (basic["last_write_time"].get_value() - DateTimeField.EPOCH_FILETIME) * 100,
        "file_id": internal["index_number"].get_value(),
        "volume_serial": volume["volume_serial_number"].get_value(),
    }


# A bound tree deliberately bypasses smbclient's implicit account and DFS selection
class Share:
    def __init__(self, session: Any, server: str, share: str) -> None:
        name = f"\\\\{server}\\{share}"
        self.tree: Any = next(
            (tree for tree in session.tree_connect_table.values() if tree.share_name == name),
            None,
        )
        if self.tree is None:
            self.tree = TreeConnect(session, name)
            self.tree.connect(require_secure_negotiate=True)
        if self.tree.is_dfs_share:
            raise ValueError("SMB referrals are unsupported")

    # Refuse reparse objects and hold the open object against pathname replacement
    @contextmanager
    def open(
        self,
        name: str,
        *,
        access: int = Access.FILE_READ_ATTRIBUTES,
        create: bool = False,
        temporary: bool = False,
        directory: bool = False,
        share_delete: bool = False,
        exclusive: bool = False,
    ) -> Iterator[Any]:
        handle = Open(self.tree, name)
        options = CreateOptions.FILE_OPEN_REPARSE_POINT
        if directory:
            options |= CreateOptions.FILE_DIRECTORY_FILE
        if temporary:
            options |= CreateOptions.FILE_DELETE_ON_CLOSE
            access |= Access.DELETE
        handle.create(
            ImpersonationLevel.Impersonation,
            access,
            FileAttributes.FILE_ATTRIBUTE_NORMAL,
            0
            if exclusive
            else (
                ShareAccess.FILE_SHARE_READ
                | ShareAccess.FILE_SHARE_WRITE
                | (ShareAccess.FILE_SHARE_DELETE if share_delete else 0)
            ),
            CreateDisposition.FILE_CREATE if create else CreateDisposition.FILE_OPEN,
            options,
        )
        try:
            if handle.file_attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError("SMB reparse points are unsupported")
            yield handle
        finally:
            handle.close()

    # Check and hold each ancestor before issuing a request beneath it
    @contextmanager
    def parents(self, name: str) -> Iterator[None]:
        with ExitStack() as stack:
            components = name.split("\\")
            for length in range(len(components)):
                stack.enter_context(self.open("\\".join(components[:length]), directory=True))
            yield

    # Link complete bytes exclusively on this tree without reopening the source
    def link(self, handle: Any, destination: str) -> None:
        info = FileLinkInformation()
        info["replace_if_exists"] = False
        info["file_name"] = destination
        _set(handle, info)

    # Delete the owned open name rather than a possibly replaced pathname
    def remove(self, handle: Any) -> None:
        info = FileDispositionInformation()
        info["delete_pending"] = True
        _set(handle, info)
