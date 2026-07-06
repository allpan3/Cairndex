"""Playback progress persistence and continue-watching queries."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import MediaKind
from cairndex.persistence.models import AssetBundle, AssetFile, PlaybackProgress
from cairndex.services import browse as browse_service
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


# Idempotently store progress for an existing video file
def upsert_progress(
    session: Session,
    file_id: str,
    *,
    position_s: float,
    duration_s: float | None,
    user_id: str | None = None,
) -> ProgressValue:
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
    now = utcnow()
    row = session.get(PlaybackProgress, file_id)
    if row is None:
        row = PlaybackProgress(
            file_id=file_id,
            bundle_id=asset_file.bundle_id,
            position_s=position,
            duration_s=duration,
            completed=completed,
            updated_at=now,
            user_id=user_id,
        )
        session.add(row)
    else:
        row.bundle_id = asset_file.bundle_id
        row.position_s = position
        row.duration_s = duration
        row.completed = completed
        row.updated_at = now
        row.user_id = user_id
    session.flush()
    return ProgressValue(
        file_id=row.file_id,
        bundle_id=row.bundle_id,
        position_s=row.position_s,
        duration_s=row.duration_s,
        completed=bool(row.completed),
    )


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
        .where(PlaybackProgress.completed == 0)
        .where(PlaybackProgress.position_s > 0)
        .where(AssetFile.media_kind == MediaKind.VIDEO)
        .where(AssetFile.bundle_id == PlaybackProgress.bundle_id)
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
    by_id = {bundle.id: bundle for bundle in bundles}
    items = [
        ContinueWatchingItem(
            bundle=browse_service._summarize(session, by_id[bundle_id]),
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
