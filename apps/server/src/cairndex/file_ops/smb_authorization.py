"""Explicit local authorization for the signed sidecar's exact mounted SMB login."""

import argparse
import errno
import sys
from pathlib import Path

from cairndex.file_ops import smb_transport


def main(argv: list[str]) -> int:
    """Request one matching login and verify SMB3 without starting an HTTP server."""
    parser = argparse.ArgumentParser(prog="cairndex-sidecar authorize-smb")
    parser.add_argument("path", type=Path, help="an existing directory on the mounted SMB share")
    args = parser.parse_args(argv)
    try:
        root = args.path.resolve(strict=True)
        if not root.is_dir():
            raise OSError("Authorization requires a mounted directory")
        mount = smb_transport.mount_for(root)
        if mount is None:
            raise OSError("Authorization requires a macOS SMB mount")
        smb_transport._connect(mount, allow_prompt=True)
    except OSError as error:
        # Report only numeric codes, never exception text containing private paths.
        status = getattr(error, "keychain_status", None)
        detail = f" Security status: {status}." if isinstance(status, int) else ""
        if error.errno == errno.ETIMEDOUT:
            detail = " The authorization request timed out."
        sys.stderr.write(
            f"SMB authorization or connection failed.{detail} No library files were changed.\n"
        )
        return 1
    finally:
        smb_transport.close_sessions()
    print("SMB saved-login access and signed, encrypted SMB3 connection verified.")
    return 0
