"""Persist and load durable grouping plans (ADR-0009 phase 3).

Turns the suggester's in-memory :class:`GroupingPlan` into the durable
``grouping_plans`` / ``grouping_proposals`` / ``grouping_proposal_files`` rows
that the review UI reads and the apply service consumes. Generating a fresh plan
supersedes any earlier still-open plan so there is a single active plan.
"""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.ids import new_id
from cairndex.domain.enums import (
    DEFAULT_STEM_LEVEL,
    STEM_LEVEL_CEILING,
    GroupingPlanStatus,
    GroupingState,
    ProposalKind,
    context_directory,
)
from cairndex.grouping.service import suggest_for_session
from cairndex.grouping.suggester import (
    FileObservation,
    _addition_roles_in_order,
    _dirname,
    _media_first,
    _new_bundle_title,
    _roles_in_order,
    max_stem_level,
    split_for_collection,
)
from cairndex.grouping.suggester import (
    GroupingPlan as PlanData,
)
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    GroupingPlan,
    GroupingProposal,
    GroupingProposalFile,
)


def get_plan(session: Session, plan_id: str) -> GroupingPlan:
    """Load one plan with its proposals and their files already in hand.

    Both relationships load lazily by default, and the response carries the whole
    plan — so serializing it walked ``proposal.files`` one proposal at a time:
    one query per suggestion, thousands of round trips for a large library. Local
    SSD hid it at about 0.3 ms each; a NAS-mounted library pays network latency
    per round trip, which is where a conversion went from "a moment" to a stall
    (owner-reported, 2026-07-30). ``selectinload`` makes it three queries
    whatever the size.
    """
    plan = session.scalar(
        select(GroupingPlan)
        .where(GroupingPlan.id == plan_id)
        .options(selectinload(GroupingPlan.proposals).selectinload(GroupingProposal.files))
    )
    if plan is None:
        raise NotFoundError(f"grouping plan {plan_id!r} not found")
    return plan


def list_plans(session: Session) -> list[GroupingPlan]:
    return list(session.scalars(select(GroupingPlan).order_by(GroupingPlan.generated_at.desc())))


def proposal_counts(session: Session, plan_ids: list[str]) -> dict[str, int]:
    """How many proposals each of these plans holds, in one query.

    The plans list only needs the numbers; reading the rows to call ``len`` on
    them meant loading every proposal of every plan ever generated.
    """
    if not plan_ids:
        return {}
    rows = session.execute(
        select(GroupingProposal.plan_id, func.count())
        .where(GroupingProposal.plan_id.in_(plan_ids))
        .group_by(GroupingProposal.plan_id)
    )
    return {plan_id: count for plan_id, count in rows}


def _open_plan_row(session: Session, plan_id: str) -> GroupingPlan:
    """The plan row alone, with the open-for-editing boundary enforced.

    Deliberately not ``get_plan``: every mutation passes through here to read one
    column, and ``get_plan`` eagerly loads every proposal and every proposal file
    so that *serializing* a response is not N+1. Paying that to check ``status``
    meant each edit loaded the whole plan twice — about a third of a second per
    conversion on a 20,000-file library (owner-reported, 2026-08-13).
    """
    plan = session.get(GroupingPlan, plan_id)
    if plan is None:
        raise NotFoundError(f"grouping plan {plan_id!r} not found")
    if plan.status is not GroupingPlanStatus.OPEN:
        raise ConflictError("only an open grouping plan can be edited")
    return plan


# Resolve one editable proposal and enforce the open-plan boundary
def _open_proposal(session: Session, plan_id: str, proposal_id: str) -> GroupingProposal:
    """Load a proposal only when it belongs to the requested open plan."""
    plan = _open_plan_row(session, plan_id)
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
    if proposal.target_bundle_id is not None and not proposal.create_new_bundle:
        raise ValidationError("addition suggestion titles cannot be changed")
    if proposal.is_collection_context:
        raise ValidationError("existing collection context titles cannot be changed")

    normalized = title.strip()
    if not normalized:
        raise ValidationError("suggestion title cannot be empty")
    proposal.title = normalized
    proposal.owner_edited = True
    session.flush()
    return proposal


