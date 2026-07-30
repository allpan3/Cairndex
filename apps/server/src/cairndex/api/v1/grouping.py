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
    PlanGenerateRequest,
    PlanRead,
    PlanSummary,
    ProposalDestinationUpdate,
    ProposalFileMove,
    ProposalKindUpdate,
    ProposalRead,
    ProposalReparent,
    ProposalUpdate,
    StemModeUpdate,
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
def generate_plan(db: LibrarySession, payload: PlanGenerateRequest | None = None) -> PlanRead:
    """Suggest a grouping for the current library and store it as the active
    plan (superseding any earlier open plan).

    Manual and scan-triggered generation share the same durable boundary:
    confirmed bundles stay settled regardless of collection membership, while
    still-unbundled files and new additions remain eligible."""
    plan = plan_store.generate_plan(db, stem_modes=payload.stem_modes if payload else None)
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


# Persist an addition proposal's existing-versus-new destination choice
@router.put("/plans/{plan_id}/proposals/{proposal_id}/destination", response_model=ProposalRead)
def update_proposal_destination(
    plan_id: str,
    proposal_id: str,
    payload: ProposalDestinationUpdate,
    db: LibrarySession,
) -> ProposalRead:
    """Switch an addition candidate between its existing target and a new bundle."""
    proposal = plan_store.set_proposal_destination(
        db, plan_id, proposal_id, payload.create_new_bundle
    )
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


# Adjust one directory's stem sensitivity without rebuilding the plan
@router.put("/plans/{plan_id}/stem-modes", response_model=PlanRead)
def set_stem_mode(plan_id: str, payload: StemModeUpdate, db: LibrarySession) -> PlanRead:
    """Set one directory's stem sensitivity and re-suggest that directory in
    place. Every proposal outside the directory — and therefore every owner
    edit elsewhere — keeps its identity; `POST /plans` remains the full reset."""
    plan = plan_store.set_directory_stem_mode(db, plan_id, payload.directory, payload.mode)
    return PlanRead.model_validate(plan)


# Override whether a suggestion is one bundle or a collection of bundles
@router.put("/plans/{plan_id}/proposals/{proposal_id}/kind", response_model=PlanRead)
def convert_proposal_kind(
    plan_id: str, proposal_id: str, payload: ProposalKindUpdate, db: LibrarySession
) -> PlanRead:
    """Turn a bundle suggestion into a collection of bundles, or back again.

    Returns the whole plan rather than the one proposal: a conversion adds or
    removes sibling rows, so the client's tree has changed shape.
    """
    plan = plan_store.convert_proposal_kind(db, plan_id, proposal_id, payload.kind)
    return PlanRead.model_validate(plan)


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
