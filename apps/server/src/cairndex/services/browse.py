"""Bundle browsing: enriched summaries, system views, sorting, and counts.

Powers the desktop library browser. Returns card-ready ``BundleSummary`` rows
(cursor-derived dimensions, duration, size, file count, missing state)
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

from sqlalchemy import Select, exists, false, func, not_, select, text, update
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
    BundleCursor,
    Collection,
    PlaybackProgress,
    Tag,
    asset_bundle_collections,
    asset_bundle_tags,
)
from cairndex.search import search_predicate, to_match_query
from cairndex.services.bundle_cursor import is_openable, select_current_file
from cairndex.services.collections import collection_descendant_ids
from cairndex.services.hierarchy import descendant_ids
from cairndex.services.playback_progress import resume_position


class SystemView(StrEnum):
    ALL = "all"
    RECENT = "recent"  # all, ordered by one of the date columns (client picks)
    UNCATEGORIZED = "uncategorized"  # in no collection
    UNTAGGED = "untagged"  # has no tags
    MISSING = "missing"  # has at least one missing file
    UNBUNDLED = "unbundled"  # scan-staged files awaiting bundling/confirmation
    # Every bundle, in a seeded shuffle: the browse-by-serendipity view. The
    # client supplies (and reseeds) the seed; identical seeds page identically.
    RANDOM = "random"


class BundleSort(StrEnum):
    DATE_ADDED = "date_added"
    DATE_MODIFIED = "date_modified"  # bundle metadata last changed
    DATE_OPENED = "date_opened"  # last opened in the album view or viewer
    TITLE = "title"
    RATING = "rating"
    SIZE = "size"
    FILE_COUNT = "file_count"
    # Owner-defined manual order (drag-reorder / "Clean up by…"). Inside a single
    # collection it uses that collection's membership order; elsewhere the global
    # AssetBundle.manual_order.
    MANUAL = "manual"


@dataclass(frozen=True)
class BundleSummary:
    id: str
    title: str | None
    rating: int | None
    file_count: int
    total_size: int
    has_missing: bool
    has_cover: bool
    openable: bool
    # Id of the file the cover thumbnail is derived from (or None). Changes when
    # the cover selection changes, so the client uses it to bust the browser's
    # image cache on the (otherwise-stable) thumbnail URL.
    cover_key: str | None
    # Hover/open source resolved from the bundle cursor, independent of its cover
    resume_file_id: str | None
    resume_file_updated_at: datetime | None
    resume_media_kind: str | None
    resume_relative_path: str | None
    resume_mime_type: str | None
    resume_container: str | None
    resume_video_codec: str | None
    resume_video_codec_tag: str | None
    resume_audio_codec: str | None
    resume_duration: float | None
    resume_position: float | None
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
# it belongs in the dedicated Unbundled view. A stale provisional row also appears
# in Missing so the owner can repair it; it remains hidden from every other normal
# view and collection. Confirmed bundles and legacy/manual/fast-add bundles are
# never unbundled.
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
    # Missing includes stale provisional rows so they have a repair surface;
    # every other normal view hides them until they are confirmed.
    if view is SystemView.UNBUNDLED and collection_id is None:
        stmt = stmt.where(_unbundled_predicate())
    elif view is not SystemView.MISSING or collection_id is not None:
        stmt = stmt.where(not_(_unbundled_predicate()))
    if predicate is not None:
        stmt = stmt.where(predicate)
    if search_pred is not None:
        stmt = stmt.where(search_pred)
    return stmt


def _manual_order_column(collection_id: str | None, include_descendants: bool) -> Any:
    """The column MANUAL sort orders by: the bundle's order *within* a single
    collection (its membership ``sort_order``) when scoped to one, else the global
    ``AssetBundle.manual_order``. Descendant views span multiple collections, so
    they fall back to the global order."""
    if collection_id is not None and not include_descendants:
        return (
            select(asset_bundle_collections.c.sort_order)
            .where(
                (asset_bundle_collections.c.bundle_id == AssetBundle.id)
                & (asset_bundle_collections.c.collection_id == collection_id)
            )
            .scalar_subquery()
        )
    return AssetBundle.manual_order


def _apply_sort(
    stmt: Select[Any],
    sort: BundleSort,
    descending: bool,
    *,
    collection_id: str | None = None,
    include_descendants: bool = False,
) -> Select[Any]:
    column = {
        BundleSort.DATE_ADDED: AssetBundle.created_at,
        BundleSort.DATE_MODIFIED: AssetBundle.updated_at,
        # NULL = never opened. SQLite sorts NULLs last under DESC, which is what
        # "most recently opened first" should show anyway.
        BundleSort.DATE_OPENED: AssetBundle.last_opened_at,
        BundleSort.TITLE: AssetBundle.title,
        BundleSort.RATING: AssetBundle.rating,
        BundleSort.SIZE: _size_sq(),
        BundleSort.FILE_COUNT: _file_count_sq(),
        BundleSort.MANUAL: _manual_order_column(collection_id, include_descendants),
    }[sort]
    ordering = column.desc() if descending else column.asc()
    # AssetBundle.id (ULID) is the stable tie-breaker for deterministic paging.
    #
    # Manual inverts it. A bundle nobody has dragged yet keeps the default order
    # value it was created with, so under MANUAL the tie-break is what decides
    # where every *new* bundle lands — and ULIDs ascend with time, meaning
    # oldest-first would bury a fresh import at the end of the library. Newest
    # first there puts what just arrived at the front, which is where someone
    # goes looking for it. Once a group has actually been dragged, its members
    # hold distinct order values and this never applies.
    tie_descending = not descending if sort is BundleSort.MANUAL else descending
    return stmt.order_by(
        ordering, AssetBundle.id.desc() if tie_descending else AssetBundle.id.asc()
    )


def _shuffle_order(seed: int) -> Any:
    """A deterministic pseudo-shuffle: order by a per-seed permutation key.

    ``(rowid * odd_multiplier) % prime`` walks the rowids in an order that
    scrambles thoroughly for shuffle purposes and — unlike SQL ``random()`` —
    is stable for a given seed, which is what keeps offset pagination coherent
    across pages and refetches. Pure SQL, no per-row Python, no schema change;
    reseeding is the client sending a different seed.
    """
    # Knuth-mix the seed first: the multiplier must be large enough that even
    # rowid*2 wraps the modulus, or a small library under a small seed comes out
    # in rowid order — no shuffle at all. The modulus is prime, so any non-zero
    # multiplier below it permutes rather than collides.
    multiplier = (seed * 2_654_435_761 + 40_503) % 2_147_483_647 or 1
    return text(f"(asset_bundles._rowid_ * {multiplier}) % 2147483647")


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
    seed: int | None = None,
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

    page = _scoped(select(AssetBundle).where(_visible_file_exists()))
    if view is SystemView.RANDOM:
        # The whole point of the view is the shuffle, so the sort params are
        # ignored rather than allowed to un-shuffle it; the id tie-break keeps
        # paging deterministic if two rowid keys ever collide.
        ordered = page.order_by(_shuffle_order(seed or 1), AssetBundle.id.asc())
    else:
        ordered = _apply_sort(
            page,
            sort,
            descending,
            collection_id=collection_id,
            include_descendants=include_descendants,
        )
    page_stmt = ordered.offset(offset).limit(limit)
    bundles = list(session.scalars(page_stmt))

    summaries = [_summarize(session, bundle) for bundle in bundles]
    return BundlePage(items=summaries, total=total, offset=offset, limit=limit)


def _write_manual_order(
    session: Session, collection_id: str | None, ordered_ids: list[str]
) -> None:
    """Assign each id its 0-based position as the manual order — into the given
    collection's membership ``sort_order`` when scoped to one, else the global
    ``AssetBundle.manual_order``.

    Only rows whose position actually changes are written. ``ordered_ids`` now
    spans the whole scope (the move is resolved server-side), and most of a
    scope does not move in any one drag — an unconditional rewrite would issue
    one UPDATE per bundle in the library per drag. Worse, ``updated_at`` carries
    ``onupdate=utcnow``, so those writes stamped every bundle "modified just
    now": a drag would silently rewrite the whole library's Date Modified
    ordering. Rearranging a shelf is not editing the books — the rows that must
    move carry their ``updated_at`` forward explicitly (passing the current
    value overrides the onupdate default, which only fills omitted columns)."""
    if collection_id is not None:
        current_membership: dict[str, int] = {
            row.bundle_id: row.sort_order
            for row in session.execute(
                select(
                    asset_bundle_collections.c.bundle_id,
                    asset_bundle_collections.c.sort_order,
                ).where(asset_bundle_collections.c.collection_id == collection_id)
            )
        }
        for order, bundle_id in enumerate(ordered_ids):
            if current_membership.get(bundle_id) == order:
                continue
            session.execute(
                update(asset_bundle_collections)
                .where(
                    (asset_bundle_collections.c.bundle_id == bundle_id)
                    & (asset_bundle_collections.c.collection_id == collection_id)
                )
                .values(sort_order=order)
            )
    else:
        current_order: dict[str, int] = {
            row.id: row.manual_order
            for row in session.execute(select(AssetBundle.id, AssetBundle.manual_order))
        }
        for order, bundle_id in enumerate(ordered_ids):
            if current_order.get(bundle_id) == order:
                continue
            session.execute(
                update(AssetBundle)
                .where(AssetBundle.id == bundle_id)
                .values(manual_order=order, updated_at=AssetBundle.updated_at)
            )
    session.flush()


def scoped_manual_order(session: Session, collection_id: str | None) -> list[str]:
    """Every bundle id in the scope, in its current manual order."""
    scoped = apply_scope(
        select(AssetBundle.id).where(_visible_file_exists()),
        session,
        view=SystemView.ALL,
        collection_id=collection_id,
        include_descendants=False,
        predicate=None,
        search_pred=None,
    )
    return list(
        session.scalars(_apply_sort(scoped, BundleSort.MANUAL, False, collection_id=collection_id))
    )


def reorder_bundles(
    session: Session,
    *,
    collection_id: str | None,
    moved_ids: list[str],
    before_id: str | None,
) -> list[str]:
    """Move bundles to a gap in the manual order (MANUAL sort).

    Takes the *move* rather than an order: ``moved_ids`` land as one block
    immediately before ``before_id`` (or at the end when it is None), keeping the
    relative order they already have. The new positions are then written across
    the whole scope.

    Returns the scope's resulting order, so the caller never has to re-derive it
    (or re-fetch to find out): the answer to "where did it land" comes back with
    the write that decided it.

    Deliberately not "renumber the list the client sent". Browsing is paged, so
    the client's list is only the loaded window; numbering it 0..n-1 left every
    unloaded bundle holding order values from the same range, which is what made
    a drag in a large collection scatter items to the front or back. Resolving
    the move against the full scope here makes the loaded window irrelevant.
    """
    order = scoped_manual_order(session, collection_id)
    moving = [bundle_id for bundle_id in order if bundle_id in set(moved_ids)]
    # Dropping onto a member of the block is a no-op, not an error: the block
    # cannot land relative to itself.
    if not moving or before_id in set(moving):
        return order
    rest = [bundle_id for bundle_id in order if bundle_id not in set(moving)]
    at = rest.index(before_id) if before_id in rest else len(rest)
    result = rest[:at] + moving + rest[at:]
    _write_manual_order(session, collection_id, result)
    return result


def cleanup_bundle_order(
    session: Session,
    *,
    collection_id: str | None,
    sort: BundleSort,
    descending: bool,
) -> None:
    """Rewrite the manual order of every bundle in scope to a chosen sort key.

    Computes the full scoped ordering server-side (not just a loaded page), so the
    resulting manual order is dense and deterministic across the whole collection
    (or the global order when ``collection_id`` is None)."""
    scoped = apply_scope(
        select(AssetBundle.id).where(_visible_file_exists()),
        session,
        view=SystemView.ALL,
        collection_id=collection_id,
        include_descendants=False,
        predicate=None,
        search_pred=None,
    )
    ordered = _apply_sort(scoped, sort, descending, collection_id=collection_id)
    ids = list(session.scalars(ordered))
    _write_manual_order(session, collection_id, ids)


# Resolve the effective cover from the already-loaded file list
def _effective_cover_file(bundle: AssetBundle, files: list[AssetFile]) -> AssetFile | None:
    """File the cover thumbnail is derived from, computed from the
    already-loaded ``files`` (no extra queries). Mirrors the precedence in
    ``media.thumbnails.effective_cover_file`` (selected cover → first image →
    first video) — keep the two in sync."""
    thumbnailable = (MediaKind.IMAGE, MediaKind.VIDEO)

    if bundle.cover_file_id is not None:
        cover = next((f for f in files if f.id == bundle.cover_file_id), None)
        if cover is not None and cover.media_kind in thumbnailable:
            return cover
    image = next((f for f in files if f.media_kind is MediaKind.IMAGE), None)
    if image is not None:
        return image
    video = next((f for f in files if f.media_kind is MediaKind.VIDEO), None)
    return video


# Build the thumbnail cache key for one effective cover file
def _cover_key(asset_file: AssetFile | None) -> str | None:
    if asset_file is None:
        return None
    return (
        f"{asset_file.id}:{asset_file.updated_at.timestamp()}"
        if asset_file.cover_time is not None
        else asset_file.id
    )


def _summarize(session: Session, bundle: AssetBundle) -> BundleSummary:
    file_rows = list(
        session.execute(
            select(AssetFile, PlaybackProgress, BundleCursor.file_id)
            .outerjoin(PlaybackProgress, PlaybackProgress.file_id == AssetFile.id)
            .outerjoin(BundleCursor, BundleCursor.bundle_id == AssetFile.bundle_id)
            .where(AssetFile.bundle_id == bundle.id)
            .order_by(AssetFile.sequence, AssetFile.id)
        )
    )
    files = [asset_file for asset_file, _progress, _cursor_file_id in file_rows]
    progress_by_file = {
        asset_file.id: progress
        for asset_file, progress, _cursor_file_id in file_rows
        if progress is not None
    }
    total_size = sum(f.size_bytes or 0 for f in files)
    has_missing = any(f.availability == FileAvailability.MISSING for f in files)
    has_cover = bundle.cover_file_id is not None or any(
        f.media_kind in (MediaKind.IMAGE, MediaKind.VIDEO) for f in files
    )
    effective_cover = _effective_cover_file(bundle, files)
    cover_key = _cover_key(effective_cover)
    cursor_file_id = file_rows[0][2] if file_rows else None
    current = select_current_file(files, cursor_file_id, progress_by_file)
    preview = current if current is not None and is_openable(current) else None
    current_progress = progress_by_file.get(current.id) if current else None
    meta: dict[str, Any] = (current.tech_metadata or {}) if current else {}
    extension = None
    if current is not None:
        _, _, ext = current.relative_path.rpartition(".")
        extension = ext.lower() or None

    return BundleSummary(
        id=bundle.id,
        title=bundle.title,
        rating=bundle.rating,
        file_count=len(files),
        total_size=total_size,
        has_missing=has_missing,
        has_cover=has_cover,
        openable=any(is_openable(asset_file) for asset_file in files),
        cover_key=cover_key,
        resume_file_id=current.id if current else None,
        resume_file_updated_at=preview.updated_at if preview else None,
        resume_media_kind=str(preview.media_kind) if preview else None,
        resume_relative_path=preview.relative_path if preview else None,
        resume_mime_type=preview.mime_type if preview else None,
        resume_container=meta.get("container") if preview else None,
        resume_video_codec=meta.get("video_codec") if preview else None,
        resume_video_codec_tag=meta.get("video_codec_tag") if preview else None,
        resume_audio_codec=meta.get("audio_codec") if preview else None,
        resume_duration=meta.get("duration") if preview else None,
        resume_position=resume_position(
            current_progress.position_s if preview and current_progress else None,
            current_progress.completed if preview and current_progress else None,
        ),
        media_kind=str(current.media_kind) if current else None,
        width=meta.get("width"),
        height=meta.get("height"),
        duration=meta.get("duration"),
        extension=extension,
        date_added=bundle.created_at,
        grouping_state=bundle.grouping_state,
    )


def view_counts(session: Session) -> dict[str, int]:
    """Counts for the sidebar system views (scoped to this library DB)."""

    def _count(
        *where: Any, include_unbundled: bool = False, include_all_grouping_states: bool = False
    ) -> int:
        stmt = select(func.count()).select_from(AssetBundle).where(_visible_file_exists())
        if not include_all_grouping_states:
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
        ),
        include_all_grouping_states=True,
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


# Count each collection's distinct bundle membership across its full subtree
def collection_counts(session: Session) -> dict[str, int]:
    """Distinct bundle count per collection subtree, for the sidebar."""
    subtree = select(Collection.id.label("ancestor_id"), Collection.id.label("descendant_id")).cte(
        "collection_subtree", recursive=True
    )
    subtree = subtree.union_all(
        select(subtree.c.ancestor_id, Collection.id).join(
            subtree, Collection.parent_id == subtree.c.descendant_id
        )
    )
    stmt = (
        select(
            subtree.c.ancestor_id,
            func.count(func.distinct(asset_bundle_collections.c.bundle_id)),
        )
        .select_from(subtree)
        .outerjoin(
            asset_bundle_collections,
            asset_bundle_collections.c.collection_id == subtree.c.descendant_id,
        )
        .group_by(subtree.c.ancestor_id)
    )
    return {collection_id: count for collection_id, count in session.execute(stmt).all()}


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
