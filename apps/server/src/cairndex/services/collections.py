"""Collection domain service: hierarchical virtual groupings (AGENTS.md §4.7).

A Collection (formerly "folder") groups bundles logically. Membership is
many-to-many and never moves files on disk — it is independent of the physical
File Browser, which browses the active library root directly.
"""

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import GroupingState, MediaKind
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    asset_bundle_collections,
)
from cairndex.services.hierarchy import descendant_ids, is_descendant
from cairndex.services.pagination import keyset_page


def get_collection(session: Session, collection_id: str) -> Collection:
    collection = session.get(Collection, collection_id)
    if collection is None:
        raise NotFoundError(f"collection {collection_id!r} not found")
    return collection


def _require_parent(session: Session, parent_id: str | None) -> None:
    if parent_id is not None and session.get(Collection, parent_id) is None:
        raise ValidationError(f"parent collection {parent_id!r} does not exist")


def create_collection(session: Session, *, name: str, parent_id: str | None = None) -> Collection:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _require_parent(session, parent_id)

    # Append after existing siblings in the manual order (drag-reorder / Clean up
    # by… rewrite this later). NULL parent groups the top-level collections.
    next_order = (
        session.scalar(
            select(func.coalesce(func.max(Collection.sort_order), -1)).where(
                Collection.parent_id.is_(None)
                if parent_id is None
                else Collection.parent_id == parent_id
            )
        )
        or 0
    ) + 1
    collection = Collection(name=name, parent_id=parent_id, sort_order=next_order)
    session.add(collection)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"a sibling collection named {name!r} already exists under this parent"
        ) from exc
    return collection


def list_collections(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[Collection], str | None]:
    return keyset_page(session, select(Collection), Collection.id, limit, cursor)


def _siblings(session: Session, parent_id: str | None) -> list[Collection]:
    """All collections directly under ``parent_id`` (NULL = top level), in the
    manual order the UI renders them in — sort_order, name as the tie-break.
    Resolving a move against this list requires it to *be* the current order."""
    return list(
        session.scalars(
            select(Collection)
            .where(
                Collection.parent_id.is_(None)
                if parent_id is None
                else Collection.parent_id == parent_id
            )
            .order_by(Collection.sort_order, Collection.name)
        )
    )


def reorder_collections(
    session: Session, *, parent_id: str | None, moved_ids: list[str], before_id: str | None
) -> list[Collection]:
    """Move collections into ``parent_id``'s group, landing before ``before_id``.

    One operation for the whole gesture: whatever is not already in that group is
    reparented into it, then the block is placed — immediately before
    ``before_id``, or at the end when it is None. Dragging a collection to a
    different level and positioning it there is a single thing the owner did, and
    it used to be two requests: a reparent, then a placement. Between them the
    collection was published in its new group still carrying its old position, so
    a client refetch landing in that window latched onto the wrong order — a
    nested collection dropped at the bottom of the tree appeared back up near its
    old parent.

    Tolerant by design. Ids that no longer exist, or whose move would put a
    collection inside itself or its own descendant, are skipped rather than
    failing the drag: the client's picture of the tree can always have drifted,
    and the meaningful part of a move the owner made should still happen.
    """
    _require_parent(session, parent_id)
    now = utcnow()
    for collection_id in moved_ids:
        collection = session.get(Collection, collection_id)
        if collection is None or collection.parent_id == parent_id:
            continue
        if collection_id == parent_id:
            continue
        if parent_id is not None and is_descendant(
            session, Collection, candidate_id=parent_id, of_id=collection_id
        ):
            continue
        # A reparent *is* a change to the collection, unlike a pure reorder — its
        # place in the tree is part of what it is, so the modified time moves.
        collection.parent_id = parent_id
        collection.updated_at = now
    session.flush()

    siblings = _siblings(session, parent_id)
    by_id = {c.id: c for c in siblings}
    order = [c.id for c in siblings]
    moving = [cid for cid in order if cid in set(moved_ids)]
    if not moving or before_id in set(moving):
        return [by_id[cid] for cid in order]
    rest = [cid for cid in order if cid not in set(moving)]
    at = rest.index(before_id) if before_id in rest else len(rest)
    result = rest[:at] + moving + rest[at:]
    _write_sibling_order(session, by_id, result)
    return [by_id[cid] for cid in result]


def _write_sibling_order(session: Session, by_id: dict[str, Collection], result: list[str]) -> None:
    """Persist ``result`` as the group's ``sort_order``, touching only rows whose
    position changed — and *not* their ``updated_at``. Rearranging collections is
    not editing them: the modified time answers "when did this collection's own
    content change", and bumping it here also invalidated every sibling's cover
    thumbnail (the cache key is ``updated_at``) on each drag. The column carries
    an ``onupdate`` default, so changed rows are written with an explicit UPDATE
    that passes the current value through (a column present in the statement is
    not filled by the default)."""
    for position, cid in enumerate(result):
        collection = by_id[cid]
        if collection.sort_order == position:
            continue
        session.execute(
            update(Collection)
            .where(Collection.id == cid)
            .values(sort_order=position, updated_at=Collection.updated_at)
        )
        # The core UPDATE bypasses the identity-mapped instance; reload it so
        # callers (and the API response built from these rows) see the new order.
        session.expire(collection, ["sort_order", "updated_at"])
    session.flush()


