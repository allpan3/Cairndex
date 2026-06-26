"""Filter preview: compile an AST and return how many bundles it matches.

Live count for the toolbar/Smart Folder editor. Invalid expressions raise
``ValidationError`` (HTTP 422) — they never reach SQL.
"""

from fastapi import APIRouter
from sqlalchemy import func, select

from cairndex.api.deps import DbSession
from cairndex.api.schemas.filters import FilterPreviewRequest, FilterPreviewResponse
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import AssetBundle

router = APIRouter(prefix="/filters", tags=["filters"])


@router.post("/preview", response_model=FilterPreviewResponse)
def preview(payload: FilterPreviewRequest, db: DbSession) -> FilterPreviewResponse:
    predicate = compile_expression(db, payload.filter)
    count = db.scalar(select(func.count()).select_from(AssetBundle).where(predicate)) or 0
    return FilterPreviewResponse(count=count)
