from sqlalchemy import Select
from sqlalchemy.orm import InstrumentedAttribute, Session

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def keyset_page[M](
    session: Session,
    stmt: Select[tuple[M]],
    id_column: InstrumentedAttribute[str],
    limit: int,
    cursor: str | None,
) -> tuple[list[M], str | None]:
    """Fetch one keyset page ordered by the (sortable ULID) id column.

    Fetches ``limit + 1`` rows to detect whether another page exists without a
    second count query. Returns the page plus the cursor for the next page
    (the last row's id), or ``None`` when the collection is exhausted.
    """
    if cursor is not None:
        stmt = stmt.where(id_column > cursor)
    stmt = stmt.order_by(id_column).limit(limit + 1)

    rows = list(session.scalars(stmt).all())
    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = getattr(rows[-1], id_column.key)
    return rows, next_cursor
