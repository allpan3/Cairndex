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


# --- Folders -----------------------------------------------------------------
class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = None


class FolderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_id: str | None
    name: str
    sort_order: int
    created_at: datetime
    updated_at: datetime


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
