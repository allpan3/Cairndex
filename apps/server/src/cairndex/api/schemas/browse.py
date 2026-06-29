from datetime import datetime

from pydantic import BaseModel

from cairndex.domain.enums import GroupingState


class BundleSummary(BaseModel):
    id: str
    title: str | None
    rating: int | None
    file_count: int
    total_size: int
    has_missing: bool
    has_cover: bool
    media_kind: str | None
    width: int | None
    height: int | None
    duration: float | None
    extension: str | None
    date_added: datetime
    grouping_state: GroupingState


class BundleBrowsePage(BaseModel):
    items: list[BundleSummary]
    total: int
    offset: int
    limit: int


class ViewCounts(BaseModel):
    all: int
    recent: int
    uncategorized: int
    untagged: int
    missing: int


class CountsResponse(BaseModel):
    """Generic id → bundle-count map (collections, tags)."""

    counts: dict[str, int]
