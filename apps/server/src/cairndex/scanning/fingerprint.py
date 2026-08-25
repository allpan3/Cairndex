"""File identity helpers.

The quick fingerprint is cheap (a stat) and used during scanning to detect
changes without reading file contents. The full hash reads the whole file and
is computed lazily — never on the scan/request path (AGENTS.md §5.1, §11).
"""

import hashlib
from pathlib import Path

_HASH_CHUNK = 1024 * 1024  # 1 MiB
_SQLITE_INT64_MAX = (1 << 63) - 1
_UINT64_MODULUS = 1 << 64


def quick_fingerprint(size: int, mtime_ns: int) -> str:
    """A change-detecting fingerprint from size + high-resolution mtime."""
    return f"{size}:{mtime_ns}"


# Encode an unsigned filesystem identifier as the same 64 bits in SQLite
def sqlite_filesystem_identity(value: int) -> int:
    """Return a signed 64-bit representation suitable for SQLite INTEGER.

    ``st_dev`` and ``st_ino`` may be unsigned 64-bit values on network
    filesystems. SQLite integers are signed, so preserve the bits using their
    two's-complement representation; equality matching remains exact.

    Lives here rather than in the scanner because anything comparing a *stored*
    identity against a fresh ``stat`` has to encode it the same way, and the
    staging cleanup does exactly that.
    """
    if not 0 <= value < _UINT64_MODULUS:
        raise ValueError("filesystem identity is outside the unsigned 64-bit range")
    return value if value <= _SQLITE_INT64_MAX else value - _UINT64_MODULUS


def compute_full_hash(path: Path) -> str:
    """Stream a SHA-256 of the whole file. Lazy/on-demand only (never on scan)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()
