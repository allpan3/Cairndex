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

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, DomainError
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    CONTEXT_DIRECTORY_PREFIX,
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
from cairndex.services import directory_members
from cairndex.services.subtitles import auto_link_external_subtitles

logger = logging.getLogger(__name__)


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
    # Directories realized as single folder rows on the bundles that applied.
    folders_collapsed: int = 0
    # Suggestions still awaiting review once the accepted ones have left. Zero means
    # the plan is finished and closed; anything else means it is still open and the
    # client can carry on in it without regenerating (see ``apply_plan``).
    proposals_remaining: int = 0


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
    selected_bundles = [
        proposal
        for proposal in all_proposals
        if proposal.kind is ProposalKind.BUNDLE
        and (proposal_ids is None or proposal.id in proposal_ids)
    ]
    if not selected_bundles:
        raise ConflictError("select at least one bundle suggestion to accept")

    ancestors_by_bundle = _container_ancestors(all_proposals, selected_bundles)
    structural_containers = _unique_containers(ancestors_by_bundle.values())
    invalid_containers = _invalid_collection_targets(
        session, all_proposals, structural_containers, result
    )
    # A bundle under a stale existing-collection path is skipped, but the conflict
    # above names the *container*. Report the skip against the row the owner
    # actually selected too, or the result panel says "0 confirmed" with nothing
    # attached to anything they checked.
    bundles: list[GroupingProposal] = []
    for proposal in selected_bundles:
        blocked = any(
            ancestor.id in invalid_containers for ancestor in ancestors_by_bundle[proposal.id]
        )
        if blocked:
            result.conflicts.append(
                _conflict(proposal, "its collection destination is no longer valid")
            )
        else:
            bundles.append(proposal)
    target_bundle_by_proposal: dict[str, str] = {}
    source_bundles: set[AssetBundle] = set()

    # 1) Bundles first, so containers can reference the resulting bundles.
    for proposal in bundles:
        if proposal.target_bundle_id is not None and not proposal.create_new_bundle:
            outcome = _apply_addition(session, proposal, result, source_bundles)
        else:
            outcome = _apply_bundle(session, plan, proposal, result, source_bundles)
        if outcome.target_bundle_id is not None:
            target_bundle_by_proposal[proposal.id] = outcome.target_bundle_id
            result.folders_collapsed += _apply_folder_members(
                session, proposal, outcome.target_bundle_id
            )
    _cleanup_sources(session, source_bundles, result)

    # 2) Resolve only the structural ancestors of bundles that actually applied
    applied_bundles = [proposal for proposal in bundles if proposal.id in target_bundle_by_proposal]
    applied_ancestors = _container_ancestors(all_proposals, applied_bundles)
    containers = _unique_containers(applied_ancestors.values())
    collection_by_proposal: dict[str, str] = {}
    for proposal in _parent_first(containers):
        if (
            proposal.parent_proposal_id is not None
            and proposal.parent_proposal_id not in collection_by_proposal
        ):
            result.conflicts.append(
                _conflict(proposal, "the parent collection could not be resolved")
            )
            continue
        parent_collection_id = collection_by_proposal.get(proposal.parent_proposal_id or "")
        collection, created, reason = _ensure_collection(session, proposal, parent_collection_id)
        if collection is None:
            result.conflicts.append(
                _conflict(proposal, reason or "collection could not be resolved")
            )
            continue
        collection_by_proposal[proposal.id] = collection.id
        if created:
            result.collections_created += 1

    # 3) Wire bundle membership: each bundle joins its container's collection.
    for proposal in applied_bundles:
        if proposal.parent_proposal_id is None:
            continue
        collection_id = collection_by_proposal.get(proposal.parent_proposal_id)
        bundle_id = target_bundle_by_proposal.get(proposal.id)
        if collection_id is None or bundle_id is None:
            continue
        if _add_bundle_to_collection(session, bundle_id, collection_id):
            result.bundles_added_to_collections += 1

    # Accepting a *selection* is a batch inside a review that carries on, so it
    # retires the rows it confirmed and leaves the rest exactly where they were, ids
    # and all; the plan closes only once nothing is left. Applying the whole plan
    # finishes the review, and keeps its long-settled behaviour unchanged: the rows
    # stay, so a retried request is still the documented no-op.
    #
    # It used to close on any partial success, which forced the client to throw the
    # plan away and generate a fresh one to carry on: two sequential round trips
    # per accept (942 ms + 851 ms on the owner's library, measured 2026-08-15), a
    # whole new set of proposal ids, and with them the loss of every collapsed
    # folder, since fold state is keyed on those ids. Reviewing in batches is the
    # documented workflow (owner-requested, 2026-08-13), so the plan has to survive
    # a batch.
    #
    # Still only a plan that *confirmed* something retires anything: a plan whose
    # every selected bundle was blocked (a stale collection path, a vanished file)
    # keeps all of it, or the owner would lose renames and placements to a failure.
    accepted_a_selection = proposal_ids is not None
    if target_bundle_by_proposal and accepted_a_selection:
        _retire_applied_proposals(session, plan, set(target_bundle_by_proposal))
        session.flush()
        session.expire(plan, ["proposals"])
    result.proposals_remaining = (
        sum(1 for p in plan.proposals if p.files) if accepted_a_selection else 0
    )
    if target_bundle_by_proposal and result.proposals_remaining == 0:
        plan.status = GroupingPlanStatus.APPLIED
        plan.applied_at = utcnow()
    session.flush()
    return result


