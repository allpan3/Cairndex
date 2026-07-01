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
    # True when linked into a scan-staged provisional bundle (not yet confirmed).
    unbundled: bool


class FileViewListingRead(BaseModel):
    # The relative directory listed ("" = the library root itself).
    path: str
    entries: list[FileViewEntryRead]


class UnbundledFilesPage(BaseModel):
    """A flat, cross-library page of not-yet-bundled files (the provisional
    scan rows), shaped like File View entries so one file row renders both."""

    items: list[FileViewEntryRead]
    total: int
    offset: int
    limit: int
