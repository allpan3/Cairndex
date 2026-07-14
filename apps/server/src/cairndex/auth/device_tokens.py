"""Pairing requests and high-entropy bearer-token hashing (ADR-0015)."""

import base64
import hashlib
import hmac
import secrets
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from cairndex.core.errors import CapacityError
from cairndex.core.ids import new_id
from cairndex.core.time import utcnow

PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PAIR_CODE_LENGTH = 6
PAIR_TTL_SECONDS = 10 * 60
MAX_OUTSTANDING_PAIRS = 16
MAX_OUTSTANDING_PAIRS_PER_SOURCE = 3
TOKEN_PREFIX = "cdx_"
_TOKEN_SALT_BYTES = 16
_TOKEN_SECRET_BYTES = 32
_T = TypeVar("_T")


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def hash_device_token(token: str) -> str:
    """Return a salted hash record for a random device bearer token."""
    salt = secrets.token_bytes(_TOKEN_SALT_BYTES)
    derived = hashlib.sha256(salt + token.encode("utf-8")).digest()
    return f"sha256${_b64(salt)}${_b64(derived)}"


def verify_device_token(token: str, record: str) -> bool:
    """Compare a bearer token with its stored salted hash in constant time."""
    try:
        scheme, salt_raw, expected_raw = record.split("$", 2)
        if scheme != "sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_raw + "=" * (-len(salt_raw) % 4))
        expected = base64.urlsafe_b64decode(expected_raw + "=" * (-len(expected_raw) % 4))
    except (ValueError, TypeError):
        return False
    candidate = hashlib.sha256(salt + token.encode("utf-8")).digest()
    return hmac.compare_digest(candidate, expected)


def create_device_token() -> tuple[str, str]:
    """Create a lookupable opaque token and return ``(device_id, plaintext)``."""
    device_id = new_id()
    secret = secrets.token_urlsafe(_TOKEN_SECRET_BYTES)
    return device_id, f"{TOKEN_PREFIX}{device_id}.{secret}"


def device_id_from_token(token: str) -> str | None:
    """Extract the registry id from a syntactically valid bearer token."""
    if not token.startswith(TOKEN_PREFIX):
        return None
    identifier, separator, secret = token[len(TOKEN_PREFIX) :].partition(".")
    if not separator or len(identifier) != 26 or len(secret) < 40:
        return None
    return identifier


@dataclass
class _PairRequest:
    pair_code_hash: bytes
    poll_key_hash: bytes
    source_hash: bytes
    device_name: str
    expires_at: float
    library_ids: list[str] | None = None
    consuming: bool = False


class PairingStore:
    """Bounded in-memory pairing state containing no plaintext code or token."""

    def __init__(
        self,
        *,
        ttl_seconds: int = PAIR_TTL_SECONDS,
        max_outstanding: int = MAX_OUTSTANDING_PAIRS,
    ) -> None:
        self._ttl = ttl_seconds
        self._max_outstanding = max_outstanding
        self._requests: deque[_PairRequest] = deque()
        self._lock = threading.Lock()

    def _now(self) -> float:
        return utcnow().timestamp()

    def _purge_expired(self) -> None:
        now = self._now()
        self._requests = deque(request for request in self._requests if request.expires_at > now)

    def start(self, device_name: str, *, source: str = "unknown") -> tuple[str, str]:
        """Create a pairing request without letting anonymous callers evict pending work."""
        with self._lock:
            self._purge_expired()
            source_hash = _digest(source)
            source_count = sum(
                hmac.compare_digest(source_hash, request.source_hash) for request in self._requests
            )
            if source_count >= MAX_OUTSTANDING_PAIRS_PER_SOURCE:
                raise CapacityError("Too many outstanding pairing requests from this client")
            if len(self._requests) >= self._max_outstanding:
                raise CapacityError("Too many outstanding pairing requests")
            existing = [request.pair_code_hash for request in self._requests]
            while True:
                pair_code = "".join(
                    secrets.choice(PAIR_CODE_ALPHABET) for _ in range(PAIR_CODE_LENGTH)
                )
                pair_hash = _digest(pair_code)
                if not any(hmac.compare_digest(pair_hash, candidate) for candidate in existing):
                    break
            poll_key = secrets.token_urlsafe(_TOKEN_SECRET_BYTES)
            self._requests.append(
                _PairRequest(
                    pair_code_hash=pair_hash,
                    poll_key_hash=_digest(poll_key),
                    source_hash=source_hash,
                    device_name=device_name,
                    expires_at=self._now() + self._ttl,
                )
            )
            return pair_code, poll_key

    def approve(self, pair_code: str, library_ids: list[str]) -> bool:
        """Attach approved library scopes to a live code using constant-time checks."""
        candidate = _digest(pair_code)
        with self._lock:
            self._purge_expired()
            matched: _PairRequest | None = None
            for request in self._requests:
                if hmac.compare_digest(candidate, request.pair_code_hash):
                    matched = request
            if matched is None:
                return False
            matched.library_ids = list(library_ids)
            return True

    def consume_approval(self, poll_key: str, issue: Callable[[str, list[str]], _T]) -> _T | None:
        """Issue outside the store lock and remove state only after a committed success."""
        candidate = _digest(poll_key)
        with self._lock:
            self._purge_expired()
            matched: _PairRequest | None = None
            for request in self._requests:
                if hmac.compare_digest(candidate, request.poll_key_hash):
                    matched = request
            if matched is None or matched.library_ids is None or matched.consuming:
                return None
            matched.consuming = True
            device_name = matched.device_name
            library_ids = list(matched.library_ids)
        try:
            result = issue(device_name, library_ids)
        except Exception:
            with self._lock:
                if matched in self._requests:
                    matched.consuming = False
            raise
        with self._lock:
            if matched in self._requests:
                self._requests.remove(matched)
        return result

    def clear(self) -> None:
        """Remove all outstanding requests during test teardown."""
        with self._lock:
            self._requests.clear()


pairing_store = PairingStore()
