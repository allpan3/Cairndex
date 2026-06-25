from datetime import UTC, datetime


def utcnow() -> datetime:
    """Current time as a timezone-aware UTC datetime.

    Centralized so timestamp defaults are consistent and easy to freeze in
    tests (ADR-0002: timestamps are set in the application layer, not the DB
    clock).
    """
    return datetime.now(UTC)
