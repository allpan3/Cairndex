"""Suggestion scope: routine scan/Update ("new") vs manual "Suggest grouping"
("uncategorized").

"new" leaves every confirmed grouping alone (only newly discovered files get
proposals). "uncategorized" re-opens any bundle that isn't filed into a
collection — including a previously confirmed one whose collections were later
removed — so it can be re-proposed, while bundles already in a collection are
left untouched.
"""

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState, ProposalKind
from cairndex.grouping import apply as apply_service
from cairndex.grouping import plan_store
from cairndex.grouping.service import suggest_for_session
from cairndex.persistence.models import AssetBundle, Collection
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


def test_new_scope_leaves_a_confirmed_uncategorized_bundle_alone(
    session: Session, library_root: Path
) -> None:
    _confirm_movie_folder(session, library_root)
    # Routine Update: the confirmed bundle is settled, so nothing is re-proposed.
    plan = suggest_for_session(session, scope="new")
    assert plan.proposals == ()


def test_uncategorized_scope_reopens_a_confirmed_uncategorized_bundle(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)

    plan = suggest_for_session(session, scope="uncategorized")
    fresh = [
        p for p in plan.proposals if p.target_bundle_id is None and p.kind is ProposalKind.BUNDLE
    ]
    assert len(fresh) == 1
    assert fresh[0].title == "Cosmos"

    # Applying it is a safe no-op re-confirm — the DB's confirmed state protects
    # the bundle from being re-split; nothing new is created or removed.
    result = apply_service.apply_plan(
        session, plan_store.generate_plan(session, scope="uncategorized")
    )
    assert result.bundles_confirmed == 0
    assert result.bundles_removed == 0
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None and bundle.grouping_state is GroupingState.CONFIRMED
    assert {f.relative_path for f in bundle.files} == {"Cosmos/cosmos.mp4", "Cosmos/poster.jpg"}


def test_uncategorized_scope_leaves_a_filed_bundle_alone(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)
    collection = Collection(name="Movies")
    session.add(collection)
    session.flush()
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    bundle.collections.append(collection)
    session.flush()

    plan = suggest_for_session(session, scope="uncategorized")
    assert [p for p in plan.proposals if p.target_bundle_id is None] == []