# Build observations for the current proposal-file order
def _proposal_observations(
    session: Session,
    proposal_files: list[GroupingProposalFile],
) -> list[FileObservation]:
    """Resolve stable proposal-file ids into current media observations.

    One query for the whole set rather than ``session.get`` per file: a folder of
    300 images made 300 round trips on every conversion, which local SSD hides and
    a NAS-mounted library does not. Order follows ``proposal_files``, which is the
    reviewed order and is what the callers depend on.
    """
    wanted = [proposal_file.asset_file_id for proposal_file in proposal_files]
    if not wanted:
        return []
    by_id = {
        asset_file.id: asset_file
        for asset_file in session.scalars(select(AssetFile).where(AssetFile.id.in_(wanted)))
    }
    return [
        FileObservation(
            asset_file_id=asset_file.id,
            relative_path=asset_file.relative_path,
            media_kind=asset_file.media_kind,
            bundle_id=asset_file.bundle_id,
        )
        for asset_file_id in wanted
        if (asset_file := by_id.get(asset_file_id)) is not None
    ]


# Rewrite dense sequence and derived roles after a proposal edit
def _write_proposal_files(
    session: Session,
    proposal: GroupingProposal,
    proposal_files: list[GroupingProposalFile],
) -> None:
    """Persist one proposal's exact ordered membership and derived roles."""
    observations = _proposal_observations(session, proposal_files)
    proposed = (
        _addition_roles_in_order(observations)
        if proposal.target_bundle_id is not None and not proposal.create_new_bundle
        else _roles_in_order(observations)
    )
    role_by_id = {item.asset_file_id: item.role for item in proposed}
    for sequence, proposal_file in enumerate(proposal_files):
        proposal_file.sequence = sequence
        proposal_file.proposed_role = role_by_id.get(
            proposal_file.asset_file_id, proposal_file.proposed_role
        )


# Persist the reversible existing-bundle versus new-bundle choice
def set_proposal_destination(
    session: Session,
    plan_id: str,
    proposal_id: str,
    create_new_bundle: bool,
) -> GroupingProposal:
    """Switch an addition candidate between its suggested target and a new bundle."""
    proposal = _open_proposal(session, plan_id, proposal_id)
    if proposal.kind is not ProposalKind.BUNDLE or proposal.target_bundle_id is None:
        raise ValidationError("only an existing-bundle suggestion has another destination")

    observations = _proposal_observations(session, list(proposal.files))
    if not observations:
        raise ValidationError("an empty bundle suggestion has no destination")

    # Old open plans stored the target title in title and gain the new fields on open
    if proposal.target_bundle_title is None:
        proposal.target_bundle_title = proposal.title
        proposal.title = _new_bundle_title(observations, proposal.directory)

    if not create_new_bundle:
        target = session.get(AssetBundle, proposal.target_bundle_id)
        if target is None or target.grouping_state is not GroupingState.CONFIRMED:
            raise ConflictError("the suggested existing bundle is no longer available")

    proposal.create_new_bundle = create_new_bundle
    proposal.owner_edited = True
    _write_proposal_files(session, proposal, list(proposal.files))
    session.flush()
    return proposal


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
    # The one edit that genuinely changes which files a proposal holds.
    source.membership_edited = True
    target.membership_edited = True
    session.flush()
    session.expire(source, ["files"])
    if target.id != source.id:
        session.expire(target, ["files"])
    return [source] if source.id == target.id else [source, target]


# Resolve the current persisted ancestor path for one collection destination
def _collection_path(session: Session, target_collection_id: str) -> list[Collection]:
    """Load a collection's current root-to-leaf path with cycle protection."""
    target = session.get(Collection, target_collection_id)
    if target is None:
        raise ValidationError("the selected collection no longer exists")

    path: list[Collection] = []
    seen: set[str] = set()
    current: Collection | None = target
    while current is not None:
        if current.id in seen:
            raise ValidationError("the selected collection hierarchy contains a cycle")
        seen.add(current.id)
        path.append(current)
        current = current.parent
    return list(reversed(path))


