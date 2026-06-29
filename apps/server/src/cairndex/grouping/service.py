"""Read-only DB adapter for the grouping suggester (ADR-0009 phase 2).

Reads the current library content and produces a :class:`GroupingPlan`. It only
*reads* — persisting and applying a plan is the conflict-aware phase-3 step.
Files already in a confirmed bundle are flagged so the pure suggester excludes
them (confirmed user decisions win over heuristics).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.grouping.suggester import FileObservation, GroupingPlan, suggest_grouping
from cairndex.persistence.models import AssetBundle, AssetFile


def gather_observations(session: Session) -> list[FileObservation]:
    """Snapshot every linked file plus whether its bundle is confirmed."""
    rows = session.execute(
        select(
            AssetFile.id,
            AssetFile.relative_path,
            AssetFile.media_kind,
            AssetBundle.grouping_state,
        ).join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
    ).all()
    return [
        FileObservation(
            asset_file_id=file_id,
            relative_path=relative_path,
            media_kind=media_kind,
            grouping_confirmed=grouping_state is GroupingState.CONFIRMED,
        )
        for file_id, relative_path, media_kind, grouping_state in rows
    ]


def suggest_for_session(session: Session) -> GroupingPlan:
    """Build a grouping plan from a library's current (read-only) content."""
    return suggest_grouping(gather_observations(session))
