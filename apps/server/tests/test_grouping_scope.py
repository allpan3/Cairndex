"""Confirmed grouping is the single durable suggestion boundary."""

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.grouping import apply as apply_service
from cairndex.grouping import plan_store
from cairndex.grouping.service import suggest_for_session
from cairndex.persistence.models import AssetBundle
from cairndex.scanning.scanner import scan_library


def _confirm_movie_folder(session: Session, root: Path) -> str:
    """Scan a single movie folder and apply the plan so its bundle is confirmed
    (and, being a leaf folder, filed into no collection)."""
    (root / "Cosmos").mkdir()
    (root / "Cosmos" / "cosmos.mp4").write_text("v")
    (root / "Cosmos" / "poster.jpg").write_text("i")
    scan_library(session, root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    return session.scalars(select(AssetBundle)).one().id


def test_suggestions_leave_a_confirmed_uncategorized_bundle_alone(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)

    assert suggest_for_session(session).proposals == ()
    assert plan_store.generate_plan(session).proposals == []
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None and bundle.grouping_state is GroupingState.CONFIRMED
    assert {f.relative_path for f in bundle.files} == {"Cosmos/cosmos.mp4", "Cosmos/poster.jpg"}
