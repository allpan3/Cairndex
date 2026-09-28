"""Descriptor-relative no-replace relocation for journaled source operations.

There is deliberately no check-then-rename or cross-device fallback. Callers keep
recovery copies before relocation and verify the captured object afterwards.
"""

import ctypes
import errno
import os
import sys


def relocate(source_fd: int, source: str, target_fd: int, target: str) -> None:
    """Move one directory entry only if the target name is vacant.

    The parent descriptors must already pass the caller's containment checks. The
    primitive does not assert that the source still contains the reviewed bytes.
    """
    if any(name in ("", ".", "..") or "/" in name or "\\" in name for name in (source, target)):
        raise ValueError("Relocation requires single directory entry names")
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function, flag = getattr(libc, "renameatx_np", None), 0x00000004
    elif sys.platform.startswith("linux"):
        function, flag = getattr(libc, "renameat2", None), 1
    else:
        function, flag = None, 0
    if function is None:
        raise OSError(errno.ENOTSUP, "Storage requires atomic no-replace relocation")
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    if function(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flag):
        error = ctypes.get_errno()
        raise OSError(error, "Source relocation failed without overwriting the destination")
    os.fsync(source_fd)
    if source_fd != target_fd:
        os.fsync(target_fd)
