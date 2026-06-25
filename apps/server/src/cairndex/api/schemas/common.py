from pydantic import BaseModel


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
    """Structured error response (AGENTS.md §10)."""

    code: str
    message: str
