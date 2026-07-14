"""Persist and load durable grouping plans (ADR-0009 phase 3).

Turns the suggester's in-memory :class:`GroupingPlan` into the durable
``grouping_plans`` / ``grouping_proposals`` / ``grouping_proposal_files`` rows
that the review UI reads and the apply service consumes. Generating a fresh plan
supersedes any earlier still-open plan so there is a single active plan.
"""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.domain.enums import GroupingPlanStatus, ProposalKind
from cairndex.grouping.service import gather_observations
from cairndex.grouping.suggester import (
    FileObservation,
    _addition_roles_in_order,
    _roles_in_order,
    suggest_grouping,
)
from cairndex.grouping.suggester import (
    GroupingPlan as PlanData,
)
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


# Resolve one editable proposal and enforce the open-plan boundary
def _open_proposal(session: Session, plan_id: str, proposal_id: str) -> GroupingProposal:
    """Load a proposal only when it belongs to the requested open plan."""
    plan = get_plan(session, plan_id)
    if plan.status is not GroupingPlanStatus.OPEN:
        raise ConflictError("only an open grouping plan can be edited")

    proposal = session.get(GroupingProposal, proposal_id)
    if proposal is None or proposal.plan_id != plan.id:
        raise NotFoundError(f"grouping proposal {proposal_id!r} not found")
    return proposal


# Persist an edited title for a bundle or collection suggestion
def rename_proposal(
    session: Session, plan_id: str, proposal_id: str, title: str
) -> GroupingProposal:
    """Rename a bundle or collection suggestion before apply."""
    proposal = _open_proposal(session, plan_id, proposal_id)
    if proposal.target_bundle_id is not None:
        raise ValidationError("addition suggestion titles cannot be changed")

    normalized = title.strip()
    if not normalized:
        raise ValidationError("suggestion title cannot be empty")
    proposal.title = normalized
    proposal.owner_edited = True
    session.flush()
    return proposal


# Rewrite dense sequence and derived roles after a proposal file move
def _write_proposal_files(
    session: Session,
    proposal: GroupingProposal,
    proposal_files: list[GroupingProposalFile],
) -> None:
    """Persist one proposal's exact ordered membership and derived roles."""
    observations: list[FileObservation] = []
    for proposal_file in proposal_files:
        asset_file = session.get(AssetFile, proposal_file.asset_file_id)
        if asset_file is None:
            continue
        observations.append(
            FileObservation(
                asset_file_id=asset_file.id,
                relative_path=asset_file.relative_path,
                media_kind=asset_file.media_kind,
                bundle_id=asset_file.bundle_id,
            )
        )
    proposed = (
        _addition_roles_in_order(observations)
        if proposal.target_bundle_id is not None
        else _roles_in_order(observations)
    )
    role_by_id = {item.asset_file_id: item.role for item in proposed}
    for sequence, proposal_file in enumerate(proposal_files):
        proposal_file.sequence = sequence
        proposal_file.proposed_role = role_by_id.get(
            proposal_file.asset_file_id, proposal_file.proposed_role
        )


# Move one stable file id within or across bundle proposals
def move_proposal_file(
    session: Session,
    plan_id: str,
    source_proposal_id: str,
    asset_file_id: str,
    target_proposal_id: str,
    target_index: int,
) -> list[GroupingProposal]:
    """Move a proposal file to an exact insertion point before apply."""
    source = _open_proposal(session, plan_id, source_proposal_id)
    target = _open_proposal(session, plan_id, target_proposal_id)
    if source.kind is not ProposalKind.BUNDLE or target.kind is not ProposalKind.BUNDLE:
        raise ValidationError("proposal files can move only between bundle suggestions")

    source_files = list(source.files)
    source_index = next(
        (index for index, item in enumerate(source_files) if item.asset_file_id == asset_file_id),
        None,
    )
    if source_index is None:
        raise NotFoundError(f"proposal file {asset_file_id!r} not found")
    target_files = source_files if source.id == target.id else list(target.files)
    if target_index < 0 or target_index > len(target_files):
        raise ValidationError("target index is outside the target bundle suggestion")
    if source.id != target.id and any(item.asset_file_id == asset_file_id for item in target_files):
        raise ValidationError("target bundle suggestion already contains this file")

    moving = source_files.pop(source_index)
    if source.id == target.id:
        insertion_index = target_index - (1 if source_index < target_index else 0)
        source_files.insert(insertion_index, moving)
        _write_proposal_files(session, source, source_files)
    else:
        target_files.insert(target_index, moving)
        moving.proposal_id = target.id
        _write_proposal_files(session, source, source_files)
        _write_proposal_files(session, target, target_files)

    source.owner_edited = True
    target.owner_edited = True
    session.flush()
    session.expire(source, ["files"])
    if target.id != source.id:
        session.expire(target, ["files"])
    return [source] if source.id == target.id else [source, target]


# Reparent a bundle proposal into a collection proposal or back to top level
def reparent_bundle_proposal(
    session: Session,
    plan_id: str,
    proposal_id: str,
    parent_proposal_id: str | None,
) -> GroupingProposal:
    """Set a bundle suggestion's proposed collection parent before apply."""
    proposal = _open_proposal(session, plan_id, proposal_id)
    if proposal.kind is not ProposalKind.BUNDLE:
        raise ValidationError("only bundle suggestions can move into collections")
    if parent_proposal_id is not None:
        parent = _open_proposal(session, plan_id, parent_proposal_id)
        if parent.kind is not ProposalKind.CONTAINER:
            raise ValidationError("bundle suggestions can move only into collection suggestions")
    proposal.parent_proposal_id = parent_proposal_id
    proposal.owner_edited = True
    session.flush()
    return proposal


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
            base_bundle_id=proposal.base_bundle_id,
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
    """Persist grouping suggestions without reopening confirmed bundles."""
    data = suggest_grouping(gather_observations(session))
    return persist_plan(session, data, scan_job_id=scan_job_id)


def _relative_paths(session: Session) -> dict[str, str]:
    return {
        file_id: rel
        for file_id, rel in session.execute(select(AssetFile.id, AssetFile.relative_path)).all()
    }
