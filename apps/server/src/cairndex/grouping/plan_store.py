"""Persist and load durable grouping plans (ADR-0009 phase 3).

Turns the suggester's in-memory :class:`GroupingPlan` into the durable
``grouping_plans`` / ``grouping_proposals`` / ``grouping_proposal_files`` rows
that the review UI reads and the apply service consumes. Generating a fresh plan
supersedes any earlier still-open plan so there is a single active plan.
"""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.domain.enums import GroupingPlanStatus, ProposalKind
from cairndex.grouping.service import gather_observations
from cairndex.grouping.suggester import GroupingPlan as PlanData
from cairndex.grouping.suggester import suggest_grouping
from cairndex.persistence.models import (
    AssetFile,
    GroupingPlan,
    GroupingProposal,
    GroupingProposalFile,
)


def get_plan(session: Session, plan_id: str) -> GroupingPlan:
    plan = session.get(GroupingPlan, plan_id)
    if plan is None:
        raise NotFoundError(f"grouping plan {plan_id!r} not found")
    return plan


def list_plans(session: Session) -> list[GroupingPlan]:
    return list(session.scalars(select(GroupingPlan).order_by(GroupingPlan.generated_at.desc())))


def supersede_open_plans(session: Session) -> None:
    """Mark every still-open plan superseded (a newer plan takes over)."""
    session.execute(
        update(GroupingPlan)
        .where(GroupingPlan.status == GroupingPlanStatus.OPEN)
        .values(status=GroupingPlanStatus.SUPERSEDED)
    )


def persist_plan(
    session: Session, data: PlanData, *, scan_job_id: str | None = None
) -> GroupingPlan:
    """Store a suggester plan as durable rows, superseding prior open plans.

    Parent links are resolved by directory: each CONTAINER proposal owns its
    directory, and a child's ``parent_directory`` points at the enclosing
    container, so it maps cleanly to a ``parent_proposal_id``.
    """
    supersede_open_plans(session)

    plan = GroupingPlan(scan_job_id=scan_job_id, rule_version=data.rule_version)
    session.add(plan)
    session.flush()

    path_by_id = _relative_paths(session)
    container_proposal_by_dir: dict[str, str] = {}
    rows: list[tuple[GroupingProposal, str | None]] = []

    for order, proposal in enumerate(data.proposals):
        row = GroupingProposal(
            plan_id=plan.id,
            kind=proposal.kind,
            title=proposal.title or None,
            directory=proposal.directory,
            confidence=proposal.confidence,
            reason=proposal.reason,
            sort_order=order,
            target_bundle_id=proposal.target_bundle_id,
        )
        session.add(row)
        session.flush()
        for pf in proposal.files:
            session.add(
                GroupingProposalFile(
                    proposal_id=row.id,
                    asset_file_id=pf.asset_file_id,
                    relative_path=path_by_id.get(pf.asset_file_id, ""),
                    proposed_role=pf.role,
                    sequence=pf.sequence,
                )
            )
        if proposal.kind is ProposalKind.CONTAINER:
            container_proposal_by_dir[proposal.directory] = row.id
        rows.append((row, proposal.parent_directory))

    # Second pass: link children to their container proposal now that all ids
    # exist.
    for row, parent_directory in rows:
        if parent_directory is not None:
            row.parent_proposal_id = container_proposal_by_dir.get(parent_directory)

    session.flush()
    return plan


def generate_plan(session: Session, *, scan_job_id: str | None = None) -> GroupingPlan:
    """Suggest a grouping for the current library and persist it (read→write)."""
    data = suggest_grouping(gather_observations(session))
    return persist_plan(session, data, scan_job_id=scan_job_id)


def _relative_paths(session: Session) -> dict[str, str]:
    return {
        file_id: rel
        for file_id, rel in session.execute(select(AssetFile.id, AssetFile.relative_path)).all()
    }
