"""Grouping plan review/apply API (ADR-0009 phase 3).

Surfaces the durable grouping plan so a client can review scan suggestions and
apply them. Generating a plan is read-then-write (it runs the suggester over the
current library and persists a snapshot); applying confirms bundles, creates the
suggested collections, and links subtitles, conflict-aware and idempotent.
"""

from fastapi import APIRouter, status

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.grouping import (
    ApplyConflictRead,
    ApplyPlanRequest,
    ApplyResultRead,
    PlanRead,
    PlanSummary,
    ProposalFileMove,
    ProposalRead,
    ProposalReparent,
    ProposalUpdate,
)
from cairndex.grouping import apply as apply_service
from cairndex.grouping import plan_store

router = APIRouter(prefix="/libraries/{library_id}/grouping", tags=["grouping"])


def _summary(plan: object) -> PlanSummary:
    return PlanSummary(
        id=plan.id,  # type: ignore[attr-defined]
        status=plan.status,  # type: ignore[attr-defined]
        rule_version=plan.rule_version,  # type: ignore[attr-defined]
        generated_at=plan.generated_at,  # type: ignore[attr-defined]
        applied_at=plan.applied_at,  # type: ignore[attr-defined]
        proposal_count=len(plan.proposals),  # type: ignore[attr-defined]
    )


@router.post("/plans", response_model=PlanRead, status_code=status.HTTP_201_CREATED)
def generate_plan(db: LibrarySession) -> PlanRead:
    """Suggest a grouping for the current library and store it as the active
    plan (superseding any earlier open plan).

    This is the manual "Suggest grouping" entrypoint, so it uses the
    ``uncategorized`` scope: every bundle not yet filed into a collection —
    including a previously confirmed one whose collections were later removed —
    is re-proposed for grouping, alongside still-unbundled files. Routine
    scan/Update generation stays on the ``new`` scope (confirmed groupings are
    left untouched)."""
    plan = plan_store.generate_plan(db, scope="uncategorized")
    return PlanRead.model_validate(plan)


@router.get("/plans", response_model=list[PlanSummary])
def list_plans(db: LibrarySession) -> list[PlanSummary]:
    return [_summary(p) for p in plan_store.list_plans(db)]


@router.get("/plans/{plan_id}", response_model=PlanRead)
def get_plan(plan_id: str, db: LibrarySession) -> PlanRead:
    plan = plan_store.get_plan(db, plan_id)  # 404 if unknown
    return PlanRead.model_validate(plan)


# Persist an inline bundle/collection title edit before grouping apply
@router.patch("/plans/{plan_id}/proposals/{proposal_id}", response_model=ProposalRead)
def update_proposal(
    plan_id: str, proposal_id: str, payload: ProposalUpdate, db: LibrarySession
) -> ProposalRead:
    """Rename a bundle or collection suggestion before its open plan is applied."""
    proposal = plan_store.rename_proposal(db, plan_id, proposal_id, payload.title)
    return ProposalRead.model_validate(proposal)


# Move one reviewed file within or across bundle suggestions
@router.put(
    "/plans/{plan_id}/proposals/{proposal_id}/files/{asset_file_id}/move",
    response_model=list[ProposalRead],
)
def move_proposal_file(
    plan_id: str,
    proposal_id: str,
    asset_file_id: str,
    payload: ProposalFileMove,
    db: LibrarySession,
) -> list[ProposalRead]:
    """Move a file to an exact position in any bundle suggestion."""
    proposals = plan_store.move_proposal_file(
        db,
        plan_id,
        proposal_id,
        asset_file_id,
        payload.target_proposal_id,
        payload.target_index,
    )
    return [ProposalRead.model_validate(proposal) for proposal in proposals]


# Move one reviewed bundle into a collection suggestion
@router.put("/plans/{plan_id}/proposals/{proposal_id}/parent", response_model=ProposalRead)
def reparent_proposal(
    plan_id: str, proposal_id: str, payload: ProposalReparent, db: LibrarySession
) -> ProposalRead:
    """Move a bundle suggestion into a collection suggestion or to top level."""
    proposal = plan_store.reparent_bundle_proposal(
        db, plan_id, proposal_id, payload.parent_proposal_id
    )
    return ProposalRead.model_validate(proposal)


@router.post("/plans/{plan_id}/apply", response_model=ApplyResultRead)
def apply_plan(
    plan_id: str, db: LibrarySession, payload: ApplyPlanRequest | None = None
) -> ApplyResultRead:
    plan = plan_store.get_plan(db, plan_id)  # 404 if unknown
    proposal_ids = (
        set(payload.proposal_ids) if payload and payload.proposal_ids is not None else None
    )
    result = apply_service.apply_plan(db, plan, proposal_ids=proposal_ids)
    return ApplyResultRead(
        bundles_confirmed=result.bundles_confirmed,
        bundles_removed=result.bundles_removed,
        collections_created=result.collections_created,
        bundles_added_to_collections=result.bundles_added_to_collections,
        files_added_to_bundles=result.files_added_to_bundles,
        subtitles_linked=result.subtitles_linked,
        conflicts=[
            ApplyConflictRead(proposal_id=c.proposal_id, title=c.title, reason=c.reason)
            for c in result.conflicts
        ],
    )
