from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import LibraryStatus


class LibraryCreate(BaseModel):
    """Create a brand-new library package under ``root_path``."""

    root_path: str = Field(min_length=1)
    display_name: str = Field(min_length=1, max_length=255)
    # Owner setup convenience: create the root directory if it does not exist.
    create_if_missing: bool = False


class LibraryRegister(BaseModel):
    """Register an existing library directory (must already have a marker)."""

    root_path: str = Field(min_length=1)


class PathSuggestion(BaseModel):
    """One directory autocompletion for the add-library form."""

    path: str
    # True when this directory already carries a `.cairndex/manifest.json`, so
    # the menu can badge it as an existing library.
    is_library: bool


class PathSuggestions(BaseModel):
    """Directory autocompletions for the add-library form (owner setup only)."""

    suggestions: list[PathSuggestion]


class PathProbeRead(BaseModel):
    """What a candidate path is, before anything is created or registered.

    Drives the single "Add library" step: an already-registered folder is
    selected, an unregistered library is registered, and a plain folder is
    offered as a new library named after itself.
    """

    exists: bool
    is_library: bool
    # Set when this server already has this folder (matched by path, or by
    # portable uuid for a library that has since moved).
    already_registered_id: str | None
    # The name an existing library travels with, preferred over the folder name.
    manifest_display_name: str | None
    # The basename, which prefills the name field for a new library. Empty for a
    # filesystem root.
    folder_name: str


class LibraryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    library_uuid: str
    name: str
    root_path: str
    status: LibraryStatus
    schema_version: int
    # Guarded file operations, off by default (ADR-0013). The deployment switch
    # can still override this to read-only — see ``HealthStatus.write_mode``.
    write_mode_enabled: bool
    created_at: datetime
    updated_at: datetime
    last_opened_at: datetime | None
