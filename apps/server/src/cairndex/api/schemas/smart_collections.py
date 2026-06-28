"""Request/response schemas for Smart Collection CRUD."""

from datetime import datetime

from pydantic import BaseModel

from cairndex.filters.ast import FilterExpression


class SmartCollectionCreate(BaseModel):
    name: str
    filter: FilterExpression
    default_sort: str | None = None
    default_layout: str | None = None


class SmartCollectionUpdate(BaseModel):
    name: str | None = None
    filter: FilterExpression | None = None
    default_sort: str | None = None
    default_layout: str | None = None
    sort_order: int | None = None


class SmartCollectionRead(BaseModel):
    id: str
    name: str
    filter: FilterExpression
    default_sort: str | None
    default_layout: str | None
    sort_order: int
    created_at: datetime
    updated_at: datetime
    # Optimistic-concurrency counter; echo back as If-Match on edits (phase 9).
    version: int
