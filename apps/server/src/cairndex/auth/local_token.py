"""Loopback owner token for the desktop local-server sidecar (ADR-0018 §5).

When the desktop shell spawns a local server it generates a random token and
passes it in the environment. The sidecar then requires that token on every API
request. This replaces the ADR-0015 pairing ceremony, which makes no sense for a
process the shell started itself — there is nobody to approve the pairing.

It is an access gate for the sidecar as a whole, not a per-library grant. A
loopback port is reachable by any process on the machine, so without it any
local script could read the owner's libraries.

**It deliberately does not satisfy a library's passphrase (ADR-0010).** A device
token may, because pairing is approved from an already-unlocked owner session —
somebody proved they had access. The local token is minted with no ceremony at
all, so treating it as proof of anything beyond "this is the shell that spawned
me" would make a locked library openable by whatever can read the token.
"""

import secrets

from cairndex.core.config import get_settings


def local_token() -> str | None:
    """The configured sidecar token, or ``None`` when not running as a sidecar."""
    configured = get_settings().local_token
    if configured is None:
        return None
    token = configured.strip()
    return token or None


def sidecar_mode() -> bool:
    """Whether this server requires a loopback owner token on every request."""
    return local_token() is not None


def is_local_owner_token(candidate: str) -> bool:
    """Constant-time comparison against the configured sidecar token."""
    expected = local_token()
    if expected is None:
        return False
    return secrets.compare_digest(candidate, expected)
