"""Read-only DB adapter for the grouping suggester (ADR-0009 phase 2).

Reads the current library content and produces a :class:`GroupingPlan`. It only
*reads* — persisting and applying a plan is the conflict-aware phase-3 step.
Files already in a confirmed bundle are flagged so the pure suggester excludes
them (confirmed user decisions win over heuristics).
"""

from __future__ import annotations

from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.grouping.suggester import FileObservation, GroupingPlan, suggest_grouping
from cairndex.persistence.models import AssetBundle, AssetFile, asset_bundle_collections
from cairndex.scanning.media_types import is_hidden_relative_path

# What a grouping pass is allowed to (re)suggest:
#  - "new": routine Update/scan — leave every already-confirmed grouping alone,
#    so only newly discovered (still-provisional) files get proposals.
#  - "uncategorized": the manual "Suggest grouping" — treat any bundle that isn't
#    in a collection as an open candidate again (even a previously confirmed one
#    whose collections were later removed), so it can be re-proposed for grouping.
#    Bundles already filed into a collection are left as owners, not re-suggested.
SuggestScope = Literal["new", "uncategorized"]


def _categorized_bundle_ids(session: Session) -> set[str]:
    """Ids of every bundle that currently belongs to at least one collection."""
    return set(session.scalars(select(asset_bundle_collections.c.bundle_id).distinct()).all())


def gather_observations(session: Session, *, scope: SuggestScope = "new") -> list[FileObservation]:
    """Snapshot every linked file plus whether its bundle is treated as settled
    (so the suggester leaves it alone / folds new files into it) for the scope.

    For ``new`` a bundle is settled once its grouping is confirmed; for
    ``uncategorized`` a bundle is settled once it's filed into a collection, so a
    confirmed-but-uncategorized bundle is re-opened for suggestions."""
    categorized = _categorized_bundle_ids(session) if scope == "uncategorized" else set()
    rows = session.execute(
        select(
            AssetFile.id,
            AssetFile.relative_path,
            AssetFile.media_kind,
            AssetBundle.id,
            AssetBundle.grouping_state,
            AssetBundle.title,
        ).join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
    ).all()
    return [
        FileObservation(
            asset_file_id=file_id,
            relative_path=relative_path,
            media_kind=media_kind,
            grouping_confirmed=(
                bundle_id in categorized
                if scope == "uncategorized"
                else grouping_state is GroupingState.CONFIRMED
            ),
            bundle_id=bundle_id,
            bundle_title=title,
        )
        for file_id, relative_path, media_kind, bundle_id, grouping_state, title in rows
        if not is_hidden_relative_path(relative_path)
    ]


def suggest_for_session(session: Session, *, scope: SuggestScope = "new") -> GroupingPlan:
    """Build a grouping plan from a library's current (read-only) content."""
    return suggest_grouping(gather_observations(session, scope=scope))