# Materialize only the persisted collection path an owner explicitly selected
def _materialize_collection_context(
    session: Session,
    plan: GroupingPlan,
    target_collection_id: str,
    forbidden_proposal_ids: set[str],
) -> GroupingProposal:
    """Represent a live collection path as stable read-only plan context."""
    by_target = {
        proposal.target_collection_id: proposal
        for proposal in plan.proposals
        if proposal.target_collection_id is not None
    }
    next_order = max((proposal.sort_order for proposal in plan.proposals), default=-1) + 1
    parent: GroupingProposal | None = None
    for collection in _collection_path(session, target_collection_id):
        context = by_target.get(collection.id)
        if context is not None and context.id in forbidden_proposal_ids:
            raise ValidationError("a collection suggestion cannot move inside itself")
        if context is None:
            context = GroupingProposal(
                plan=plan,
                kind=ProposalKind.CONTAINER,
                title=collection.name,
                directory=context_directory(collection.id),
                confidence=1.0,
                reason="existing collection",
                sort_order=next_order,
                target_collection_id=collection.id,
                is_collection_context=True,
            )
            next_order += 1
            session.add(context)
            session.flush()
            by_target[collection.id] = context
        else:
            # An explicit selection refreshes this structural snapshot from the
            # same current collection tree the picker displayed
            context.title = collection.name
            context.reason = "existing collection"
        context.parent_proposal_id = parent.id if parent is not None else None
        parent = context

    if parent is None:  # guarded by the target lookup above
        raise ValidationError("the selected collection no longer exists")
    return parent


# Remove context paths that no longer lead to any proposed work
def _prune_empty_collection_context(session: Session, plan: GroupingPlan) -> None:
    """Delete read-only context leaves made unused by a placement edit."""
    remaining = list(plan.proposals)
    while True:
        parent_ids = {
            proposal.parent_proposal_id
            for proposal in remaining
            if proposal.parent_proposal_id is not None
        }
        removable = [
            proposal
            for proposal in remaining
            if proposal.is_collection_context and proposal.id not in parent_ids
        ]
        if not removable:
            return
        removable_ids = {proposal.id for proposal in removable}
        for proposal in removable:
            session.delete(proposal)
        remaining = [proposal for proposal in remaining if proposal.id not in removable_ids]
        session.flush()


# Reparent proposed work without moving an existing collection context node
def reparent_proposal(
    session: Session,
    plan_id: str,
    proposal_id: str,
    parent_proposal_id: str | None,
    *,
    target_collection_id: str | None = None,
) -> None:
    """Move suggested work under a proposed or current persisted collection."""
    proposal = _open_proposal(session, plan_id, proposal_id)
    if proposal.is_collection_context:
        raise ValidationError("existing collection context cannot be moved")
    if _is_addition(proposal):
        # Its files join a bundle that already exists and already has whatever
        # collection membership it has; "placing" the addition only ever added
        # that confirmed bundle to a second collection. Switching the row to a
        # new bundle first makes placement meaningful, and legal.
        raise ValidationError("an addition suggestion has no placement of its own")
    if parent_proposal_id is not None and target_collection_id is not None:
        raise ValidationError("choose either a collection suggestion or an existing collection")

    descendants = _descendants(session, proposal)
    if target_collection_id is not None:
        parent = _materialize_collection_context(
            session,
            proposal.plan,
            target_collection_id,
            {descendant.id for descendant in descendants},
        )
        parent_proposal_id = parent.id
    elif parent_proposal_id is not None:
        parent = _open_proposal(session, plan_id, parent_proposal_id)
        if parent.kind is not ProposalKind.CONTAINER:
            raise ValidationError("suggestions can move only into collection suggestions")
        if parent.id == proposal.id or any(
            descendant.id == parent.id for descendant in descendants
        ):
            raise ValidationError("a collection suggestion cannot move inside itself")
    proposal.parent_proposal_id = parent_proposal_id
    proposal.owner_edited = True
    session.flush()
    _prune_empty_collection_context(session, proposal.plan)


def _descendants(session: Session, proposal: GroupingProposal) -> list[GroupingProposal]:
    """Every proposal below ``proposal``, deepest last (breadth-first order)."""
    # With their files: ``_container_to_bundle`` reads ``row.files`` for every
    # descendant, which was one query each. It only looked fast because
    # ``_open_proposal`` happened to have loaded the whole plan first.
    all_in_plan = list(
        session.scalars(
            select(GroupingProposal)
            .where(GroupingProposal.plan_id == proposal.plan_id)
            .options(selectinload(GroupingProposal.files))
        )
    )
    by_parent: dict[str | None, list[GroupingProposal]] = {}
    for row in all_in_plan:
        by_parent.setdefault(row.parent_proposal_id, []).append(row)

    found: list[GroupingProposal] = []
    frontier = [proposal.id]
    while frontier:
        children = [child for parent in frontier for child in by_parent.get(parent, [])]
        if not children:
            break
        found.extend(children)
        frontier = [child.id for child in children]
    return found


