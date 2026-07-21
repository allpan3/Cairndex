"""Apply a grouping plan (ADR-0009 phase 3).

Applying a plan is the only step that creates *confirmed* grouping decisions: it
merges/splits provisional bundles (preserving ``AssetFile.id`` so moved-file
repair, subtitles, thumbnails, and notes stay stable), assigns roles, selects
cover/primary, links external subtitles, and creates the logical collections a
CONTAINER suggests. It never touches the filesystem.

It is **idempotent** (re-applying a settled plan is a clean no-op) and
**conflict-aware**: a proposal whose files have vanished or been manually
regrouped is reported as a localized conflict and skipped, rather than discarding
the whole plan or silently overriding a confirmed user decision.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingPlanStatus,
    GroupingState,
    ProposalKind,
)
from cairndex.grouping.membership import reap_source_bundles
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    GroupingPlan,
    GroupingProposal,
)
from cairndex.services.subtitles import auto_link_external_subtitles


@dataclass(frozen=True)
class ProposalConflict:
    proposal_id: str
    title: str | None
    reason: str


@dataclass
class ApplyResult:
    bundles_confirmed: int = 0
    bundles_removed: int = 0
    collections_created: int = 0
    bundles_added_to_collections: int = 0
    files_added_to_bundles: int = 0
    subtitles_linked: int = 0
    conflicts: list[ProposalConflict] = field(default_factory=list)


@dataclass
class _BundleOutcome:
    target_bundle_id: str | None


def apply_plan(
    session: Session, plan: GroupingPlan, *, proposal_ids: set[str] | None = None
) -> ApplyResult:
    """Apply ``plan`` to the library, confirming bundles and creating containers.

    Safe to call more than once; an already-applied proposal becomes a no-op. When
    ``proposal_ids`` is set, only that selected subset is accepted.
    """
    if plan.status is GroupingPlanStatus.CANCELLED:
        raise ConflictError("cannot apply a cancelled grouping plan")

    result = ApplyResult()
    all_proposals = list(plan.proposals)
    if proposal_ids is not None:
        if not proposal_ids:
            raise ConflictError("select at least one grouping proposal to accept")
        known_ids = {p.id for p in all_proposals}
        unknown_ids = proposal_ids - known_ids
        if unknown_ids:
            raise ConflictError("one or more selected grouping proposals no longer exist")
    proposals = [p for p in all_proposals if proposal_ids is None or p.id in proposal_ids]
    target_bundle_by_proposal: dict[str, str] = {}
    source_bundles: set[AssetBundle] = set()

    # 1) Bundles first, so containers can reference the resulting bundles.
    for proposal in proposals:
        if proposal.kind is not ProposalKind.BUNDLE:
            continue
        if proposal.target_bundle_id is not None and not proposal.create_new_bundle:
            outcome = _apply_addition(session, proposal, result, source_bundles)
        else:
            outcome = _apply_bundle(session, plan, proposal, result, source_bundles)
        if outcome.target_bundle_id is not None:
            target_bundle_by_proposal[proposal.id] = outcome.target_bundle_id
    _cleanup_sources(session, source_bundles, result)

    # 2) Containers, parent-first (shallower directories first), creating the
    #    logical collections and nesting child collections under parents.
    collection_by_proposal: dict[str, str] = {}
    containers = [p for p in proposals if p.kind is ProposalKind.CONTAINER]
    for proposal in sorted(containers, key=lambda p: p.directory.count("/")):
        parent_collection_id = (
            collection_by_proposal.get(proposal.parent_proposal_id)
            if proposal.parent_proposal_id is not None
            else None
        )
        collection, created = _ensure_collection(session, proposal, parent_collection_id)
        collection_by_proposal[proposal.id] = collection.id
        if created:
            result.collections_created += 1

    # 3) Wire bundle membership: each bundle joins its container's collection.
    for proposal in proposals:
        if proposal.kind is not ProposalKind.BUNDLE or proposal.parent_proposal_id is None:
            continue
        collection_id = collection_by_proposal.get(proposal.parent_proposal_id)
        bundle_id = target_bundle_by_proposal.get(proposal.id)
        if collection_id is None or bundle_id is None:
            continue
        if _add_bundle_to_collection(session, bundle_id, collection_id):
            result.bundles_added_to_collections += 1

    plan.status = GroupingPlanStatus.APPLIED
    plan.applied_at = utcnow()
    session.flush()
    return result


def _apply_bundle(
    session: Session,
    plan: GroupingPlan,
    proposal: GroupingProposal,
    result: ApplyResult,
    source_bundles: set[AssetBundle],
) -> _BundleOutcome:
    file_ids = [pf.asset_file_id for pf in proposal.files]
    rows = {fid: session.get(AssetFile, fid) for fid in file_ids}
    present = [
        row
        for row in rows.values()
        if row is not None and row.availability is FileAvailability.AVAILABLE
    ]
    missing = [
        file_id
        for file_id, row in rows.items()
        if row is None or row.availability is FileAvailability.MISSING
    ]

    if missing:
        result.conflicts.append(
            _conflict(
                proposal, f"{len(missing)} file(s) referenced by this proposal no longer exist"
            )
        )
    if not present:
        return _BundleOutcome(None)
    if proposal.owner_edited:
        return _apply_owner_edited_bundle(session, plan, proposal, present, result, source_bundles)

    provisional = [r for r in present if r.bundle.grouping_state is GroupingState.PROVISIONAL]
    confirmed = [r for r in present if r.bundle.grouping_state is GroupingState.CONFIRMED]

    if confirmed:
        confirmed_bundle_ids = {r.bundle_id for r in confirmed}
        already_applied = (
            not provisional
            and len(confirmed_bundle_ids) == 1
            and _bundle_holds_exactly(
                session, next(iter(confirmed_bundle_ids)), {r.id for r in present}
            )
        )
        if already_applied:
            # Idempotent: this proposal is already realized as a confirmed bundle.
            return _BundleOutcome(next(iter(confirmed_bundle_ids)))
        result.conflicts.append(
            _conflict(proposal, "some files were already grouped into a confirmed bundle")
        )
        return _BundleOutcome(None)

    if not provisional:
        return _BundleOutcome(None)

    target = provisional[0].bundle
    source_bundles.update(r.bundle for r in provisional if r.bundle_id != target.id)
    role_by_id = {pf.asset_file_id: pf.proposed_role for pf in proposal.files}
    seq_by_id = {pf.asset_file_id: pf.sequence for pf in proposal.files}

    for row in provisional:
        row.bundle = target
        row.bundle_id = target.id
        row.role = role_by_id.get(row.id, row.role)
        row.sequence = seq_by_id.get(row.id, row.sequence)

    target.title = proposal.title or target.title
    target.grouping_state = GroupingState.CONFIRMED
    target.confirmed_at = utcnow()
    target.grouping_rule_version = plan.rule_version
    cover = next((r for r in provisional if r.role is FileRole.COVER), None)
    target.cover_file_id = cover.id if cover is not None else target.cover_file_id
    result.bundles_confirmed += 1

    session.flush()
    result.subtitles_linked += len(auto_link_external_subtitles(session, target.id))
    return _BundleOutcome(target.id)


# Apply an owner-edited proposal even when it changes confirmed membership
def _apply_owner_edited_bundle(
    session: Session,
    plan: GroupingPlan,
    proposal: GroupingProposal,
    present: list[AssetFile],
    result: ApplyResult,
    source_bundles: set[AssetBundle],
) -> _BundleOutcome:
    """Apply an explicit review edit while preserving its original bundle id."""
    if proposal.base_bundle_id is not None:
        target = session.get(AssetBundle, proposal.base_bundle_id)
        if target is None:
            result.conflicts.append(_conflict(proposal, "the edited bundle no longer exists"))
            return _BundleOutcome(None)
    else:
        target = present[0].bundle

    planned_ids = {row.id for row in present}
    remaining_target_files = [row for row in target.files if row.id not in planned_ids]
    source_bundles.update(row.bundle for row in present if row.bundle_id != target.id)
    role_by_id = {pf.asset_file_id: pf.proposed_role for pf in proposal.files}
    seq_by_id = {pf.asset_file_id: pf.sequence for pf in proposal.files}
    was_provisional = target.grouping_state is GroupingState.PROVISIONAL

    for row in present:
        row.bundle = target
        row.bundle_id = target.id
        row.role = role_by_id.get(row.id, row.role)
        row.sequence = seq_by_id.get(row.id, row.sequence)
    for offset, row in enumerate(remaining_target_files, start=len(proposal.files)):
        row.sequence = offset

    target.title = proposal.title or target.title
    target.grouping_state = GroupingState.CONFIRMED
    target.confirmed_at = utcnow()
    target.grouping_rule_version = plan.rule_version
    cover = next((row for row in present if row.role is FileRole.COVER), None)
    if cover is not None:
        target.cover_file_id = cover.id
    if was_provisional:
        result.bundles_confirmed += 1

    session.flush()
    result.subtitles_linked += len(auto_link_external_subtitles(session, target.id))
    return _BundleOutcome(target.id)


# Apply an addition and return its existing bundle for collection wiring
def _apply_addition(
    session: Session,
    proposal: GroupingProposal,
    result: ApplyResult,
    source_bundles: set[AssetBundle],
) -> _BundleOutcome:
    """Fold newly discovered files into an existing confirmed bundle (ADR-0009
    phase 5) without disturbing the confirmed grouping. Idempotent and
    conflict-aware unless the owner explicitly moved a reviewed file here."""
    target = session.get(AssetBundle, proposal.target_bundle_id)
    if target is None or target.grouping_state is not GroupingState.CONFIRMED:
        result.conflicts.append(
            _conflict(proposal, "the bundle these files would join no longer exists")
        )
        return _BundleOutcome(None)

    role_by_id = {pf.asset_file_id: pf.proposed_role for pf in proposal.files}
    base_sequence = max((row.sequence for row in target.files), default=-1) + 1
    moved = 0
    for offset, pf in enumerate(proposal.files):
        row = session.get(AssetFile, pf.asset_file_id)
        if row is None:
            result.conflicts.append(_conflict(proposal, "a file to add no longer exists"))
            continue
        if row.bundle_id == target.id:
            continue  # already added (idempotent)
        if row.bundle.grouping_state is GroupingState.CONFIRMED and not proposal.owner_edited:
            result.conflicts.append(
                _conflict(
                    proposal, "a file to add was already grouped into another confirmed bundle"
                )
            )
            continue
        source_bundles.add(row.bundle)
        row.bundle = target
        row.bundle_id = target.id
        row.role = role_by_id.get(row.id, row.role)
        row.sequence = base_sequence + offset
        moved += 1

    if moved == 0:
        return _BundleOutcome(target.id)
    result.files_added_to_bundles += moved
    session.flush()
    result.subtitles_linked += len(auto_link_external_subtitles(session, target.id))
    return _BundleOutcome(target.id)


def _cleanup_sources(
    session: Session, source_bundles: set[AssetBundle], result: ApplyResult
) -> None:
    """Remove bundles emptied by reviewed moves and repair dangling covers."""
    result.bundles_removed += reap_source_bundles(session, source_bundles)


def _bundle_holds_exactly(session: Session, bundle_id: str, file_ids: set[str]) -> bool:
    current = set(
        session.scalars(select(AssetFile.id).where(AssetFile.bundle_id == bundle_id)).all()
    )
    return current == file_ids


def _ensure_collection(
    session: Session, proposal: GroupingProposal, parent_collection_id: str | None
) -> tuple[Collection, bool]:
    name = (proposal.title or proposal.directory.rsplit("/", 1)[-1] or "Untitled").strip()
    existing = session.scalar(
        select(Collection).where(
            Collection.name == name, Collection.parent_id == parent_collection_id
        )
    )
    if existing is not None:
        return existing, False
    collection = Collection(name=name, parent_id=parent_collection_id)
    session.add(collection)
    session.flush()
    return collection, True


def _add_bundle_to_collection(session: Session, bundle_id: str, collection_id: str) -> bool:
    bundle = session.get(AssetBundle, bundle_id)
    collection = session.get(Collection, collection_id)
    if bundle is None or collection is None:
        return False
    if any(c.id == collection_id for c in bundle.collections):
        return False
    bundle.collections.append(collection)
    return True


def _conflict(proposal: GroupingProposal, reason: str) -> ProposalConflict:
    title = (
        proposal.target_bundle_title
        if proposal.target_bundle_id is not None and not proposal.create_new_bundle
        else proposal.title
    )
    return ProposalConflict(proposal_id=proposal.id, title=title, reason=reason)
