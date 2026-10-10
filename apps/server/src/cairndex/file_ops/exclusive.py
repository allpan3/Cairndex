"""Exclusive immutable metadata publication within a verified directory."""

import os


def link(handle: int, source: str, target: str) -> None:
    """Publish a complete file without replacing an existing directory entry.

    Unsupported filesystems fail without a copy or replacement fallback.
    Callers validate the directory and sync the published metadata.
    """
    if any(name in ("", ".", "..") or "/" in name or "\\" in name for name in (source, target)):
        raise ValueError("Publication requires single directory entry names")
    os.link(source, target, src_dir_fd=handle, dst_dir_fd=handle, follow_symlinks=False)
