"""Library ownership leases (ADR-0018).

A server may serve a library only while it holds that library's lease file at
``.cairndex/locks/active-owner.json``. Enforcement lives in the library folder
rather than in any server's registry because the two servers in a conflict
cannot see each other, and a cloud-synced copy of a library has no server at
all — the folder is the one thing every would-be server can observe.

``lease`` owns the file format and state classification; ``manager`` owns
acquisition, the heartbeat/watchdog loop, and release.
"""

from cairndex.ownership.lease import (
    LeaseHolder,
    LeaseRecord,
    LeaseSnapshot,
    LeaseState,
    classify,
    new_nonce,
    read_lease,
)
from cairndex.ownership.manager import (
    LeaseManager,
    LeaseSettings,
    get_lease_manager,
    reset_lease_manager,
)

__all__ = [
    "LeaseHolder",
    "LeaseManager",
    "LeaseRecord",
    "LeaseSettings",
    "LeaseSnapshot",
    "LeaseState",
    "classify",
    "get_lease_manager",
    "new_nonce",
    "read_lease",
    "reset_lease_manager",
]
