"""Optional per-library access settings private to one serving instance."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.auth import private_auth
from cairndex.auth.passwords import hash_passphrase, verify_hash
from cairndex.auth.sessions import session_store
from cairndex.core.errors import DomainError


@dataclass(frozen=True)
class LibraryAuthConfig:
    protected: bool


def read_auth(root: Path) -> dict[str, Any] | None:
    return private_auth.read(root)


def is_protected(root: Path, *, library_uuid: str | None = None) -> bool:
    """Unreadable configuration never grants anonymous access."""
    try:
        return private_auth.read(root, library_uuid) is not None
    except (OSError, ValueError, DomainError):
        return True


def requires_unlock(root: Path, session_cookie: str | None, library_id: str) -> bool:
    try:
        protected = read_auth(root) is not None
    except (OSError, ValueError, DomainError):
        return True
    return protected and not session_store.is_unlocked(session_cookie, library_id)


def status(root: Path) -> LibraryAuthConfig:
    return LibraryAuthConfig(protected=is_protected(root))


def verify_passphrase(root: Path, passphrase: str) -> bool:
    try:
        record = read_auth(root)
    except (OSError, ValueError, DomainError):
        return False
    return record is not None and verify_hash(passphrase, record)


def _revoke(root: Path, registry: Session) -> int:
    """Revoke persisted paired tokens before any credential change."""
    from cairndex.registry import device_tokens
    from cairndex.registry.models import RegisteredLibrary

    normalized = root.resolve(strict=False).as_posix()
    library_id = registry.scalar(
        select(RegisteredLibrary.id).where(RegisteredLibrary.root_path == normalized)
    )
    revoked = (
        device_tokens.revoke_device_tokens_for_library(registry, library_id) if library_id else 0
    )
    registry.commit()
    if library_id:
        session_store.revoke_library(library_id)
    return revoked


def set_passphrase(root: Path, passphrase: str, *, registry: Session) -> int:
    """Local administration uses the same private placement and revocation rule."""
    revoked = _revoke(root, registry)
    private_auth.write(root, hash_passphrase(passphrase))
    return revoked


def clear_passphrase(root: Path, *, registry: Session) -> int:
    """Remove this server's guard after revoking existing access grants."""
    revoked = _revoke(root, registry)
    private_auth.write(root, None)
    return revoked