def _retire_applied_proposals(session: Session, plan: GroupingPlan, applied_ids: set[str]) -> None:
    """Delete the proposals just confirmed, and any collection left holding nothing.

    A collection suggestion exists to hold the bundles beneath it; once they have
    all been accepted it describes nothing, and leaving it behind would show the
    owner an empty folder row they cannot act on. Deleted deepest-first so a
    container emptied by its children going is itself seen as empty.
    """
    by_parent: dict[str | None, list[GroupingProposal]] = {}
    for proposal in plan.proposals:
        by_parent.setdefault(proposal.parent_proposal_id, []).append(proposal)

    doomed = set(applied_ids)

    def survives(proposal: GroupingProposal) -> bool:
        """True if this row still has something to review under or in it."""
        if proposal.id in doomed:
            return False
        if proposal.kind is not ProposalKind.CONTAINER:
            return True
        children = by_parent.get(proposal.id, [])
        return any(survives(child) for child in children)

    for proposal in plan.proposals:
        if proposal.kind is ProposalKind.CONTAINER and not survives(proposal):
            doomed.add(proposal.id)
    for proposal in list(plan.proposals):
        if proposal.id in doomed:
            session.delete(proposal)


# Resolve every structural collection ancestor of the selected bundle work
def _container_ancestors(
    all_proposals: list[GroupingProposal], bundles: list[GroupingProposal]
) -> dict[str, list[GroupingProposal]]:
    """Return each bundle's root-to-leaf collection proposal path."""
    by_id = {proposal.id: proposal for proposal in all_proposals}
    result: dict[str, list[GroupingProposal]] = {}
    for bundle in bundles:
        path: list[GroupingProposal] = []
        seen: set[str] = set()
        parent_id = bundle.parent_proposal_id
        while parent_id is not None:
            if parent_id in seen:
                raise ConflictError("grouping proposal collection hierarchy contains a cycle")
            seen.add(parent_id)
            parent = by_id.get(parent_id)
            if parent is None or parent.kind is not ProposalKind.CONTAINER:
                raise ConflictError("grouping proposal has an invalid collection parent")
            path.append(parent)
            parent_id = parent.parent_proposal_id
        result[bundle.id] = list(reversed(path))
    return result


# Collapse per-bundle paths to one stable set of needed collection proposals
def _unique_containers(
    paths: Iterable[list[GroupingProposal]],
) -> list[GroupingProposal]:
    """Deduplicate collection paths without losing plan order."""
    unique: dict[str, GroupingProposal] = {}
    for path in paths:
        for proposal in path:
            unique.setdefault(proposal.id, proposal)
    return list(unique.values())


# Sort edited collection hierarchies by proposal ancestry rather than file paths
def _parent_first(containers: list[GroupingProposal]) -> list[GroupingProposal]:
    """Order collection proposals so every included parent resolves first."""
    by_id = {proposal.id: proposal for proposal in containers}
    depths: dict[str, int] = {}

    def depth(proposal: GroupingProposal, visiting: set[str]) -> int:
        if proposal.id in depths:
            return depths[proposal.id]
        if proposal.id in visiting:
            raise ConflictError("grouping proposal collection hierarchy contains a cycle")
        parent = by_id.get(proposal.parent_proposal_id or "")
        value = 0 if parent is None else depth(parent, {*visiting, proposal.id}) + 1
        depths[proposal.id] = value
        return value

    return sorted(
        containers,
        key=lambda proposal: (depth(proposal, set()), proposal.sort_order, proposal.id),
    )


