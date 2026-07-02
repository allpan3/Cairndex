"""Filter preview: compile an AST and return how many bundles it matches.

Live count for the toolbar/Smart Collection editor. Invalid expressions raise
``ValidationError`` (HTTP 422) — they never reach SQL.
"""

from fastapi import APIRouter
from sqlalchemy import func, select

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.filters import (
    FacetRequest,
    FacetResponse,
    FilterPreviewRequest,
    FilterPreviewResponse,
)
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import AssetBundle
from cairndex.services import browse as browse_service

router = APIRouter(prefix="/libraries/{library_id}/filters", tags=["filters"])


@router.post("/preview", response_model=FilterPreviewResponse)
def preview(payload: FilterPreviewRequest, db: LibrarySession) -> FilterPreviewResponse:
    predicate = compile_expression(db, payload.filter)
    count = db.scalar(select(func.count()).select_from(AssetBundle).where(predicate)) or 0
    return FilterPreviewResponse(count=count)


@router.post("/facets", response_model=FacetResponse)
def facets(payload: FacetRequest, db: LibrarySession) -> FacetResponse:
    """Faceted counts for the toolbar filter popovers, scoped to the current
    browse context (view/collection/search + a base filter for the *other*
    active categories). Counts stay server-side — never by fetching bundles."""
    result = browse_service.facet_counts(
        db,
        view=payload.view,
        collection_id=payload.collection_id,
        include_descendants=payload.include_descendants,
        filter_expr=payload.filter,
        search=payload.q,
        want_tags="tags" in payload.facets,
        want_ratings="ratings" in payload.facets,
        tag_include_descendants=payload.tag_include_descendants,
    )
    return FacetResponse(tags=result.tags, ratings=result.ratings)
