"""Passphrase hashing for the per-library lock (ADR-0010).

PBKDF2-HMAC-SHA256 with a random per-passphrase salt. No plaintext is ever
stored or logged. Kept dependency-free (stdlib ``hashlib``/``hmac``/``secrets``)
so the guardrail adds no new dependency; a stronger KDF (argon2/bcrypt) can be
swapped in later behind ``hash_passphrase``/``verify_hash`` without touching the
manifest shape (it records its own ``scheme``).
"""

import base64
import hashlib
import hmac
import secrets
from typing import Any

SCHEME = "pbkdf2_sha256"
# OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023). Tunable; the value used
# is stored per hash so raising it later does not invalidate existing hashes.
_ITERATIONS = 600_000
_SALT_BYTES = 16


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _derive(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations)


def hash_passphrase(passphrase: str, *, iterations: int = _ITERATIONS) -> dict[str, Any]:
    """Return a JSON-serializable hash record for ``passphrase``.

    Shape: ``{scheme, iterations, salt (b64), hash (b64)}``. Never contains the
    passphrase itself.
    """
    if not passphrase:
        raise ValueError("passphrase must not be empty")
    salt = secrets.token_bytes(_SALT_BYTES)
    derived = _derive(passphrase, salt, iterations)
    return {
        "scheme": SCHEME,
        "iterations": iterations,
        "salt": _b64(salt),
        "hash": _b64(derived),
    }


def verify_hash(passphrase: str, record: dict[str, Any]) -> bool:
    """Constant-time check of ``passphrase`` against a stored hash ``record``."""
    if not isinstance(record, dict) or record.get("scheme") != SCHEME:
        return False
    try:
        salt = base64.b64decode(record["salt"])
        expected = base64.b64decode(record["hash"])
        iterations = int(record["iterations"])
    except (KeyError, ValueError, TypeError):
        return False
    candidate = _derive(passphrase, salt, iterations)
    return hmac.compare_digest(candidate, expected)
