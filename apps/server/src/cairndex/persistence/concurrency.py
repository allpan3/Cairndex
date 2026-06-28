"""Optimistic-concurrency helpers (ADR-0008 phase 9).

Frequently edited entities carry a ``version`` counter (see
``persistence.base.Version``). A client that wants safe read-modify-write sends
the version it last saw (the ``If-Match`` header); the service checks it against
the stored row and rejects a stale write with 409, then bumps the version on
success. When no expected version is supplied the edit is last-write-wins, so
existing callers keep working unchanged.
"""

from typing import Protocol

from cairndex.core.errors import VersionConflictError


class _Versioned(Protocol):
    version: int


def guard_and_bump_version(entity: _Versioned, expected_version: int | None) -> None:
    """Enforce an optimistic-concurrency precondition, then bump the version.

    If ``expected_version`` is given and does not match ``entity.version``,
    raise ``VersionConflictError`` (409) without mutating anything. Otherwise
    increment the version to mark this edit. Call once per successful edit,
    before the flush.
    """
    current = entity.version
    if expected_version is not None and current != expected_version:
        raise VersionConflictError(
            f"version {expected_version} no longer current (now {current}); reload and retry"
        )
    entity.version = (current or 0) + 1
