from datetime import datetime

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