def cleanup_collection_order(session: Session, *, descending: bool = False) -> None:
    """Rewrite every sibling group's ``sort_order`` to alphabetical name order.

    The one meaningful automatic order for collections (there is no per-collection
    metadata like rating/size to sort by). Applies to every parent scope so the
    whole tree is tidied in one pass, matching how the UI shows all levels.
    """
    all_collections = list(session.scalars(select(Collection)))
    groups: dict[str | None, list[Collection]] = {}
    for c in all_collections:
        groups.setdefault(c.parent_id, []).append(c)
    for siblings in groups.values():
        siblings.sort(key=lambda c: c.name.casefold(), reverse=descending)
        _write_sibling_order(session, {c.id: c for c in siblings}, [c.id for c in siblings])


def update_collection(
    session: Session,
    collection_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    set_parent: bool = False,
    note: str | None = None,
    set_note: bool = False,
    cover_bundle_id: str | None = None,
    set_cover: bool = False,
    expected_version: int | None = None,
) -> Collection:
    collection = get_collection(session, collection_id)
    guard_and_bump_version(collection, expected_version)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        collection.name = cleaned

    if set_note:
        # Empty/whitespace-only note clears it.
        trimmed = (note or "").strip()
        collection.note = trimmed or None

    if set_cover:
        if cover_bundle_id is not None and session.get(AssetBundle, cover_bundle_id) is None:
            raise ValidationError(f"bundle {cover_bundle_id!r} does not exist")
        collection.cover_bundle_id = cover_bundle_id

    if set_parent:
        if parent_id == collection_id:
            raise ValidationError("a collection cannot be its own parent")
        if parent_id is not None:
            _require_parent(session, parent_id)
            if is_descendant(session, Collection, candidate_id=parent_id, of_id=collection_id):
                raise ValidationError("cannot move a collection under its own descendant")
        collection.parent_id = parent_id

    collection.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a sibling collection with that name already exists") from exc
    return collection


def delete_collection(session: Session, collection_id: str, *, cascade: bool = False) -> None:
    """Delete a collection (metadata only).

    With ``cascade`` the collection *and* all its descendant subcollections are
    removed; otherwise the direct children float to the library root
    (DB SET NULL). Either way bundle memberships drop via DB cascade — no bundle
    or file on disk is ever deleted."""
    collection = get_collection(session, collection_id)
    if cascade:
        # Bulk-delete the whole subtree; the DB SET NULL between deleted rows is
        # moot and asset_bundle_collections cascades remove the memberships.
        ids = descendant_ids(session, Collection, collection_id, include_self=True)
        session.execute(delete(Collection).where(Collection.id.in_(ids)))
    else:
        session.delete(collection)
    session.flush()


def collection_descendant_ids(
    session: Session, collection_id: str, *, include_self: bool = True
) -> list[str]:
    get_collection(session, collection_id)
    return descendant_ids(session, Collection, collection_id, include_self=include_self)


@dataclass(frozen=True)
class CollectionStats:
    direct_bundles: int
    total_bundles: int
    subcollections: int


def collection_stats(session: Session, collection_id: str) -> CollectionStats:
    """Counts for the collection inspector: bundles directly in this collection,
    distinct bundles across the whole subtree, and direct child subcollections."""
    get_collection(session, collection_id)  # 404 if missing
    direct = (
        session.scalar(
            select(func.count())
            .select_from(asset_bundle_collections)
            .where(asset_bundle_collections.c.collection_id == collection_id)
        )
        or 0
    )
    subtree = descendant_ids(session, Collection, collection_id, include_self=True)
    total = (
        session.scalar(
            select(func.count(func.distinct(asset_bundle_collections.c.bundle_id))).where(
                asset_bundle_collections.c.collection_id.in_(subtree)
            )
        )
        or 0
    )
    subcollections = (
        session.scalar(
            select(func.count())
            .select_from(Collection)
            .where(Collection.parent_id == collection_id)
        )
        or 0
    )
    return CollectionStats(
        direct_bundles=int(direct), total_bundles=int(total), subcollections=int(subcollections)
    )


_THUMBNAILABLE_KINDS = (MediaKind.IMAGE, MediaKind.VIDEO)


def resolve_cover_bundle_id(session: Session, collection_id: str) -> str | None:
    """The bundle to derive this collection's cover from: the explicitly chosen
    ``cover_bundle_id`` when it still exists, otherwise the earliest bundle
    anywhere in the subtree that has a thumbnailable (image/video) file. None if
    the collection has no such bundle."""
    collection = get_collection(session, collection_id)
    if collection.cover_bundle_id and session.get(AssetBundle, collection.cover_bundle_id):
        return collection.cover_bundle_id
    subtree = descendant_ids(session, Collection, collection_id, include_self=True)
    stmt = (
        select(AssetBundle.id)
        .join(asset_bundle_collections, asset_bundle_collections.c.bundle_id == AssetBundle.id)
        .join(AssetFile, AssetFile.bundle_id == AssetBundle.id)
        .where(asset_bundle_collections.c.collection_id.in_(subtree))
        .where(AssetFile.media_kind.in_(_THUMBNAILABLE_KINDS))
        .order_by(AssetBundle.created_at)
        .limit(1)
    )
    return session.scalar(stmt)


