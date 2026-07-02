"""Bundle browsing: enriched summaries, system views, sorting, and counts.

Powers the desktop library browser. Returns card-ready ``BundleSummary`` rows
(cover/primary-derived dimensions, duration, size, file count, missing state)
with server-side filtering by system view or collection, sorting with a stable
tie-breaker, and offset pagination + a total for virtualization. Counts feed
the sidebar.

Offset pagination is used (not keyset) because the browser needs a total and
arbitrary sort orders; at the low-thousands scale of a personal library this is
fine and far simpler. Revisit with keyset if profiling demands it.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import Select, exists, false, func, not_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from cairndex.domain.enums import (
    FileAvailability,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    Tag,
    asset_bundle_collections,
    asset_bundle_tags,
)
from cairndex.search import search_predicate, to_match_query
from cairndex.services.collections import collection_descendant_ids
from cairndex.services.hierarchy import descendant_ids


class SystemView(StrEnum):
    ALL = "all"
    RECENT = "recent"  # all, default-sorted by date added
    UNCATEGORIZED = "uncategorized"  # in no collection
    UNTAGGED = "untagged"  # has no tags
    MISSING = "missing"  # has at least one missing file
    UNBUNDLED = "unbundled"  # scan-staged files awaiting bundling/confirmation


class BundleSort(StrEnum):
    DATE_ADDED = "date_added"
    TITLE = "title"
    RATING = "rating"
    SIZE = "size"
    FILE_COUNT = "file_count"


@dataclass(frozen=True)
class BundleSummary:
    id: str
    title: str | None
    rating: int | None
    file_count: int
    total_size: int
    has_missing: bool
    has_cover: bool
    # Id of the file the cover thumbnail is derived from (or None). Changes when
    # the cover selection changes, so the client uses it to bust the browser's
    # image cache on the (otherwise-stable) thumbnail URL.
    cover_key: str | None
    media_kind: str | None
    width: int | None
    height: int | None
    duration: float | None
    extension: str | None
    date_added: datetime
    grouping_state: GroupingState


@dataclass(frozen=True)
class BundlePage:
    items: list[BundleSummary]
    total: int
    offset: int
    limit: int


# A scan stages every newly discovered file as a provisional one-file bundle
# (grouping_source=scan_suggestion). Until the user bundles or confirms it — via
# grouping review or the manual bundling assistant — it is an "unbundled" file:
# it belongs only in the dedicated Unbundled view and is hidden from All, Recent,
# Uncategorized, Untagged, Missing, and every collection. Confirmed bundles and
# legacy/manual/fast-add bundles are never unbundled.
def _unbundled_predicate() -> ColumnElement[bool]:
    """SQL predicate: a scan-staged provisional bundle not yet confirmed."""
    return (AssetBundle.grouping_state == GroupingState.PROVISIONAL) & (
        AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION
    )


def _file_count_sq() -> Any:
    return (
        select(func.count())
        .select_from(AssetFile)
        .where(AssetFile.bundle_id == AssetBundle.id)
        .scalar_subquery()
    )


# Hidden files are not library-visible assets
def _visible_file_exists() -> Any:
    """SQL predicate allowing empty bundles or at least one non-hidden file."""
    hidden_path = AssetFile.relative_path.like(".%") | AssetFile.relative_path.like("%/.%")
    any_file = exists().where(AssetFile.bundle_id == AssetBundle.id)
    visible_file = exists().where((AssetFile.bundle_id == AssetBundle.id) & not_(hidden_path))
    return not_(any_file) | visible_file


def _size_sq() -> Any:
    return (
        select(func.coalesce(func.sum(AssetFile.size_bytes), 0))
        .where(AssetFile.bundle_id == AssetBundle.id)
        .scalar_subquery()
    )


def _apply_view(
    stmt: Select[Any],
    session: Session,
    view: SystemView,
    collection_id: str | None,
    include_descendants: bool,
) -> Select[Any]:
    if collection_id is not None:
        ids = (
            collection_descendant_ids(session, collection_id, include_self=True)
            if include_descendants
            else [collection_id]
        )
        # Non-correlated semijoin over the (indexed) collection_id, computed once
        # — not a per-bundle correlated EXISTS — so a descendant filter over a
        # large collection subtree stays fast (perf/M2: ~2.6s → ~0.1s at 100k).
        stmt = stmt.where(
            AssetBundle.id.in_(
                select(asset_bundle_collections.c.bundle_id).where(
                    asset_bundle_collections.c.collection_id.in_(ids)
                )
            )
        )
        return stmt

    if view is SystemView.UNCATEGORIZED:
        stmt = stmt.where(~exists().where(asset_bundle_collections.c.bundle_id == AssetBundle.id))
    elif view is SystemView.UNTAGGED:
        stmt = stmt.where(~exists().where(asset_bundle_tags.c.bundle_id == AssetBundle.id))
    elif view is SystemView.MISSING:
        stmt = stmt.where(
            exists().where(
                (AssetFile.bundle_id == AssetBundle.id)
                & (AssetFile.availability == FileAvailability.MISSING)
            )
        )
    return stmt


def _search_predicate(search: str | None) -> Any:
    """Compile a toolbar search string into an FTS semijoin predicate, or None.

    An all-punctuation query yields no usable terms → ``false()`` (match nothing).
    """
    if search is None or not search.strip():
        return None
    match = to_match_query(search)
    return search_predicate(match) if match is not None else false()


def apply_scope(
    stmt: Select[Any],
    session: Session,
    *,
    view: SystemView,
    collection_id: str | None,
    include_descendants: bool,
    predicate: Any,
    search_pred: Any,
) -> Select[Any]:
    """Apply the full browse scope (view/collection, unbundled hiding, filter AST,
    search) to any ``select`` over ``AssetBundle``. Shared by the browse grid, its
    counts, and the facet-count endpoint so all three scope identically."""
    stmt = _apply_view(stmt, session, view, collection_id, include_descendants)
    # The Unbundled view shows *only* scan-staged provisional bundles; every other
    # view (and any collection) hides them until they are confirmed.
    if view is SystemView.UNBUNDLED and collection_id is None:
        stmt = stmt.where(_unbundled_predicate())
    else:
        stmt = stmt.where(not_(_unbundled_predicate()))
    if predicate is not None:
        stmt = stmt.where(predicate)
    if search_pred is not None:
        stmt = stmt.where(search_pred)
    return stmt


def _apply_sort(stmt: Select[Any], sort: BundleSort, descending: bool) -> Select[Any]:
    column = {
        BundleSort.DATE_ADDED: AssetBundle.created_at,
        BundleSort.TITLE: AssetBundle.title,
        BundleSort.RATING: AssetBundle.rating,
        BundleSort.SIZE: _size_sq(),
        BundleSort.FILE_COUNT: _file_count_sq(),
    }[sort]
    ordering = column.desc() if descending else column.asc()
    # AssetBundle.id (ULID) is the stable tie-breaker for deterministic paging.
    return stmt.order_by(ordering, AssetBundle.id.desc() if descending else AssetBundle.id.asc())


def browse_bundles(
    session: Session,
    *,
    view: SystemView = SystemView.ALL,
    collection_id: str | None = None,
    include_descendants: bool = False,
    sort: BundleSort = BundleSort.DATE_ADDED,
    descending: bool = True,
    offset: int = 0,
    limit: int = 100,
    filter_expr: FilterExpression | None = None,
    search: str | None = None,
) -> BundlePage:
    # A saved Smart Collection and a simple toolbar filter both arrive here as
    # the same compiled predicate, so they share one ranking/pagination path.
    predicate = compile_expression(session, filter_expr) if filter_expr is not None else None
    # Toolbar text search: a whole-library FTS5 match, composed as a non-correlated
    # semijoin so it stacks with the active view/collection/filter and sort.
    search_pred = _search_predicate(search)

    def _scoped(stmt: Select[Any]) -> Select[Any]:
        return apply_scope(
            stmt,
            session,
            view=view,
            collection_id=collection_id,
            include_descendants=include_descendants,
            predicate=predicate,
            search_pred=search_pred,
        )

    base = _scoped(select(AssetBundle.id).where(_visible_file_exists()))
    total = session.scalar(select(func.count()).select_from(base.subquery())) or 0

    page_stmt = (
        _apply_sort(_scoped(select(AssetBundle).where(_visible_file_exists())), sort, descending)
        .offset(offset)
        .limit(limit)
    )
    bundles = list(session.scalars(page_stmt))

    summaries = [_summarize(session, bundle) for bundle in bundles]
    return BundlePage(items=summaries, total=total, offset=offset, limit=limit)


def _effective_cover_id(bundle: AssetBundle, files: list[AssetFile]) -> str | None:
    """Id of the file the cover thumbnail is derived from, computed from the
    already-loaded ``files`` (no extra queries). Mirrors the precedence in
    ``media.thumbnails.effective_cover_file`` (selected cover → first image →
    primary video → first video) — keep the two in sync."""
    thumbnailable = (MediaKind.IMAGE, MediaKind.VIDEO)
    if bundle.cover_file_id is not None:
        cover = next((f for f in files if f.id == bundle.cover_file_id), None)
        if cover is not None and cover.media_kind in thumbnailable:
            return cover.id
    image = next((f for f in files if f.media_kind is MediaKind.IMAGE), None)
    if image is not None:
        return image.id
    if bundle.primary_file_id is not None:
        primary = next((f for f in files if f.id == bundle.primary_file_id), None)
        if primary is not None and primary.media_kind is MediaKind.VIDEO:
            return primary.id
    video = next((f for f in files if f.media_kind is MediaKind.VIDEO), None)
    if video is not None:
        return video.id
    return None


def _summarize(session: Session, bundle: AssetBundle) -> BundleSummary:
    files = list(
        session.scalars(
            select(AssetFile)
            .where(AssetFile.bundle_id == bundle.id)
            .order_by(AssetFile.sequence, AssetFile.id)
        )
    )
    total_size = sum(f.size_bytes or 0 for f in files)
    has_missing = any(f.availability == FileAvailability.MISSING for f in files)
    has_cover = bundle.cover_file_id is not None or any(
        f.media_kind in (MediaKind.IMAGE, MediaKind.VIDEO) for f in files
    )
    cover_key = _effective_cover_id(bundle, files)

    # The representative file for card stats: chosen primary, else first video,
    # else first file.
    primary = next((f for f in files if f.id == bundle.primary_file_id), None)
    if primary is None:
        primary = next((f for f in files if f.media_kind == MediaKind.VIDEO), None)
    if primary is None and files:
        primary = files[0]

    meta: dict[str, Any] = (primary.tech_metadata or {}) if primary else {}
    extension = None
    if primary is not None:
        _, _, ext = primary.relative_path.rpartition(".")
        extension = ext.lower() or None

    return BundleSummary(
        id=bundle.id,
        title=bundle.title,
        rating=bundle.rating,
        file_count=len(files),
        total_size=total_size,
        has_missing=has_missing,
        has_cover=has_cover,
        cover_key=cover_key,
        media_kind=str(primary.media_kind) if primary else None,
        width=meta.get("width"),
        height=meta.get("height"),
        duration=meta.get("duration"),
        extension=extension,
        date_added=bundle.created_at,
        grouping_state=bundle.grouping_state,
    )


def view_counts(session: Session) -> dict[str, int]:
    """Counts for the sidebar system views (scoped to this library DB)."""

    def _count(*where: Any, include_unbundled: bool = False) -> int:
        stmt = select(func.count()).select_from(AssetBundle).where(_visible_file_exists())
        # Every normal view excludes scan-staged provisional bundles; only the
        # dedicated Unbundled count includes them.
        stmt = stmt.where(
            _unbundled_predicate() if include_unbundled else not_(_unbundled_predicate())
        )
        for clause in where:
            stmt = stmt.where(clause)
        return session.scalar(stmt) or 0

    total = _count()
    uncategorized = _count(~exists().where(asset_bundle_collections.c.bundle_id == AssetBundle.id))
    untagged = _count(~exists().where(asset_bundle_tags.c.bundle_id == AssetBundle.id))
    missing = _count(
        exists().where(
            (AssetFile.bundle_id == AssetBundle.id)
            & (AssetFile.availability == FileAvailability.MISSING)
        )
    )
    unbundled = _count(include_unbundled=True)
    return {
        "all": total,
        "recent": total,
        "uncategorized": uncategorized,
        "untagged": untagged,
        "missing": missing,
        "unbundled": unbundled,
    }


def collection_counts(session: Session) -> dict[str, int]:
    """Direct (non-recursive) bundle count per collection id, for the sidebar."""
    stmt = select(asset_bundle_collections.c.collection_id, func.count()).group_by(
        asset_bundle_collections.c.collection_id
    )
    rows = session.execute(stmt).all()
    counts = {collection_id: count for collection_id, count in rows}
    # Ensure every collection appears (zero if empty).
    for (collection_id,) in session.execute(select(Collection.id)).all():
        counts.setdefault(collection_id, 0)
    return counts


def tag_counts(session: Session) -> dict[str, int]:
    """Bundle count per tag id (direct membership), for the tag picker."""
    stmt = select(asset_bundle_tags.c.tag_id, func.count()).group_by(asset_bundle_tags.c.tag_id)
    rows = session.execute(stmt).all()
    counts = {tag_id: count for tag_id, count in rows}
    for (tag_id,) in session.execute(select(Tag.id)).all():
        counts.setdefault(tag_id, 0)
    return counts


# The "unrated" bucket key for rating facets (JSON keys are strings; None → this).
UNRATED_KEY = "unrated"


@dataclass(frozen=True)
class FacetCounts:
    # Per tag id → count of matching bundles in the current browse scope. Present
    # only when tags were requested.
    tags: dict[str, int] | None
    # Rating value ("0".."5") or "unrated" → count. Present only when requested.
    ratings: dict[str, int] | None


def facet_counts(
    session: Session,
    *,
    view: SystemView = SystemView.ALL,
    collection_id: str | None = None,
    include_descendants: bool = False,
    filter_expr: FilterExpression | None = None,
    search: str | None = None,
    want_tags: bool = False,
    want_ratings: bool = False,
    tag_include_descendants: bool = True,
) -> FacetCounts:
    """Faceted counts over the *current browse scope* — the same view/collection,
    search, and base filter the grid is showing — not global static counts.

    The base ``filter_expr`` must already exclude the facet category being
    displayed (the caller composes it from the *other* active categories), so the
    tag popover's own include/exclude selections don't shrink their own counts.

    Tag counts follow the active tag rule: with ``tag_include_descendants`` a
    parent tag counts bundles matching it *or any descendant* (distinct); without
    it, direct membership only. Both are computed over the scoped bundle set.
    """
    predicate = compile_expression(session, filter_expr) if filter_expr is not None else None
    scoped = apply_scope(
        select(AssetBundle.id).where(_visible_file_exists()),
        session,
        view=view,
        collection_id=collection_id,
        include_descendants=include_descendants,
        predicate=predicate,
        search_pred=_search_predicate(search),
    )
    scoped_sq = scoped.subquery()
    scoped_ids = select(scoped_sq.c.id)

    tags = _tag_facet(session, scoped_ids, tag_include_descendants) if want_tags else None
    ratings = _rating_facet(session, scoped_ids) if want_ratings else None
    return FacetCounts(tags=tags, ratings=ratings)


def _tag_facet(session: Session, scoped_ids: Any, include_descendants: bool) -> dict[str, int]:
    # Direct (leaf) counts in one grouped pass over the association-table index.
    rows = session.execute(
        select(asset_bundle_tags.c.tag_id, func.count())
        .where(asset_bundle_tags.c.bundle_id.in_(scoped_ids))
        .group_by(asset_bundle_tags.c.tag_id)
    ).all()
    direct = {tag_id: count for tag_id, count in rows}

    all_tags = session.execute(select(Tag.id, Tag.parent_id)).all()
    counts = {tag_id: direct.get(tag_id, 0) for (tag_id, _parent) in all_tags}
    if not include_descendants:
        return counts

    # Roll a parent up over its subtree as a *distinct*-bundle count (a bundle
    # tagged with both a parent and a child must not be double-counted). Only tags
    # that actually have children need the extra query; leaves keep direct counts.
    parents_with_children = {parent for (_tid, parent) in all_tags if parent is not None}
    for tag_id in counts:
        if tag_id not in parents_with_children:
            continue
        subtree = descendant_ids(session, Tag, tag_id, include_self=True)
        counts[tag_id] = (
            session.scalar(
                select(func.count(func.distinct(asset_bundle_tags.c.bundle_id)))
                .where(asset_bundle_tags.c.bundle_id.in_(scoped_ids))
                .where(asset_bundle_tags.c.tag_id.in_(subtree))
            )
            or 0
        )
    return counts


def _rating_facet(session: Session, scoped_ids: Any) -> dict[str, int]:
    rows = session.execute(
        select(AssetBundle.rating, func.count())
        .where(AssetBundle.id.in_(scoped_ids))
        .group_by(AssetBundle.rating)
    ).all()
    counts: dict[str, int] = {}
    for rating, count in rows:
        counts[UNRATED_KEY if rating is None else str(rating)] = count
    return counts
