from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)


# --- Bundles -----------------------------------------------------------------
class BundleCreate(BaseModel):
    title: str | None = Field(default=None, max_length=1024)
    note: str | None = None
    rating: int | None = Field(default=None, ge=0, le=5)


class BundleUpdate(BaseModel):
    # All optional; the route forwards only explicitly-set fields so passing
    # null clears a field (e.g. unrate, untitle, deselect cover).
    title: str | None = Field(default=None, max_length=1024)
    note: str | None = None
    rating: int | None = Field(default=None, ge=0, le=5)
    cover_file_id: str | None = None
    primary_file_id: str | None = None


class BundleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str | None
    note: str | None
    rating: int | None
    cover_file_id: str | None
    primary_file_id: str | None
    # Grouping review state (ADR-0009): provisional bundles are scan-staged and
    # await user confirmation; confirmed bundles are durable user decisions.
    grouping_state: GroupingState
    grouping_source: GroupingSource
    created_at: datetime
    imported_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int


# --- Files -------------------------------------------------------------------
class FileLink(BaseModel):
    relative_path: str = Field(min_length=1)
    role: FileRole
    media_kind: MediaKind
    display_title: str | None = Field(default=None, max_length=1024)
    sequence: int = 0
    note: str | None = None
    # File origin: a URL, magnet:, ed2k:, etc. (not necessarily an http link).
    source: str | None = None
    mime_type: str | None = Field(default=None, max_length=255)


class FileUpdate(BaseModel):
    display_title: str | None = Field(default=None, max_length=1024)
    note: str | None = None
    source: str | None = None
    role: FileRole | None = None
    sequence: int | None = None


class FileReorder(BaseModel):
    ordered_ids: list[str] = Field(min_length=1)


class BatchUpdate(BaseModel):
    bundle_ids: list[str] = Field(min_length=1)
    add_tag_ids: list[str] = Field(default_factory=list)
    remove_tag_ids: list[str] = Field(default_factory=list)
    add_collection_ids: list[str] = Field(default_factory=list)
    remove_collection_ids: list[str] = Field(default_factory=list)


class BatchResult(BaseModel):
    updated: int


class FileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    bundle_id: str
    relative_path: str
    original_filename: str
    display_title: str
    role: FileRole
    media_kind: MediaKind
    mime_type: str | None
    sequence: int
    size_bytes: int | None
    availability: FileAvailability
    # Normalized ffprobe output (dimensions/duration/codecs/streams), or null
    # until the file has been probed (Phase 2 scanner/probe jobs).
    tech_metadata: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int


# --- Associations ------------------------------------------------------------
class SetIdsRequest(BaseModel):
    ids: list[str]


class BundleTags(BaseModel):
    bundle_id: str
    tag_ids: list[str]


class BundleCollections(BaseModel):
    bundle_id: str
    collection_ids: list[str]
