"""Optional per-library owner passphrase lock (ADR-0010).

A private LAN/Tailscale guardrail, **not** public-internet hardening and **not**
multi-user auth. Each library independently stores only a passphrase *hash* in
its portable manifest; unlocking is a server-side session scoped to specific
library ids. See ADR-0010.
"""

from cairndex.auth.library_auth import (
    LibraryAuthConfig,
    clear_passphrase,
    is_protected,
    read_auth,
    requires_unlock,
    set_passphrase,
    verify_passphrase,
)
from cairndex.auth.passwords import hash_passphrase, verify_hash
from cairndex.auth.sessions import SESSION_COOKIE, SessionStore, session_store

__all__ = [
    "SESSION_COOKIE",
    "LibraryAuthConfig",
    "SessionStore",
    "clear_passphrase",
    "hash_passphrase",
    "is_protected",
    "read_auth",
    "requires_unlock",
    "session_store",
    "set_passphrase",
    "verify_hash",
    "verify_passphrase",
]
