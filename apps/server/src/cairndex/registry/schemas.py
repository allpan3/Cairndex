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


class LibraryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    library_uuid: str
    name: str
    root_path: str
    status: LibraryStatus
    schema_version: int
    created_at: datetime
    updated_at: datetime
    last_opened_at: datetime | None
