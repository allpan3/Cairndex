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

from sqlalchemy import Select, exists, func, not_, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, GroupingState, MediaKind
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
from cairndex.services.collections import collection_descendant_ids


class SystemView(StrEnum):
    ALL = "all"
    RECENT = "recent"  # all, default-sorted by date added
    UNCATEGORIZED = "uncategorized"  # in no collection
    UNTAGGED = "untagged"  # has no tags
    MISSING = "missing"  # has at least one missing file


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
        stmt = stmt.where(
            exists().where(
                (asset_bundle_collections.c.bundle_id == AssetBundle.id)
                & asset_bundle_collections.c.collection_id.in_(ids)
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
) -> BundlePage:
    # A saved Smart Collection and a simple toolbar filter both arrive here as
    # the same compiled predicate, so they share one ranking/pagination path.
    predicate = compile_expression(session, filter_expr) if filter_expr is not None else None

    def _scoped(stmt: Select[Any]) -> Select[Any]:
        stmt = _apply_view(stmt, session, view, collection_id, include_descendants)
        return stmt.where(predicate) if predicate is not None else stmt

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

    def _count(*where: Any) -> int:
        stmt = select(func.count()).select_from(AssetBundle).where(_visible_file_exists())
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
    return {
        "all": total,
        "recent": total,
        "uncategorized": uncategorized,
        "untagged": untagged,
        "missing": missing,
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
