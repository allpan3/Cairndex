from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


# --- Tags --------------------------------------------------------------------
class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None
    color: str | None = Field(default=None, max_length=32)


class TagUpdate(BaseModel):
    # All optional; the route inspects model_fields_set to tell "set to null"
    # from "leave unchanged" for parent_id/color.
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = None
    color: str | None = Field(default=None, max_length=32)


class TagRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_id: str | None
    name: str
    color: str | None
    sort_order: int
    created_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int


# --- Collections -------------------------------------------------------------
class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class CollectionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = None
    note: str | None = None
    cover_bundle_id: str | None = None


class CollectionFromDirectory(BaseModel):
    """Make a collection out of a library folder (ADR-0008: collections are
    logical, so nothing on disk moves — this only reads the folder to decide
    which bundles join)."""

    directory: str = Field(min_length=1, description="Library-relative folder")
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class CollectionFromDirectoryResult(BaseModel):
    collection: "CollectionRead"
    bundles_added: int


class DirectoryBundleCount(BaseModel):
    """How many bundles a folder would contribute, for the dialog to show before
    anything is created."""

    bundle_count: int


class CollectionReorder(BaseModel):
    """A collection move: which collections, into which group, at which gap.

    Carries the move rather than a whole order. ``parent_id`` is the group they
    end up in (NULL = top level) — anything not already there is reparented as
    part of the same operation, so dragging between levels stays one request and
    never publishes a collection in its new group carrying its old position."""

    parent_id: str | None = None
    #: Collections being moved; they land as a block in their existing order.
    moved_ids: list[str] = Field(min_length=1)
    #: Insert the block immediately before this collection; null appends.
    before_id: str | None = None


class CollectionCleanup(BaseModel):
    """Rewrite every sibling group's manual order to alphabetical name order."""

    order: Literal["asc", "desc"] = "asc"


class CollectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_id: str | None
    name: str
    note: str | None = None
    cover_bundle_id: str | None = None
    sort_order: int
    created_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int


class CollectionStats(BaseModel):
    """Counts shown in the collection inspector."""

    # Bundles directly in this collection (not counting subcollections).
    direct_bundles: int
    # Distinct bundles in this collection and every descendant subcollection.
    total_bundles: int
    # Direct child subcollections.
    subcollections: int


# --- Tag groups --------------------------------------------------------------
class TagGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class TagGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class TagGroupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    sort_order: int
    created_at: datetime
    updated_at: datetime


class SetTagsRequest(BaseModel):
    tag_ids: list[str]


class TagGroupTags(BaseModel):
    group_id: str
    tag_ids: list[str]


class TagDeleteImpact(BaseModel):
    """What deleting a tag would remove, so the prompt can say so up front."""

    #: The tag itself plus every descendant.
    tags: int
    #: Distinct bundles currently carrying any of those tags.
    bundles: int
