from ulid import ULID


def new_id() -> str:
    """Return a fresh ULID as a 26-character Crockford base32 string.

    Centralized so the ID format is consistent across all entities and can be
    monkeypatched in tests (see ADR-0002). ULIDs are time-sortable, which the
    pagination layer relies on for a stable tie-breaker.
    """
    return str(ULID())
