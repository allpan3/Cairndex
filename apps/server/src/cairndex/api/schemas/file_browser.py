"""Schemas for the read-only File Browser (storage-root filesystem browsing)."""

from datetime import datetime

from pydantic import BaseModel


class FileBrowserEntryRead(BaseModel):
    name: str
    relative_path: str
    # "directory" or "file".
    kind: str
    size_bytes: int | None
    modified_at: datetime | None
    # When the file was created / added on disk (distinct from modified_at); null
    # for rows sourced from the DB where only mtime is known.
    created_at: datetime | None
    extension: str | None
    mime_type: str | None
    # The app's media classification (video/image/subtitle/audio) or null.
    media_kind: str | None
    # True when the app can natively preview/play this file.
    supported: bool
    # True when this exact path is already linked into a bundle.
    linked: bool
    bundle_id: str | None
    # Linked-file metadata used by card hover preview; unlinked paths stay null
    file_id: str | None
    container: str | None
    video_codec: str | None
    # Container codec tag (hvc1/hev1); null on rows probed before v3.
    video_codec_tag: str | None
    audio_codec: str | None
    duration: float | None
    resume_position: float | None
    # True when linked into a scan-staged provisional bundle (not yet confirmed).
    unbundled: bool


class FileBrowserListingRead(BaseModel):
    # The relative directory listed ("" = the library root itself).
    path: str
    entries: list[FileBrowserEntryRead]
    # Linked file rows newly marked missing during this bounded directory read
    missing_files_updated: int


class UnbundledFilesPage(BaseModel):
    """A flat, cross-library page of not-yet-bundled files (the provisional
    scan rows), shaped like File Browser entries so one file row renders both."""

    items: list[FileBrowserEntryRead]
    total: int
    offset: int
    limit: int
