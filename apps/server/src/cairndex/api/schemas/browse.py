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
    openable: bool
    # Cache-busting key for the thumbnail URL: the id of the file the cover is
    # derived from. Changes when the cover changes so the client re-fetches.
    cover_key: str | None
    # Probe-backed hover preview metadata for a video effective cover. Null
    # together when the effective cover is an image or the bundle has no cover
    cover_video_file_id: str | None
    cover_video_relative_path: str | None
    cover_video_container: str | None
    cover_video_codec: str | None
    cover_video_audio_codec: str | None
    cover_video_duration: float | None
    cover_video_resume_position: float | None
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
    unbundled: int


class CountsResponse(BaseModel):
    """Generic id → bundle-count map (collections, tags)."""

    counts: dict[str, int]
