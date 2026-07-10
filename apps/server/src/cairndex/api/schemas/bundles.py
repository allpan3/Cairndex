from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.media.image_support import is_openable_media


# --- Bundles -----------------------------------------------------------------
class BundleCreate(BaseModel):
    title: str | None = Field(default=None, max_length=1024)
    # Legacy single note; ``notes`` (the ordered list) wins when both are given.
    note: str | None = None
    notes: list[str] | None = None
    rating: int | None = Field(default=None, ge=0, le=5)


class BundleUpdate(BaseModel):
    # All optional; the route forwards only explicitly-set fields so passing
    # null clears a field (e.g. unrate, untitle, deselect cover).
    title: str | None = Field(default=None, max_length=1024)
    # ``notes`` is the multi-note list; ``note`` is the legacy single-note path.
    note: str | None = None
    notes: list[str] | None = None
    rating: int | None = Field(default=None, ge=0, le=5)
    cover_file_id: str | None = None
    primary_file_id: str | None = None


class BundleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str | None
    # Derived shadow of ``notes`` (all notes joined); kept for backward-compat
    # and the ``note`` filter.
    note: str | None
    # Ordered freeform notes (the inspector "NOTES" section). Legacy rows whose
    # ``notes`` column is NULL fall back to ``[note]``.
    notes: list[str] = Field(default_factory=list)
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

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_none_to_empty(cls, value: Any) -> Any:
        # The ORM column is NULL for rows created before ``notes`` existed;
        # coerce so validation against ``list[str]`` passes (the legacy note is
        # then restored in ``_legacy_note_fallback``).
        return [] if value is None else value

    @model_validator(mode="after")
    def _legacy_note_fallback(self) -> "BundleRead":
        if not self.notes and self.note:
            self.notes = [self.note]
        return self


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


class BundleReorder(BaseModel):
    """Manual drag-reorder of bundles (MANUAL sort). ``collection_id`` scopes the
    order to a collection's membership; null = the global All/system-view order."""

    collection_id: str | None = None
    ordered_ids: list[str] = Field(min_length=1)


class BundleCleanupOrder(BaseModel):
    """Rewrite the manual order of every bundle in scope to a chosen toolbar sort.
    ``sort`` is one of the real sorts (not ``manual``); rejected otherwise."""

    collection_id: str | None = None
    sort: Literal["date_added", "title", "rating", "size", "file_count"]
    order: Literal["asc", "desc"] = "asc"


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
    quick_fingerprint: str | None
    # True when the app can preview/play this linked file in the web viewer
    supported: bool = False
    # Normalized ffprobe output (dimensions/duration/codecs/streams), or null
    # until the file has been probed (Phase 2 scanner/probe jobs).
    tech_metadata: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int

    # Derive support from the media kind and extension, not from classifier presence
    @model_validator(mode="after")
    def derive_supported(self) -> "FileRead":
        self.supported = is_openable_media(self.media_kind, self.relative_path)
        return self


# --- Associations ------------------------------------------------------------
class SetIdsRequest(BaseModel):
    ids: list[str]


class BundleTags(BaseModel):
    bundle_id: str
    tag_ids: list[str]


class BundleCollections(BaseModel):
    bundle_id: str
    collection_ids: list[str]
