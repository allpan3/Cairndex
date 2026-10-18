from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


#: A timestamp the API always sends with its UTC offset. Stored timestamps are
#: UTC (ADR-0002), but a portable catalog keeps the legacy database's naive
#: strings, and a browser reads a naive timestamp as local time.
UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class Page[T](BaseModel):
    """A keyset-paginated slice of a collection.

    ``next_cursor`` is an opaque token (the last item's sort key) to pass back
    as ``cursor`` for the following page; ``None`` means no more results.
    Keyset pagination (over the sortable ULID id) gives stable, deterministic
    ordering without offset drift as rows are inserted (AGENTS.md §10/§11).
    """

    items: list[T]
    next_cursor: str | None = None


class ErrorBody(BaseModel):
    """Structured error response (AGENTS.md §10).

    ``details`` is present only for errors a client can act on programmatically
    — today the ownership-lease refusals (ADR-0018), which carry the holding
    server's name and advertised URL so the client can offer a redirect. Absent
    on every other error, so existing consumers are unaffected.
    """

    code: str
    message: str
    details: dict[str, Any] | None = None