# Read a stable collection target, including the marker used by legacy open plans
def _target_collection_id(proposal: GroupingProposal) -> str | None:
    if proposal.target_collection_id is not None:
        return proposal.target_collection_id
    prefix = CONTEXT_DIRECTORY_PREFIX
    return proposal.directory[len(prefix) :] if proposal.directory.startswith(prefix) else None


# Fail stale existing-collection paths before confirming their selected bundles
def _invalid_collection_targets(
    session: Session,
    all_proposals: list[GroupingProposal],
    containers: list[GroupingProposal],
    result: ApplyResult,
) -> set[str]:
    """Validate stable existing collection identities without creating anything."""
    by_id = {proposal.id: proposal for proposal in all_proposals}
    invalid: set[str] = set()
    for proposal in _parent_first(containers):
        target_id = _target_collection_id(proposal)
        if target_id is None:
            continue
        parent = by_id.get(proposal.parent_proposal_id or "")
        expected_parent_id = _target_collection_id(parent) if parent is not None else None
        target = session.get(Collection, target_id)
        if target is None:
            reason = "the existing collection no longer exists"
        elif parent is not None and expected_parent_id is None:
            reason = "an existing collection cannot be nested under a new collection suggestion"
        elif target.parent_id != expected_parent_id:
            reason = "the existing collection hierarchy changed after this plan was generated"
        else:
            continue
        invalid.add(proposal.id)
        result.conflicts.append(_conflict(proposal, reason))
    return invalid


def _apply_folder_members(session: Session, proposal: GroupingProposal, bundle_id: str) -> int:
    """Realize the folder rows this proposal proposed, on the bundle it became.

    Deliberately best-effort per directory. A folder member is a *drawing*
    decision — the files are members of the bundle either way — so a directory
    that can no longer be collapsed (claimed by another bundle since the plan was
    written, or nesting with one that is) must not fail the grouping the owner
    accepted. It simply enumerates, which is the state the bundle would have had
    without the proposal.
    """
    collapsed = 0
    for row in proposal.directories:
        # Declined in the dialog: its files were listed individually there, and
        # they land in the bundle the same way — just drawn one per row.
        if row.expanded:
            continue
        try:
            directory_members.collapse_directory(session, bundle_id, row.directory_path)
        except DomainError:
            logger.info(
                "proposal %s: could not collapse a directory into bundle %s",
                proposal.id,
                bundle_id,
            )
            continue
        collapsed += 1
    return collapsed


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
    # Counted apart from ``moved`` so "nothing left to do" can be told from
    # "nothing could be done" — see the return below.
    already_present = 0
    for offset, pf in enumerate(proposal.files):
        row = session.get(AssetFile, pf.asset_file_id)
        if row is None:
            result.conflicts.append(_conflict(proposal, "a file to add no longer exists"))
            continue
        if row.bundle_id == target.id:
            already_present += 1
            continue  # already added (idempotent)
        # ``membership_edited``, not ``owner_edited``: taking a file out of a
        # confirmed bundle is licensed only by the owner explicitly moving it here.
        # ``owner_edited`` is also set by renaming a suggestion and, before this,
        # by choosing where it is filed — so one click in the placement picker
        # silently disarmed this guard, against ADR-0009 §5's promise that a
        # confirmed bundle is never silently re-split or merged.
        if row.bundle.grouping_state is GroupingState.CONFIRMED and not proposal.membership_edited:
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
        # Re-applying a settled addition is a clean no-op and must still report the
        # target, or step 2 would drop its collection ancestors. An addition where
        # *every* file conflicted applied nothing, so it must not: reporting a
        # target there created the proposal's collections for work that never
        # happened, and filed the untouched confirmed bundle into them.
        return _BundleOutcome(target.id if already_present else None)
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
) -> tuple[Collection | None, bool, str | None]:
    target_id = _target_collection_id(proposal)
    if target_id is not None:
        target = session.get(Collection, target_id)
        if target is None:
            return None, False, "the existing collection no longer exists"
        if target.parent_id != parent_collection_id:
            return (
                None,
                False,
                "the existing collection hierarchy changed after this plan was generated",
            )
        return target, False, None

    name = (proposal.title or proposal.directory.rsplit("/", 1)[-1] or "Untitled").strip()
    existing = session.scalar(
        select(Collection).where(
            Collection.name == name, Collection.parent_id == parent_collection_id
        )
    )
    if existing is not None:
        return existing, False, None
    collection = Collection(name=name, parent_id=parent_collection_id)
    session.add(collection)
    session.flush()
    return collection, True, None


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