def _is_addition(proposal: GroupingProposal) -> bool:
    """Whether this proposal adds files to an already-confirmed bundle."""
    return proposal.target_bundle_id is not None and not proposal.create_new_bundle


def _bundle_to_container(session: Session, proposal: GroupingProposal) -> None:
    """Turn one bundle suggestion into a collection holding its files' bundles.

    The split is per *video subject* rather than per file, so cover art and
    subtitles follow their video instead of becoming bundles of their own — see
    ``split_for_collection`` for why the ordinary suggester grouping cannot be
    reused here.
    """
    observations = _proposal_observations(session, list(proposal.files))
    groups = split_for_collection(observations)
    # Bounded by whether the conversion would *change* anything, not by where the
    # row sits.
    #
    # The previous rule refused any single subject already inside a collection for
    # its own folder, to stop unbounded re-conversion (the child lands in the same
    # position, so it could be converted again forever). But that also refused the
    # case the owner actually wants: a folder holding one release today, which
    # should become a collection named for the folder with the release inside it
    # named by its own shared stem (owner-reported, 2026-08-13).
    #
    # The recursion is bounded just as tightly by asking whether the new layer
    # renames anything. A folder-named bundle converts to a folder-named
    # collection holding a stem-named bundle — a real change. Convert *that* and
    # the child's title equals its parent's, which adds nothing, and is refused.
    if len(groups) == 1:
        only = _media_first(groups[0])
        child_title = _new_bundle_title(only, proposal.directory)
        if child_title == (proposal.title or "").strip():
            raise ValidationError(
                "this suggestion holds one subject that already carries its own name, "
                "so a collection around it would add no structure"
            )

    children: list[GroupingProposal | GroupingProposalFile] = []
    for order, group in enumerate(groups):
        ordered = _media_first(group)
        # Id up front, so the child's files can be built without a flush to learn
        # it. See ``persist_plan`` for why that mattered.
        child = GroupingProposal(
            id=new_id(),
            plan_id=proposal.plan_id,
            kind=ProposalKind.BUNDLE,
            title=_new_bundle_title(ordered, proposal.directory),
            directory=proposal.directory,
            parent_proposal_id=proposal.id,
            confidence=proposal.confidence,
            # No reason text: the owner just performed the split themselves, so
            # a row explaining it is noise (owner-reported, 2026-07-29).
            reason=None,
            sort_order=order,
            owner_edited=True,
            # A split redistributes the parent's files across new rows.
            membership_edited=proposal.membership_edited,
        )
        children.append(child)
        # Indexed once per group rather than scanned per file, which was quadratic
        # in the size of the group being split.
        path_by_id = {o.asset_file_id: o.relative_path for o in ordered}
        children.extend(
            GroupingProposalFile(
                id=new_id(),
                proposal_id=child.id,
                asset_file_id=proposed.asset_file_id,
                relative_path=path_by_id[proposed.asset_file_id],
                proposed_role=proposed.role,
                sequence=proposed.sequence,
            )
            for proposed in _roles_in_order(ordered)
        )
    session.add_all(children)

    # A container carries no files of its own; its members are its children.
    for proposal_file in list(proposal.files):
        session.delete(proposal_file)
    session.expire(proposal, ["files"])
    proposal.kind = ProposalKind.CONTAINER
    proposal.reason = None


def _container_to_bundle(session: Session, proposal: GroupingProposal) -> None:
    """Collapse a collection suggestion and everything under it into one bundle."""
    descendants = _descendants(session, proposal)
    additions = [row for row in descendants if _is_addition(row)]
    if additions:
        raise ValidationError(
            "this collection contains a suggestion that adds files to an existing "
            "bundle, which cannot be merged into a new one"
        )

    # One resolve for every descendant's files together, not one per descendant:
    # a collection of 300 bundles made 300 round trips here.
    every_file = [proposal_file for row in descendants for proposal_file in row.files]
    observations: list[FileObservation] = []
    seen: set[str] = set()
    for observation in _proposal_observations(session, every_file):
        if observation.asset_file_id in seen:
            continue
        seen.add(observation.asset_file_id)
        observations.append(observation)

    # Delete deepest-first so no row is orphaned mid-way through.
    for row in reversed(descendants):
        session.delete(row)
    session.flush()

    ordered = _media_first(observations)
    path_by_id = {o.asset_file_id: o.relative_path for o in ordered}
    for proposed in _roles_in_order(ordered):
        session.add(
            GroupingProposalFile(
                proposal_id=proposal.id,
                asset_file_id=proposed.asset_file_id,
                relative_path=path_by_id[proposed.asset_file_id],
                proposed_role=proposed.role,
                sequence=proposed.sequence,
            )
        )
    session.expire(proposal, ["files"])
    proposal.kind = ProposalKind.BUNDLE
    proposal.reason = None


