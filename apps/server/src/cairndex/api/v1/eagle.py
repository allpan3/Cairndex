"""Eagle migration endpoints: dry-run preview and idempotent import (§7).

Preview reads the library read-only and reports what an import would do; import
applies it. Both are safe to call repeatedly — import skips already-imported
items via ``import_records``.
"""

from pathlib import Path

from fastapi import APIRouter

from cairndex.api.deps import DbSession
from cairndex.api.schemas.eagle import (
    EagleImportRequest,
    ImportPlanRead,
    ImportResultRead,
    MergeSuggestionRead,
)
from cairndex.eagle.planner import plan_import
from cairndex.eagle.reader import read_library
from cairndex.services import eagle as eagle_service

router = APIRouter(prefix="/eagle", tags=["eagle"])


@router.post("/preview", response_model=ImportPlanRead)
def preview(payload: EagleImportRequest, db: DbSession) -> ImportPlanRead:
    library = read_library(Path(payload.library_path))
    already = eagle_service.existing_external_ids(db, [i.id for i in library.items])
    plan = plan_import(library, already)
    return ImportPlanRead(
        library_path=plan.library_path,
        total_items=plan.total_items,
        new_bundles=plan.new_bundles,
        skipped_existing=plan.skipped_existing,
        skipped_deleted=plan.skipped_deleted,
        folders=plan.folders,
        tags=plan.tags,
        tag_groups=plan.tag_groups,
        merge_suggestions=[
            MergeSuggestionRead(reason=s.reason, item_ids=list(s.item_ids))
            for s in plan.merge_suggestions
        ],
        warnings=list(plan.warnings),
    )


@router.post("/import", response_model=ImportResultRead)
def run_import(payload: EagleImportRequest, db: DbSession) -> ImportResultRead:
    result = eagle_service.import_library(db, payload.library_path)
    return ImportResultRead(
        bundles_created=result.bundles_created,
        folders_created=result.folders_created,
        tags_created=result.tags_created,
        tag_groups_created=result.tag_groups_created,
        skipped=result.skipped,
    )
