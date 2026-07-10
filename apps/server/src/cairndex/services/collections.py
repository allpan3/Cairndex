"""Collection domain service: hierarchical virtual groupings (AGENTS.md §4.7).

A Collection (formerly "folder") groups bundles logically. Membership is
many-to-many and never moves files on disk — it is independent of the physical
File Browser, which browses the active library root directly.
"""

from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import MediaKind
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
    """All collections directly under ``parent_id`` (NULL = top level)."""
    return list(
        session.scalars(
            select(Collection).where(
                Collection.parent_id.is_(None)
                if parent_id is None
                else Collection.parent_id == parent_id
            )
        )
    )


def reorder_collections(
    session: Session, *, parent_id: str | None, ordered_ids: list[str]
) -> list[Collection]:
    """Set each collection's ``sort_order`` from its position in ``ordered_ids``.

    ``ordered_ids`` must be exactly the collections directly under ``parent_id``
    (a manual drag-reorder rewrites one sibling group at a time). Cross-parent or
    partial lists are rejected so the persisted order stays well-defined.
    """
    siblings = _siblings(session, parent_id)
    by_id = {c.id: c for c in siblings}
    if set(ordered_ids) != set(by_id):
        raise ValidationError("ordered ids must be exactly the collections under this parent")
    now = utcnow()
    for order, cid in enumerate(ordered_ids):
        collection = by_id[cid]
        if collection.sort_order != order:
            collection.sort_order = order
            collection.updated_at = now
    session.flush()
    return [by_id[cid] for cid in ordered_ids]


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
    now = utcnow()
    for siblings in groups.values():
        siblings.sort(key=lambda c: c.name.casefold(), reverse=descending)
        for order, collection in enumerate(siblings):
            if collection.sort_order != order:
                collection.sort_order = order
                collection.updated_at = now
    session.flush()


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
