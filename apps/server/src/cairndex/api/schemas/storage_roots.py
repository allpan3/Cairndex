from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import StorageRootStatus


class StorageRootCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    canonical_path: str = Field(min_length=1)
    read_only: bool = True


class StorageRootUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    canonical_path: str | None = Field(default=None, min_length=1)
    read_only: bool | None = None


class StorageRootRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    canonical_path: str
    read_only: bool
    status: StorageRootStatus
    created_at: datetime
    updated_at: datetime
    last_scanned_at: datetime | None