def convert_proposal_kind(
    session: Session, plan_id: str, proposal_id: str, kind: ProposalKind
) -> GroupingPlan:
    """Switch a suggestion between being one bundle and being a collection.

    The suggester decides from filenames alone whether a folder holds one thing
    or several, and it cannot know which the owner meant. This is the manual
    override in both directions, applied to the open plan in place — every other
    suggestion in the plan keeps its identity and any edits made to it.

    Returns the whole plan: a conversion adds or removes proposals, so the
    client's tree has changed shape rather than one row having changed.
    """
    proposal = _open_proposal(session, plan_id, proposal_id)
    if proposal.kind is kind:
        raise ValidationError(f"this suggestion is already a {kind.value}")
    if proposal.is_collection_context:
        raise ValidationError("existing collection context cannot change kind")
    if _is_addition(proposal):
        raise ValidationError(
            "a suggestion that adds files to an existing bundle cannot become a collection"
        )

    if kind is ProposalKind.CONTAINER:
        _bundle_to_container(session, proposal)
    else:
        _container_to_bundle(session, proposal)

    proposal.owner_edited = True
    session.flush()
    return get_plan(session, plan_id)


# --- per-directory stem levels ------------------------------------------------

# What the three values this column used to hold mean on the dial. ``wide`` has
# no fixed level: it meant "as wide as this folder goes", which is the folder's
# own maximum, so it resolves per directory.
_LEGACY_STEM_LEVELS: dict[str, int | None] = {
    "narrow": 0,
    "balanced": DEFAULT_STEM_LEVEL,
    "wide": None,
}


def _plan_filenames_by_directory(plan: GroupingPlan) -> dict[str, list[str]]:
    """Every file the plan holds, grouped by the folder it actually lives in.

    Keyed off each file's own path, deliberately not its proposal's
    ``directory``: the two agree for a suggested row but not after the owner
    restructures, and the stem dial belongs to a folder rather than to a row.
    """
    names: dict[str, list[str]] = {}
    for proposal in plan.proposals:
        for file in proposal.files:
            names.setdefault(_dirname(file.relative_path), []).append(file.relative_path)
    return names


def _stored_stem_levels(plan: GroupingPlan, maxima: dict[str, int]) -> dict[str, int]:
    """The plan's overrides as levels, translating anything a prior release wrote.

    The column held ``"narrow"``/``"balanced"``/``"wide"`` before the dial was
    continuous, and a plan open across the upgrade still carries them. An
    unrecognised value reads as the default rather than as level 0, so a stray
    string cannot silently split every folder it names.
    """
    levels: dict[str, int] = {}
    for directory, value in (plan.stem_level_overrides or {}).items():
        if isinstance(value, str):
            legacy = _LEGACY_STEM_LEVELS.get(value.strip().casefold(), DEFAULT_STEM_LEVEL)
            level = maxima.get(directory, DEFAULT_STEM_LEVEL) if legacy is None else legacy
        else:
            level = int(value)
        levels[directory] = max(0, min(level, STEM_LEVEL_CEILING))
    return levels


def stem_levels(plan: GroupingPlan) -> dict[str, dict[str, int]]:
    """Each folder the plan represents, its stem level, and the top of its dial.

    The maximum has to come from the server: it is the level at which every
    filename in *that folder* is down to its first segment, so the client cannot
    work it out without reimplementing the suggester's normalization.
    """
    maxima = {
        directory: max_stem_level(paths)
        for directory, paths in _plan_filenames_by_directory(plan).items()
    }
    stored = _stored_stem_levels(plan, maxima)
    return {
        directory: {
            "level": stored.get(directory, DEFAULT_STEM_LEVEL),
            # An override on a folder no row still holds files from keeps its own
            # level as the top of the dial, so the reported maximum is never
            # below the level actually in force.
            "max": max(
                maxima.get(directory, DEFAULT_STEM_LEVEL),
                stored.get(directory, DEFAULT_STEM_LEVEL),
            ),
        }
        for directory in sorted({*maxima, *stored})
    }


