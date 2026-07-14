"""In-process server-side sessions for the per-library lock (ADR-0010).

A session is an opaque token (the ``cairndex_session`` cookie) mapping to a set
of unlocked ``library_id``s, each with its own expiry — so unlocking one library
never unlocks another, and each protected library must be unlocked on its own.

The store is in-memory and single-process: a restart drops all sessions (safe
direction — everything re-locks). This matches Cairndex's single-owner model;
it is not a multi-process/clustered session backend.
"""

import secrets
import threading
from dataclasses import dataclass, field

from cairndex.core.time import utcnow

SESSION_COOKIE = "cairndex_session"
# How long an unlock lasts before the library re-locks and must be unlocked again.
DEFAULT_TTL_SECONDS = 12 * 60 * 60


@dataclass
class _Session:
    # library_id -> unix expiry timestamp
    unlocked: dict[str, float] = field(default_factory=dict)


class SessionStore:
    """Thread-safe opaque-token session store."""

    def __init__(self, *, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    def _now(self) -> float:
        return utcnow().timestamp()

    def unlock(self, token: str | None, library_id: str) -> str:
        """Grant ``library_id`` in the session for ``token`` (creating a session
        + token if needed). Returns the token the caller should set as the cookie."""
        with self._lock:
            if not token or token not in self._sessions:
                token = secrets.token_urlsafe(32)
                self._sessions[token] = _Session()
            self._sessions[token].unlocked[library_id] = self._now() + self._ttl
            return token

    def is_unlocked(self, token: str | None, library_id: str) -> bool:
        if not token:
            return False
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return False
            expiry = session.unlocked.get(library_id)
            if expiry is None:
                return False
            if expiry < self._now():
                # Expired: drop it so it reads as locked from now on.
                del session.unlocked[library_id]
                return False
            return True

    def unlocked_library_ids(self, token: str | None) -> set[str]:
        """Return this session's live library grants while pruning expired ones."""
        if not token:
            return set()
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return set()
            now = self._now()
            expired = [
                library_id for library_id, expiry in session.unlocked.items() if expiry < now
            ]
            for library_id in expired:
                del session.unlocked[library_id]
            return set(session.unlocked)

    def lock(self, token: str | None, library_id: str) -> None:
        """Revoke ``library_id`` from the session (manual Lock action)."""
        if not token:
            return
        with self._lock:
            session = self._sessions.get(token)
            if session is not None:
                session.unlocked.pop(library_id, None)

    def clear(self) -> None:
        """Drop all sessions (test teardown / full reset)."""
        with self._lock:
            self._sessions.clear()


# Process-wide session store (single-owner, single-process app).
session_store = SessionStore()
