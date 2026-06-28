"""Schemas for the read-only File View (storage-root filesystem browsing)."""

from datetime import datetime

from pydantic import BaseModel


class FileViewEntryRead(BaseModel):
    name: str
    relative_path: str
    # "directory" or "file".
    kind: str
    size_bytes: int | None
    modified_at: datetime | None
    extension: str | None
    mime_type: str | None
    # The app's media classification (video/image/subtitle/audio) or null.
    media_kind: str | None
    # True when the app can natively preview/play this file.
    supported: bool
    # True when this exact path is already linked into a bundle.
    linked: bool
    bundle_id: str | None


class FileViewListingRead(BaseModel):
    root_id: str
    # The relative directory listed ("" = the storage root itself).
    path: str
    entries: list[FileViewEntryRead]
