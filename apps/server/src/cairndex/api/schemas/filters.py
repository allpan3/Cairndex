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
    # Shuffle seed for the Random view; identical seeds page identically, and
    # reseeding is just sending a new one. Ignored for every other view.
    seed: int | None = Field(default=None, ge=0)


class FacetRequest(BaseModel):
    """Faceted counts over the current browse scope, for the toolbar filter
    popovers. The scope mirrors a browse request (view/collection/search plus a
    base filter), but the base ``filter`` must exclude the facet category being
    shown so a category's own selections don't shrink its own counts."""

    view: SystemView = SystemView.ALL
    collection_id: str | None = None
    include_descendants: bool = False
    q: str | None = None
    filter: FilterExpression | None = None
    # Which facets to compute; anything else is ignored.
    facets: list[str] = Field(default_factory=lambda: ["tags"])
    # Whether parent-tag counts roll up their descendants (Any/All mode) or stay
    # direct-only (Equal/direct mode). Ignored for the rating facet.
    tag_include_descendants: bool = True


class FacetResponse(BaseModel):
    # Present only when requested. Tag map: tag id → matching-bundle count.
    tags: dict[str, int] | None = None
    # Rating map: "0".."5" or "unrated" → matching-bundle count.
    ratings: dict[str, int] | None = None
