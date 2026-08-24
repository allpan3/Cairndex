"""Playback progress persistence and continue-watching queries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session
from sqlalchemy.orm.util import identity_key

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.persistence.models import AssetBundle, AssetFile, BundleCursor, PlaybackProgress

if TYPE_CHECKING:
    from cairndex.services.browse import BundleSummary

COMPLETED_THRESHOLD = 0.95


# Public value object for progress reads
@dataclass(frozen=True)
class ProgressValue:
    file_id: str
    bundle_id: str
    position_s: float
    duration_s: float | None
    completed: bool


# Card summary plus the ranked in-progress file needed to resume directly
@dataclass(frozen=True)
class ContinueWatchingItem:
    bundle: BundleSummary
    progress: ProgressValue


# Offset page for unfinished watch rows
@dataclass(frozen=True)
class ContinueWatchingPage:
    items: list[ContinueWatchingItem]
    total: int
    offset: int
    limit: int


# Return only meaningful incomplete progress for card hover activation
def resume_position(position_s: float | None, completed: bool | None) -> float | None:
    if position_s is None or completed or position_s <= 0:
        return None
    return position_s


# Normalize service inputs after schema-level numeric validation
def validate_seconds(value: float | None, *, field: str, required: bool) -> float | None:
    if value is None:
        if required:
            raise ValidationError(f"{field} is required")
        return None
    return float(value)


# Clamp position to the reported duration when duration is known
def clamp_position(position_s: float, duration_s: float | None) -> float:
    if duration_s is None or duration_s <= 0:
        return position_s
    return min(position_s, duration_s)


# Completed means the playhead reached at least 95 percent of known duration
def is_completed(position_s: float, duration_s: float | None) -> bool:
    return bool(duration_s and duration_s > 0 and position_s / duration_s >= COMPLETED_THRESHOLD)


# Columns an existing row takes from the incoming write. The primary key is
# absent for the obvious reason; everything else is rewritten, matching the
# last-write-wins behaviour this endpoint has always had.
_PROGRESS_UPDATABLE = (
    "bundle_id",
    "position_s",
    "duration_s",
    "completed",
    "updated_at",
    "user_id",
)


# Idempotently store progress for an existing video file
def upsert_progress(
    session: Session,
    file_id: str,
    *,
    position_s: float,
    duration_s: float | None,
    user_id: str | None = None,
) -> ProgressValue:
    """Write one file's playback position, creating the row if it is the first.

    A single statement, not read-then-insert. The player writes progress
    periodically *and* on completion, so the two land together at the end of a
    short file — and both would find no row, both INSERT, and the second would
    fail the ``file_id`` primary key with a 500 the owner saw as a failed
    request (2026-08-16). ``ON CONFLICT DO UPDATE`` makes the write atomic, so
    whichever arrives second updates instead of colliding.
    """
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.media_kind is not MediaKind.VIDEO:
        raise ValidationError("playback progress can only be stored for video files")

    duration = validate_seconds(duration_s, field="duration_s", required=False)
    raw_position = validate_seconds(position_s, field="position_s", required=True)
    assert raw_position is not None
    position = clamp_position(raw_position, duration)
    completed = is_completed(position, duration)
    value = ProgressValue(
        file_id=file_id,
        bundle_id=asset_file.bundle_id,
        position_s=position,
        duration_s=duration,
        completed=completed,
    )

    statement = sqlite_insert(PlaybackProgress).values(
        file_id=file_id,
        bundle_id=asset_file.bundle_id,
        position_s=position,
        duration_s=duration,
        completed=completed,
        updated_at=utcnow(),
        user_id=user_id,
    )
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[PlaybackProgress.file_id],
            set_={name: getattr(statement.excluded, name) for name in _PROGRESS_UPDATABLE},
        )
    )
    # A Core statement does not reach the ORM identity map, so a row this
    # session had already loaded would keep the numbers it was loaded with.
    # Expiring it sends the next read back to what we just wrote.
    stale = session.identity_map.get(identity_key(PlaybackProgress, file_id))
    if stale is not None:
        session.expire(stale)
    return value


# Fetch progress for a manifest's already-known file ids in one query
def progress_for_files(session: Session, file_ids: list[str]) -> dict[str, ProgressValue]:
    if not file_ids:
        return {}
    rows = session.scalars(select(PlaybackProgress).where(PlaybackProgress.file_id.in_(file_ids)))
    return {
        row.file_id: ProgressValue(
            file_id=row.file_id,
            bundle_id=row.bundle_id,
            position_s=row.position_s,
            duration_s=row.duration_s,
            completed=bool(row.completed),
        )
        for row in rows
    }


# Return bundle summaries with an unfinished progress row, newest progress first
def continue_watching(session: Session, *, offset: int, limit: int) -> ContinueWatchingPage:
    from cairndex.services.browse import summarize_page

    ranked = (
        select(
            PlaybackProgress.file_id.label("file_id"),
            PlaybackProgress.bundle_id.label("bundle_id"),
            PlaybackProgress.position_s.label("position_s"),
            PlaybackProgress.duration_s.label("duration_s"),
            PlaybackProgress.updated_at.label("updated_at"),
            func.row_number()
            .over(
                partition_by=PlaybackProgress.bundle_id,
                order_by=(PlaybackProgress.updated_at.desc(), PlaybackProgress.file_id.asc()),
            )
            .label("rank"),
        )
        .join(AssetFile, AssetFile.id == PlaybackProgress.file_id)
        .join(AssetBundle, AssetBundle.id == PlaybackProgress.bundle_id)
        .outerjoin(BundleCursor, BundleCursor.bundle_id == PlaybackProgress.bundle_id)
        .where(PlaybackProgress.completed == 0)
        .where(PlaybackProgress.position_s > 0)
        .where(AssetFile.media_kind == MediaKind.VIDEO)
        .where(AssetFile.availability == FileAvailability.AVAILABLE)
        .where(AssetFile.bundle_id == PlaybackProgress.bundle_id)
        .where(BundleCursor.file_id.is_(None) | (BundleCursor.file_id == PlaybackProgress.file_id))
        .subquery()
    )
    base: Select[tuple[str, str, float, float | None]] = (
        select(ranked.c.bundle_id, ranked.c.file_id, ranked.c.position_s, ranked.c.duration_s)
        .where(ranked.c.rank == 1)
        .order_by(ranked.c.updated_at.desc(), ranked.c.file_id.asc())
    )
    total = session.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = session.execute(base.offset(offset).limit(limit)).all()
    bundle_ids = [bundle_id for bundle_id, _file_id, _position_s, _duration_s in rows]
    if not bundle_ids:
        return ContinueWatchingPage(items=[], total=total, offset=offset, limit=limit)
    bundles = list(session.scalars(select(AssetBundle).where(AssetBundle.id.in_(bundle_ids))))
    # One load for the whole page rather than one per row: same reason as the
    # browse grid (see `browse._load_page_rows`).
    summary_by_id = {summary.id: summary for summary in summarize_page(session, bundles)}
    items = [
        ContinueWatchingItem(
            bundle=summary_by_id[bundle_id],
            progress=ProgressValue(
                file_id=file_id,
                bundle_id=bundle_id,
                position_s=position_s,
                duration_s=duration_s,
                completed=False,
            ),
        )
        for bundle_id, file_id, position_s, duration_s in rows
    ]
    return ContinueWatchingPage(items=items, total=total, offset=offset, limit=limit)
