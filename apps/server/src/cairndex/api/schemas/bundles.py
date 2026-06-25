from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import FileAvailability, FileRole, MediaKind


# --- Bundles -----------------------------------------------------------------
class BundleCreate(BaseModel):
    title: str | None = Field(default=None, max_length=1024)
    note: str | None = None
    source_url: str | None = None
    rating: int | None = Field(default=None, ge=0, le=5)


class BundleUpdate(BaseModel):
    # All optional; the route forwards only explicitly-set fields so passing
    # null clears a field (e.g. unrate, untitle, deselect cover).
    title: str | None = Field(default=None, max_length=1024)
    note: str | None = None
    source_url: str | None = None
    rating: int | None = Field(default=None, ge=0, le=5)
    cover_file_id: str | None = None
    primary_file_id: str | None = None


class BundleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str | None
    note: str | None
    source_url: str | None
    rating: int | None
    cover_file_id: str | None
    primary_file_id: str | None
    created_at: datetime
    imported_at: datetime
    updated_at: datetime


# --- Files -------------------------------------------------------------------
class FileLink(BaseModel):
    storage_root_id: str
    relative_path: str = Field(min_length=1)
    role: FileRole
    media_kind: MediaKind
    display_title: str | None = Field(default=None, max_length=1024)
    sequence: int = 0
    note: str | None = None
    source_url: str | None = None
    mime_type: str | None = Field(default=None, max_length=255)


class FileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    bundle_id: str
    storage_root_id: str
    relative_path: str
    original_filename: str
    display_title: str
    role: FileRole
    media_kind: MediaKind
    mime_type: str | None
    sequence: int
    size_bytes: int | None
    availability: FileAvailability
    created_at: datetime
    updated_at: datetime


# --- Associations ------------------------------------------------------------
class SetIdsRequest(BaseModel):
    ids: list[str]


class BundleTags(BaseModel):
    bundle_id: str
    tag_ids: list[str]


class BundleFolders(BaseModel):
    bundle_id: str
    folder_ids: list[str]
