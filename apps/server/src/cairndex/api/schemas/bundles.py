from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.domain.rating import RATING_MAX, RATING_MIN, RATING_STEP, is_valid_rating
from cairndex.media.image_support import is_openable_media


# --- Bundles -----------------------------------------------------------------
def _check_rating_step(value: float | None) -> float | None:
    """Reject a rating that is in range but off the half-star grid (e.g. 3.3).

    ``ge``/``le`` cover the range; nothing in Pydantic covers the step, and the
    column's CHECK constraint cannot either (see ``domain/rating.py``), so this
    is the boundary where an off-grid value is turned away.
    """
    if value is not None and not is_valid_rating(value):
        raise ValueError(f"rating must be a multiple of {RATING_STEP:g}")
    return value


class BundleCreate(BaseModel):
    title: str | None = Field(default=None, max_length=1024)
    notes: list[str] | None = None
    rating: float | None = Field(default=None, ge=RATING_MIN, le=RATING_MAX)

    _rating_step = field_validator("rating")(_check_rating_step)


class BundleUpdate(BaseModel):
    # All optional; the route forwards only explicitly-set fields so passing
    # null clears a field (e.g. unrate, untitle, deselect cover).
    title: str | None = Field(default=None, max_length=1024)
    notes: list[str] | None = None
    rating: float | None = Field(default=None, ge=RATING_MIN, le=RATING_MAX)
    cover_file_id: str | None = None

    _rating_step = field_validator("rating")(_check_rating_step)


class BundleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str | None
    # Ordered freeform notes (the inspector "NOTES" section). A pre-``notes`` row
    # (column NULL) reads back as an empty list.
    notes: list[str] = Field(default_factory=list)
    rating: float | None
    cover_file_id: str | None
    # Current ordered-media location; falls back to legacy progress/first openable file
    resume_file_id: str | None = None
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
        # coerce so validation against ``list[str]`` passes.
        return [] if value is None else value


# Request to move a bundle's current ordered-media location
class BundleCursorUpdate(BaseModel):
    file_id: str = Field(min_length=1)


# Persisted current ordered-media location
class BundleCursorRead(BaseModel):
    file_id: str


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


class FileRepairRequest(BaseModel):
    replacement_file_id: str = Field(min_length=1)


class FileRepairCandidateRead(BaseModel):
    missing_file_id: str
    replacement_file_id: str
    replacement_bundle_id: str
    relative_path: str
    display_title: str


class ForgetMissingRequest(BaseModel):
    """Which missing files to drop. ``None`` means every missing file in the
    bundle, which is what the card-level action sends."""

    file_ids: list[str] | None = None


class ForgetMissingResult(BaseModel):
    # ``bundle_deleted`` when the last file went with them, so the client knows to
    # leave the album view rather than refetch a bundle that is gone.
    forgotten: int
    bundle_deleted: bool


class BundleReorder(BaseModel):
    """Manual drag-reorder of bundles (MANUAL sort). ``collection_id`` scopes the
    order to a collection's membership; null = the global All/system-view order.

    The client sends the *move it made*, not the order it believes in: which
    bundles were dragged and which bundle they were dropped in front of. The
    server owns the resulting order.

    This used to take the client's whole visible list and number it 0..n-1, which
    was only ever correct when the client had the entire scope loaded. Browsing
    is paged, so a drag in a collection larger than one page renumbered the
    loaded window on top of order values the rest of the collection still held —
    and unloaded bundles then surfaced in the middle, or the dragged one appeared
    to jump to an end. Sending the intent makes the size of the loaded window
    irrelevant."""

    collection_id: str | None = None
    #: Bundles being moved, in any order — they land as a block, keeping the
    #: relative order they already have in the scope.
    moved_ids: list[str] = Field(min_length=1)
    #: Insert the block immediately before this bundle; null appends to the end.
    before_id: str | None = None


class BundleOrder(BaseModel):
    """The scope's resulting manual order, returned by a reorder so the client
    never has to guess where the move landed (or refetch to find out)."""

    ordered_ids: list[str]


class BundleCleanupOrder(BaseModel):
    """Rewrite the manual order of every bundle in scope to a chosen toolbar sort.
    ``sort`` is one of the real sorts (not ``manual``); rejected otherwise."""

    collection_id: str | None = None
    sort: Literal[
        "date_added", "date_modified", "date_opened", "title", "rating", "size", "file_count"
    ]
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
    cover_time: float | None
    # Incomplete saved progress for hover activation; null for new/completed files
    resume_position: float | None = None
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

    # The name a file is shown under is its *current* filename, derived here
    # rather than served from the stored column.
    #
    # The column is a copy of the filename made when the row was created, and a
    # copy can drift: three separate code paths repoint a row, and each one that
    # forgot to update the copy left the file showing its old name inside its
    # bundle while the File Browser showed the new one (owner reports,
    # 2026-07-30 — three rounds, because fixing one writer at a time never
    # reaches the rows already wrong). Deriving it makes that class of bug
    # impossible instead of fixing it once per writer, and needs no guess about
    # which stored titles are stale.
    #
    # The column is still kept in step by those paths, because the search index
    # reads it — but nothing renders it. A real "call this file something else"
    # feature would add its own nullable override and be preferred here, which is
    # the distinction the current column cannot make: it cannot tell a title
    # someone chose from a filename it happens to equal.
    @model_validator(mode="after")
    def derive_display_title(self) -> "FileRead":
        self.display_title = PurePosixPath(self.relative_path).name
        return self


# --- Directory members -------------------------------------------------------
class DirectoryMemberCreate(BaseModel):
    """Collapse one of the bundle's directories into a single row (plan 6).

    Library-relative; absolute paths and traversal are rejected in the service
    through the same guard every other client-supplied path goes through.
    """

    directory_path: str = Field(min_length=1)


class DirectoryMemberRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    bundle_id: str
    directory_path: str
    # The folder's own name, derived rather than stored, for the same reason
    # ``FileRead.display_title`` is: a stored copy drifts when the path is
    # repaired, and there is no case where the row wants a name of its own.
    name: str = ""
    sequence: int
    #: Files *from this bundle* inside the folder — not the count on disk, which
    #: can be larger (plan 6 §4.2). Filled by the route.
    file_count: int = 0
    created_at: datetime

    @model_validator(mode="after")
    def derive_name(self) -> "DirectoryMemberRead":
        self.name = PurePosixPath(self.directory_path).name
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
