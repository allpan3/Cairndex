"""Request/response schemas for Smart Folder CRUD."""

from datetime import datetime

from pydantic import BaseModel

from cairndex.filters.ast import FilterExpression


class SmartFolderCreate(BaseModel):
    name: str
    filter: FilterExpression
    default_sort: str | None = None
    default_layout: str | None = None


class SmartFolderUpdate(BaseModel):
    name: str | None = None
    filter: FilterExpression | None = None
    default_sort: str | None = None
    default_layout: str | None = None
    sort_order: int | None = None


class SmartFolderRead(BaseModel):
    id: str
    name: str
    filter: FilterExpression
    default_sort: str | None
    default_layout: str | None
    sort_order: int
    created_at: datetime
    updated_at: datetime
