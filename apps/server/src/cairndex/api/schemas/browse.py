from datetime import datetime

from pydantic import BaseModel

from cairndex.domain.enums import GroupingState


class BundleSummary(BaseModel):
    id: str
    title: str | None
    # 0–5 stars in half-star steps (domain/rating.py); None means unrated.
    rating: float | None
    file_count: int
    total_size: int
    has_missing: bool
    has_cover: bool
    openable: bool
    # Cache-busting key for the thumbnail URL: the id of the file the cover is
    # derived from. Changes when the cover changes so the client re-fetches.
    cover_key: str | None
    # The cover source's own pixel dimensions — not necessarily `width`/`height`
    # below, which describe the file under the playback cursor. The justified
    # layout shapes each tile to these so the cover fills it without black bars.
    cover_width: int | None
    cover_height: int | None
    # Hover/open source resolved from the bundle cursor, independent of its cover
    resume_file_id: str | None
    resume_file_updated_at: datetime | None
    resume_media_kind: str | None
    resume_relative_path: str | None
    resume_mime_type: str | None
    resume_container: str | None
    resume_video_codec: str | None
    resume_video_codec_tag: str | None
    resume_audio_codec: str | None
    resume_duration: float | None
    resume_position: float | None
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


class CollectionCountsResponse(BaseModel):
    """Both figures a collection has, because the sidebar badge shows whichever
    one its grid is showing: ``counts`` is the whole subtree, ``direct_counts``
    is the collection's own bundles."""

    counts: dict[str, int]
    direct_counts: dict[str, int]
