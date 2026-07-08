"""Shared helpers for versioned derived-media cache artifacts."""

from __future__ import annotations

import fcntl
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


# Return a URL-safe version token from a source quick fingerprint
def version_param(quick_fingerprint: str | None) -> str:
    return quote(quick_fingerprint or "no-fingerprint", safe="")


# Return the standard sibling sidecar for a derived artifact's source fingerprint
def fingerprint_sidecar(artifact_path: Path) -> Path:
    return artifact_path.with_suffix(".fingerprint")


# Return the standard sibling lock path for a derived artifact
def lock_path(artifact_path: Path) -> Path:
    return artifact_path.with_suffix(".lock")


# Hold an exclusive OS file lock while one derivative is generated
@contextmanager
def locked(artifact_path: Path) -> Iterator[None]:
    path = lock_path(artifact_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# Read a cached artifact fingerprint without opening the artifact itself
def read_fingerprint(artifact_path: Path) -> str | None:
    try:
        return fingerprint_sidecar(artifact_path).read_text(encoding="utf-8").strip()
    except OSError:
        return None


# Atomically persist an artifact fingerprint sidecar
def write_fingerprint(artifact_path: Path, quick_fingerprint: str | None) -> None:
    sidecar = fingerprint_sidecar(artifact_path)
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f"{sidecar.name}.tmp-",
        suffix=".tmp",
        dir=sidecar.parent,
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_text(quick_fingerprint or "", encoding="utf-8")
        tmp_path.replace(sidecar)
    finally:
        tmp_path.unlink(missing_ok=True)


# True when the artifact exists and its fingerprint matches the current source
def is_current(artifact_path: Path, quick_fingerprint: str | None) -> bool:
    return artifact_path.exists() and read_fingerprint(artifact_path) == (quick_fingerprint or "")
