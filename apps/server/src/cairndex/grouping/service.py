"""Read-only DB adapter for the grouping suggester (ADR-0009 phase 2).

Reads the current library content and produces a :class:`GroupingPlan`. It only
*reads* — persisting and applying a plan is the conflict-aware phase-3 step.
Files already in a confirmed bundle are flagged so the pure suggester excludes
them (confirmed user decisions win over heuristics).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, GroupingState, ProposalKind, StemMode
from cairndex.grouping.suggester import (
    FileObservation,
    GroupingPlan,
    GroupingProposal,
    suggest_grouping,
)
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    asset_bundle_collections,
)
from cairndex.scanning.media_types import is_hidden_relative_path


@dataclass(frozen=True)
class _CollectionContext:
    """One existing collection plus its owner-visible hierarchy path."""

    collection: Collection
    path: tuple[str, ...]


def gather_observations(session: Session) -> list[FileObservation]:
    """Snapshot available linked files while treating confirmed bundles as settled."""
    rows = session.execute(
        select(
            AssetFile.id,
            AssetFile.relative_path,
            AssetFile.media_kind,
            AssetBundle.id,
            AssetBundle.grouping_state,
            AssetBundle.title,
        )
        .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
        .where(AssetFile.availability == FileAvailability.AVAILABLE)
    ).all()
    return [
        FileObservation(
            asset_file_id=file_id,
            relative_path=relative_path,
            media_kind=media_kind,
            grouping_confirmed=grouping_state is GroupingState.CONFIRMED,
            bundle_id=bundle_id,
            bundle_title=title,
        )
        for file_id, relative_path, media_kind, bundle_id, grouping_state, title in rows
        if not is_hidden_relative_path(relative_path)
    ]


# Resolve a collection's stable name path while tolerating corrupt cycles
def _collection_path(collection: Collection, by_id: dict[str, Collection]) -> tuple[str, ...]:
    """Return root-to-leaf collection names for matching and proposal reuse."""
    names: list[str] = []
    seen: set[str] = set()
    current: Collection | None = collection
    while current is not None and current.id not in seen:
        names.append(current.name)
        seen.add(current.id)
        current = by_id.get(current.parent_id) if current.parent_id is not None else None
    return tuple(reversed(names))


# Index the existing logical collection tree for review-plan context
def _collection_contexts(session: Session) -> dict[str, _CollectionContext]:
    """Load existing collections once and derive their hierarchical paths."""
    collections = list(session.scalars(select(Collection)))
    by_id = {collection.id: collection for collection in collections}
    return {
        collection.id: _CollectionContext(collection, _collection_path(collection, by_id))
        for collection in collections
    }


# Derive owner-visible title paths for collection proposals already in the plan
def _proposed_collection_paths(
    proposals: tuple[GroupingProposal, ...],
) -> dict[tuple[str, ...], str]:
    """Map collection title paths to their existing proposal directory keys."""
    by_directory = {
        proposal.directory: proposal
        for proposal in proposals
        if proposal.kind is ProposalKind.CONTAINER
    }
    cache: dict[str, tuple[str, ...]] = {}

    # Resolve a proposal's title path through its proposed parent chain
    def path_for(proposal: GroupingProposal) -> tuple[str, ...]:
        if proposal.directory in cache:
            return cache[proposal.directory]
        parent = by_directory.get(proposal.parent_directory or "")
        path = (*path_for(parent), proposal.title) if parent is not None else (proposal.title,)
        cache[proposal.directory] = path
        return path

    return {path_for(proposal): proposal.directory for proposal in by_directory.values()}


# Check whether a logical collection path matches the proposal's filesystem location
def _matches_directory(context: _CollectionContext, directory: str) -> bool:
    """Treat an existing collection hierarchy as relevant to the same path prefix."""
    parts = tuple(part for part in directory.split("/") if part)
    names = tuple(part.casefold() for part in context.path)
    prefix = tuple(part.casefold() for part in parts[: len(context.path)])
    return len(context.path) <= len(parts) and names == prefix


# Choose one relevant existing collection for a top-level bundle proposal
def _proposal_collection(
    proposal: GroupingProposal,
    contexts: dict[str, _CollectionContext],
    memberships: dict[str, list[str]],
) -> _CollectionContext | None:
    """Prefer the target bundle's membership, then a matching directory hierarchy."""
    direct = [
        contexts[collection_id]
        for collection_id in memberships.get(proposal.target_bundle_id or "", [])
        if collection_id in contexts
    ]
    candidates = direct or [
        context for context in contexts.values() if _matches_directory(context, proposal.directory)
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda context: (
            -(len(context.path) if _matches_directory(context, proposal.directory) else -1),
            -len(context.path),
            context.collection.sort_order,
            context.collection.name.casefold(),
            context.collection.id,
        ),
    )


# Add only the existing collection branches needed by current bundle suggestions
def _with_collection_context(session: Session, plan: GroupingPlan) -> GroupingPlan:
    """Nest top-level bundle proposals under relevant reusable collection nodes."""
    contexts = _collection_contexts(session)
    if not contexts:
        return plan

    memberships: dict[str, list[str]] = defaultdict(list)
    target_ids = {
        proposal.target_bundle_id
        for proposal in plan.proposals
        if proposal.target_bundle_id is not None
    }
    if target_ids:
        for bundle_id, collection_id in session.execute(
            select(
                asset_bundle_collections.c.bundle_id,
                asset_bundle_collections.c.collection_id,
            ).where(asset_bundle_collections.c.bundle_id.in_(target_ids))
        ):
            memberships[bundle_id].append(collection_id)

    chosen: dict[int, _CollectionContext] = {}
    needed_ids: set[str] = set()
    for index, proposal in enumerate(plan.proposals):
        if proposal.kind is not ProposalKind.BUNDLE or proposal.parent_directory is not None:
            continue
        context = _proposal_collection(proposal, contexts, memberships)
        if context is None:
            continue
        chosen[index] = context
        current: Collection | None = context.collection
        while current is not None and current.id not in needed_ids:
            needed_ids.add(current.id)
            parent = contexts.get(current.parent_id or "")
            current = parent.collection if parent is not None else None

    if not chosen:
        return plan

    proposed_paths = _proposed_collection_paths(plan.proposals)
    key_by_id: dict[str, str] = {}
    additions: list[GroupingProposal] = []
    ordered = sorted(
        (contexts[collection_id] for collection_id in needed_ids),
        key=lambda context: (len(context.path), context.collection.sort_order, context.path),
    )
    for context in ordered:
        collection = context.collection
        key = proposed_paths.get(context.path, f"@existing-collection/{collection.id}")
        key_by_id[collection.id] = key
        if context.path in proposed_paths:
            continue
        additions.append(
            GroupingProposal(
                kind=ProposalKind.CONTAINER,
                directory=key,
                parent_directory=key_by_id.get(collection.parent_id or ""),
                title=collection.name,
                confidence=1.0,
                reason="existing collection",
            )
        )

    updated = tuple(
        replace(proposal, parent_directory=key_by_id[chosen[index].collection.id])
        if index in chosen
        else proposal
        for index, proposal in enumerate(plan.proposals)
    )
    return GroupingPlan(plan.rule_version, (*additions, *updated), plan.stem_modes)


def suggest_for_session(
    session: Session, *, stem_modes: dict[str, StemMode] | None = None
) -> GroupingPlan:
    """Build a grouping plan with relevant existing collections as review context."""
    return _with_collection_context(
        session,
        suggest_grouping(gather_observations(session), stem_modes),
    )