def _with_ancestors(session: Session, collection_ids: set[str]) -> set[str]:
    """``collection_ids`` plus every ancestor — an auto cover resolves through
    the whole subtree, so a change below reaches each collection above it."""
    reached = set(collection_ids)
    frontier = set(collection_ids)
    while frontier:
        parents = {
            parent_id
            for parent_id in session.scalars(
                select(Collection.parent_id).where(Collection.id.in_(frontier))
            )
            if parent_id is not None
        }
        frontier = parents - reached
        reached.update(parents)
    return reached


def touch_cover_collections_for_bundle(session: Session, bundle_id: str) -> None:
    """Refresh collection cover versions when their effective bundle changes image.

    Candidate collections are direct memberships, their ancestors (whose auto
    cover can resolve through that subtree), and explicit selectors of this
    bundle. This changes display freshness only; optimistic-concurrency versions
    stay put.
    """
    direct = set(
        session.scalars(
            select(asset_bundle_collections.c.collection_id).where(
                asset_bundle_collections.c.bundle_id == bundle_id
            )
        )
    )
    candidates = _with_ancestors(session, direct) | set(
        session.scalars(select(Collection.id).where(Collection.cover_bundle_id == bundle_id))
    )

    now = utcnow()
    for collection_id in candidates:
        if resolve_cover_bundle_id(session, collection_id) == bundle_id:
            collection = session.get(Collection, collection_id)
            if collection is not None:
                collection.updated_at = now
    session.flush()


def touch_membership_collections(session: Session, collection_ids: Iterable[str]) -> None:
    """Mark collections whose membership just changed, and their ancestors.

    A collection's cover thumbnail is fetched with its ``updated_at`` as the
    cache-busting key, and its auto-picked cover is *derived from membership* —
    the earliest bundle in the subtree with a thumbnailable file. So filing a
    bundle in, or taking one out, can change the picture without anything
    touching the collection row, and the browser goes on serving what it
    already has. That is what left collection covers stale, and what left a
    collection that had just received its first bundle still showing the folder
    glyph it 404'd into (owner, 2026-07-30).

    Unlike ``touch_cover_collections_for_bundle`` this cannot ask "does the
    cover still resolve to *this* bundle": on a removal the answer is a
    different bundle, or none, which is precisely the case that needs
    refreshing. It marks every affected collection instead. The cost is one
    re-fetch of a tile that may be unchanged; the alternative is a tile that is
    wrong until something unrelated moves it.

    Membership is also the collection's own content, so bumping ``updated_at``
    here is what the column means — unlike a sibling reorder, which deliberately
    leaves it alone (see ``_write_sibling_order``).
    """
    affected = {collection_id for collection_id in collection_ids}
    if not affected:
        return
    now = utcnow()
    for collection_id in _with_ancestors(session, affected):
        collection = session.get(Collection, collection_id)
        if collection is not None:
            collection.updated_at = now
    session.flush()


def bundle_ids_under_directory(session: Session, directory: str) -> list[str]:
    """Confirmed bundles holding at least one file in ``directory`` or beneath it.

    The membership a collection made from a folder starts with. Ordered by the
    bundle's own rowid so the result is stable, and deduplicated: a bundle with
    several files in the folder joins once.

    Provisional (unbundled) bundles are excluded deliberately. They are
    scan-staged guesses the owner has not confirmed, and the browse layer already
    hides them from every collection — filing them here would add rows that
    cannot be seen.

    The subtree test is a half-open range on the indexed ``directory_path``, not
    a ``LIKE`` prefix: SQLite cannot use an index for ``LIKE`` under its default
    case-insensitive rules. ``"/"`` is 0x2F, so ``"0"`` is the next byte and
    bounds the subtree exactly — every descendant starts with ``dir + "/"``, and
    nothing else falls in the range (a sibling ``Set1-old`` sorts below it,
    ``Set1x`` above).
    """
    directory = directory.strip("/")
    if not directory:
        # The library root encloses everything, so "the bundles under it" is the
        # whole library. That is never what this action means, and the File
        # Browser only offers it on a real folder row.
        raise ValidationError("choose a folder inside the library")
    within = or_(
        AssetFile.directory_path == directory,
        and_(
            AssetFile.directory_path >= f"{directory}/",
            AssetFile.directory_path < f"{directory}0",
        ),
    )
    rows = session.execute(
        select(AssetBundle.id)
        .join(AssetFile, AssetFile.bundle_id == AssetBundle.id)
        .where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
        .where(within)
        .group_by(AssetBundle.id)
        .order_by(func.min(AssetFile.id))
    ).all()
    return [row[0] for row in rows]