def set_directory_stem_level(
    session: Session, plan_id: str, directory: str, level: int
) -> GroupingPlan:
    """Re-suggest ONE directory inside the open plan, leaving everything else be.

    Narrow/Widen used to regenerate the whole plan, which superseded every
    proposal row — discarding the owner's other decisions (renames, destination
    switches, drag edits, bundle↔collection conversions, and the client's
    selection) to adjust one folder. Splicing just that directory makes their
    persistence structural: rows outside it are never touched, so there is
    nothing to carry forward or to get carry-forward wrong.

    The suggester still runs over the whole library (a directory's grouping is
    not computable in isolation), but only its output for ``directory`` is used.
    Within that directory the rows genuinely are new suggestions — including any
    conversion the owner had made *there*, which is the folder they just asked
    to redo. ``POST /plans`` (Suggest grouping) remains the full reset.

    Files the owner dragged out of this directory into surviving suggestions are
    not re-proposed: a fresh row claiming a file that another row still holds
    would put it in two bundles at apply time.
    """
    plan = get_plan(session, plan_id)
    if plan.status is not GroupingPlanStatus.OPEN:
        raise ConflictError("only an open grouping plan can be adjusted")

    maxima = {
        folder: max_stem_level(paths)
        for folder, paths in _plan_filenames_by_directory(plan).items()
    }
    levels = _stored_stem_levels(plan, maxima)
    # Clamped rather than refused. The top of the dial depends on the folder's own
    # filenames, so "one step wider" is a request the client makes against the
    # maximum it was last told; clamping lands on the end it meant.
    level = max(0, min(level, maxima.get(directory, DEFAULT_STEM_LEVEL)))
    if level == DEFAULT_STEM_LEVEL:
        levels.pop(directory, None)
    else:
        levels[directory] = level
    # Same bound as PlanGenerateRequest.stem_levels, enforced here too because
    # this path grows the stored map one directory at a time.
    if len(levels) > 500:
        raise ValidationError("too many per-directory stem overrides")

    data = suggest_for_session(session, stem_levels=levels)
    fresh = [p for p in data.proposals if p.directory == directory]

    existing = [p for p in plan.proposals if p.directory == directory]
    existing_ids = {p.id for p in existing}

    # A splice must never lose a file. Every file the replaced rows hold has to
    # end up somewhere: still claimed by a surviving row, or carried by one of
    # the fresh ones. Anything else would silently drop it out of the plan, and
    # an unproposed file is one the owner can no longer bundle from here.
    #
    # This is reachable whenever a row's ``directory`` is a folder the suggester
    # does not propose bundles for — which is exactly what a hand-merged
    # cross-directory bundle looks like: merging a collection whose bundles live
    # in subfolders leaves one row whose ``directory`` is the parent, while the
    # suggester still proposes only a container there. The client no longer
    # offers a stem control on such a row (see ``bundleDirectories`` in
    # GroupingReview.tsx); this refuses it rather than trusting that.
    survivor_files = {
        pf.asset_file_id for p in plan.proposals if p.id not in existing_ids for pf in p.files
    }
    fresh_files = {pf.asset_file_id for p in fresh for pf in p.files}
    dropped = {pf.asset_file_id for p in existing for pf in p.files} - survivor_files - fresh_files
    if dropped:
        raise ValidationError(
            f"adjusting stem matching for {directory or 'the library root'!r} would drop "
            f"{len(dropped)} file(s) from the plan; it applies to a folder's own media files, "
            "and this suggestion holds files from elsewhere"
        )
    # Where the folder sat in the review list, so the fresh rows take its place
    # rather than jumping to the bottom.
    insert_at = min(
        (p.sort_order for p in existing),
        default=max((p.sort_order for p in plan.proposals), default=-1) + 1,
    )
    # Children of a replaced container that live in *other* directories (e.g.
    # subdirectory bundles under this directory's container). The FK is SET
    # NULL, so without re-linking they would silently fall to the top level.
    orphaned_ids = [
        p.id
        for p in plan.proposals
        if p.parent_proposal_id in existing_ids and p.id not in existing_ids
    ]

    for row in existing:
        session.delete(row)
    session.flush()
    session.expire(plan, ["proposals"])

    survivors = list(plan.proposals)
    # One query for every surviving row's files. ``plan.proposals`` was just
    # expired, so it reloads without ``get_plan``'s eager option — and reading
    # ``p.files`` per row was then one lazy query per proposal: 3,600 of them on a
    # large plan, which is where ten of the thirteen seconds went.
    claimed = set(
        session.scalars(
            select(GroupingProposalFile.asset_file_id)
            .join(GroupingProposal, GroupingProposal.id == GroupingProposalFile.proposal_id)
            .where(GroupingProposal.plan_id == plan.id)
        )
    )
    container_by_dir = {p.directory: p.id for p in survivors if p.kind is ProposalKind.CONTAINER}

    path_by_id = _relative_paths(session)
    inserted_parents: list[tuple[GroupingProposal, str | None]] = []
    fresh_container_id: str | None = None
    for proposal in fresh:
        kept = [pf for pf in proposal.files if pf.asset_file_id not in claimed]
        if proposal.kind is ProposalKind.BUNDLE and not kept:
            continue  # every file here was dragged elsewhere by the owner
        row = GroupingProposal(
            id=new_id(),
            plan_id=plan.id,
            kind=proposal.kind,
            title=proposal.title or None,
            directory=proposal.directory,
            confidence=proposal.confidence,
            reason=proposal.reason or None,
            # All fresh rows share the folder's old position; the renumber below
            # spreads them out in this (suggester) order via the id tiebreak.
            sort_order=insert_at,
            target_bundle_id=proposal.target_bundle_id,
            target_bundle_title=proposal.target_bundle_title,
            create_new_bundle=proposal.create_new_bundle,
            base_bundle_id=proposal.base_bundle_id,
            target_collection_id=proposal.target_collection_id,
            is_collection_context=proposal.is_collection_context,
        )
        session.add(row)
        if len(kept) != len(proposal.files):
            # Roles were derived for the full file set; recompute for what is left
            # (e.g. the group's video was dragged away, leaving sidecars).
            observations = [
                FileObservation(
                    asset_file_id=af.id,
                    relative_path=af.relative_path,
                    media_kind=af.media_kind,
                    bundle_id=af.bundle_id,
                )
                for pf in kept
                if (af := session.get(AssetFile, pf.asset_file_id)) is not None
            ]
            proposed = (
                _addition_roles_in_order(observations)
                if _is_addition(row)
                else _roles_in_order(observations)
            )
        else:
            proposed = tuple(proposal.files)
        session.add_all(
            GroupingProposalFile(
                id=new_id(),
                proposal_id=row.id,
                asset_file_id=pf.asset_file_id,
                relative_path=path_by_id.get(pf.asset_file_id, ""),
                proposed_role=pf.role,
                sequence=sequence,
            )
            for sequence, pf in enumerate(proposed)
        )
        if proposal.kind is ProposalKind.CONTAINER:
            fresh_container_id = row.id
        inserted_parents.append((row, proposal.parent_directory))

    # One flush for every fresh row, where there used to be one per row. It has to
    # happen here rather than at the end: the parent links below — and the orphan
    # re-parenting after them — reference these rows by id, and the foreign key is
    # enforced immediately.
    session.flush()

    # Link fresh rows to their parents: the directory's own fresh container, or
    # a surviving container for an ancestor directory.
    lookup = dict(container_by_dir)
    if fresh_container_id is not None:
        lookup[directory] = fresh_container_id
    for row, parent_dir in inserted_parents:
        row.parent_proposal_id = lookup.get(parent_dir) if parent_dir is not None else None

    # Children of the replaced container follow it to its successor (or the top
    # level if the directory no longer warrants one).
    for orphan_id in orphaned_ids:
        orphan = session.get(GroupingProposal, orphan_id)
        if orphan is not None:
            orphan.parent_proposal_id = fresh_container_id

    # A fresh container whose bundles were all claimed away holds nothing —
    # drop it rather than showing an empty collection suggestion.
    if fresh_container_id is not None:
        has_children = bool(orphaned_ids) or any(
            row.parent_proposal_id == fresh_container_id
            for row, _ in inserted_parents
            if row.id != fresh_container_id
        )
        if not has_children:
            childless = session.get(GroupingProposal, fresh_container_id)
            if childless is not None:
                session.delete(childless)

    session.flush()
    session.expire(plan, ["proposals"])
    # Re-suggesting a directory replaces its rows, which can leave an existing
    # collection context path leading nowhere. Those nodes are read-only with a
    # permanently disabled checkbox, so nothing in the UI could clear them.
    _prune_empty_collection_context(session, plan)
    session.expire(plan, ["proposals"])
    # Deterministic order: survivors keep their unique sort_orders; the fresh
    # rows share insert_at and fall back to id order, which is creation (and
    # therefore suggester) order because ids are ULIDs.
    for position, row in enumerate(sorted(plan.proposals, key=lambda p: (p.sort_order, p.id))):
        row.sort_order = position
    plan.stem_level_overrides = dict(levels)
    session.flush()
    session.expire(plan, ["proposals"])
    return plan


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

    plan = GroupingPlan(
        scan_job_id=scan_job_id,
        rule_version=data.rule_version,
        stem_level_overrides=dict(data.stem_levels),
    )
    session.add(plan)
    session.flush()

    path_by_id = _relative_paths(session)
    container_proposal_by_dir: dict[str, str] = {}
    rows: list[tuple[GroupingProposal, str | None]] = []
    pending: list[GroupingProposal | GroupingProposalFile] = []
    loaded: list[tuple[GroupingProposal, list[GroupingProposalFile]]] = []

    for order, proposal in enumerate(data.proposals):
        # The id is assigned here rather than left to the flush that would
        # otherwise have to happen inside this loop just to learn it. Ids are
        # ULIDs from a plain Python callable, so they are known before the insert
        # and still ascend in creation order (which the stem splice's sort
        # tiebreak relies on). Flushing per proposal meant one INSERT round trip
        # per row: 10,400 statements and about two and a half seconds of the four
        # a 3,600-suggestion plan took to appear (owner-reported, 2026-08-13).
        # With every primary key known up front, SQLAlchemy batches the inserts.
        row = GroupingProposal(
            id=new_id(),
            plan_id=plan.id,
            kind=proposal.kind,
            title=proposal.title or None,
            directory=proposal.directory,
            confidence=proposal.confidence,
            reason=proposal.reason,
            sort_order=order,
            target_bundle_id=proposal.target_bundle_id,
            target_bundle_title=proposal.target_bundle_title,
            create_new_bundle=proposal.create_new_bundle,
            base_bundle_id=proposal.base_bundle_id,
            target_collection_id=proposal.target_collection_id,
            is_collection_context=proposal.is_collection_context,
        )
        # Through the relationship rather than by ``proposal_id``, so the
        # collection counts as loaded. Setting the foreign key alone left
        # ``row.files`` unloaded, and serializing the response then fetched each
        # row's files in its own SELECT — 3,600 of them, the largest single cost
        # of generating a plan (owner-reported, 2026-08-13).
        files = [
            GroupingProposalFile(
                id=new_id(),
                proposal_id=row.id,
                asset_file_id=pf.asset_file_id,
                relative_path=path_by_id.get(pf.asset_file_id, ""),
                proposed_role=pf.role,
                sequence=pf.sequence,
            )
            for pf in proposal.files
        ]
        pending.append(row)
        pending.extend(files)
        loaded.append((row, files))
        if proposal.kind is ProposalKind.CONTAINER:
            container_proposal_by_dir[proposal.directory] = row.id
        rows.append((row, proposal.parent_directory))

    # Parent links before the insert, not after: the ids are already known, so
    # this no longer needs a round of UPDATEs following the INSERTs.
    for row, parent_directory in rows:
        if parent_directory is not None:
            row.parent_proposal_id = container_proposal_by_dir.get(parent_directory)

    session.add_all(pending)
    session.flush()
    # Prime each row's ``files`` as already-loaded, *after* the flush: turning a
    # pending instance persistent resets that bookkeeping, so doing it earlier has
    # no effect. Without this, serializing the response fetched every row's files
    # back in its own SELECT — 3,600 of them, the single largest cost of
    # generating a plan (owner-reported, 2026-08-13). Assigning the relationship
    # instead of the foreign key is not enough either: an *empty* collection stays
    # unloaded, so every container still paid a query.
    for row, files in loaded:
        set_committed_value(row, "files", files)
    set_committed_value(plan, "proposals", [row for row, _ in loaded])
    return plan


def generate_plan(
    session: Session,
    *,
    scan_job_id: str | None = None,
    stem_levels: dict[str, int] | None = None,
) -> GroupingPlan:
    """Persist grouping suggestions without reopening confirmed bundles."""
    data = suggest_for_session(session, stem_levels=stem_levels)
    return persist_plan(session, data, scan_job_id=scan_job_id)


def _relative_paths(session: Session) -> dict[str, str]:
    return {
        file_id: rel
        for file_id, rel in session.execute(select(AssetFile.id, AssetFile.relative_path)).all()
    }
