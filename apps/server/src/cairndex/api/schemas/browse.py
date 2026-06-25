from datetime import datetime

from pydantic import BaseModel


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


class FolderCounts(BaseModel):
    counts: dict[str, int]
