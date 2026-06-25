"""File identity helpers.

The quick fingerprint is cheap (a stat) and used during scanning to detect
changes without reading file contents. The full hash reads the whole file and
is computed lazily — never on the scan/request path (AGENTS.md §5.1, §11).
"""

import hashlib
from pathlib import Path

_HASH_CHUNK = 1024 * 1024  # 1 MiB


def quick_fingerprint(size: int, mtime_ns: int) -> str:
    """A change-detecting fingerprint from size + high-resolution mtime."""
    return f"{size}:{mtime_ns}"


def compute_full_hash(path: Path) -> str:
    """Stream a SHA-256 of the whole file. Lazy/on-demand only (never on scan)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()
