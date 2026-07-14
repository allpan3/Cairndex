"""Per-library passphrase config, stored in the library's portable manifest.

The hash record lives under an optional ``auth`` key in ``.cairndex/manifest.json``
so it travels with the library (ADR-0010). Only the hash is stored — never the
passphrase. These functions read/set/clear it; the manifest's other keys are
preserved untouched.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.auth.passwords import hash_passphrase, verify_hash
from cairndex.auth.sessions import session_store
from cairndex.registry import library_package as pkg

_AUTH_KEY = "auth"


@dataclass(frozen=True)
class LibraryAuthConfig:
    """Parsed auth state for one library."""

    protected: bool


def _load_manifest_dict(root: Path) -> dict[str, Any]:
    raw = pkg.manifest_path(root).read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("manifest is not a JSON object")
    return data


def _write_manifest_dict(root: Path, data: dict[str, Any]) -> None:
    pkg.manifest_path(root).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def read_auth(root: Path) -> dict[str, Any] | None:
    """Return the stored passphrase-hash record, or None if the library has no lock."""
    data = _load_manifest_dict(root)
    if _AUTH_KEY not in data:
        return None
    record = data[_AUTH_KEY]
    if not isinstance(record, dict):
        raise ValueError("manifest auth record is not a JSON object")
    return record


def is_protected(root: Path) -> bool:
    """Treat an existing but unreadable manifest as protected (fail closed)."""
    try:
        return read_auth(root) is not None
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True


def requires_unlock(root: Path, session_cookie: str | None, library_id: str) -> bool:
    """Return whether a protected library lacks a live unlock in this session."""
    return is_protected(root) and not session_store.is_unlocked(session_cookie, library_id)


def status(root: Path) -> LibraryAuthConfig:
    return LibraryAuthConfig(protected=is_protected(root))


def verify_passphrase(root: Path, passphrase: str) -> bool:
    """True if ``passphrase`` matches the library's stored hash. False if the
    library has no lock or the passphrase is wrong (callers surface a *generic*
    error either way — never reveal which)."""
    try:
        record = read_auth(root)
    except (OSError, ValueError):
        return False
    if record is None:
        return False
    return verify_hash(passphrase, record)


def set_passphrase(root: Path, passphrase: str, *, registry: Session) -> int:
    """Set a passphrase and revoke every live token scoped to this registered root."""
    from cairndex.registry import device_tokens
    from cairndex.registry.models import RegisteredLibrary

    data = _load_manifest_dict(root)
    data[_AUTH_KEY] = hash_passphrase(passphrase)
    _write_manifest_dict(root, data)
    normalized = root.resolve(strict=False).as_posix()
    library_id = registry.scalar(
        select(RegisteredLibrary.id).where(RegisteredLibrary.root_path == normalized)
    )
    return (
        device_tokens.revoke_device_tokens_for_library(registry, library_id)
        if library_id is not None
        else 0
    )


def clear_passphrase(root: Path) -> None:
    """Remove the library's lock (make it unprotected)."""
    data = _load_manifest_dict(root)
    if _AUTH_KEY in data:
        del data[_AUTH_KEY]
        _write_manifest_dict(root, data)
