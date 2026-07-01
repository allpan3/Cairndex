"""Request/response schemas for filter preview and filtered browsing.

The canonical ``FilterExpression`` AST (filters.ast) is embedded directly so
the OpenAPI schema — and the generated frontend types — stay in lockstep with
the validator/compiler.
"""

from pydantic import BaseModel, Field

from cairndex.filters.ast import FilterExpression
from cairndex.services.browse import BundleSort, SystemView
from cairndex.services.pagination import MAX_LIMIT


class FilterPreviewRequest(BaseModel):
    filter: FilterExpression


class FilterPreviewResponse(BaseModel):
    count: int


class BrowseRequest(BaseModel):
    """Filtered browse — the same params as GET /browse plus an optional AST."""

    view: SystemView = SystemView.ALL
    collection_id: str | None = None
    include_descendants: bool = False
    sort: BundleSort = BundleSort.DATE_ADDED
    order: str = Field(default="desc", pattern="^(asc|desc)$")
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=MAX_LIMIT)
    filter: FilterExpression | None = None
    # Whole-library full-text search over bundle/file/tag/collection metadata.
    q: str | None = None
