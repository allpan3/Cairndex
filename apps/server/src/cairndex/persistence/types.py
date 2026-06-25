from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator


class UtcDateTime(TypeDecorator[datetime]):
    """A timezone-aware datetime that always reads back as UTC.

    SQLite has no native timezone support and returns naive datetimes, which
    would silently break the "tz-aware UTC" guarantee in ADR-0002. This
    decorator rejects naive values on write and re-attaches UTC on read so the
    application only ever sees aware UTC datetimes, regardless of backend.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime is not allowed; use an aware UTC datetime")
        return value.astimezone(UTC)

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        result: datetime = value
        if result.tzinfo is None:
            return result.replace(tzinfo=UTC)
        return result.astimezone(UTC)
