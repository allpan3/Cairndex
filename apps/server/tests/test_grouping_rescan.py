"""Re-scan additions suggested into confirmed bundles (ADR-0009 phase 5)."""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, GroupingState
from cairndex.grouping import ProposalKind, plan_store
from cairndex.grouping import apply as apply_service
from cairndex.grouping.service import suggest_for_session
from cairndex.persistence.models import AssetBundle, AssetFile, SubtitleTrack
from cairndex.scanning.scanner import scan_library


def _confirm_movie_folder(session: Session, root: Path) -> str:
    """Scan a movie folder and apply the plan so its bundle is confirmed."""
    (root / "Cosmos").mkdir()
    (root / "Cosmos" / "cosmos.mp4").write_text("v")
    (root / "Cosmos" / "poster.jpg").write_text("i")
    scan_library(session, root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    return session.scalars(select(AssetBundle)).one().id


def test_new_sidecar_is_suggested_into_the_confirmed_bundle(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)

    # A subtitle appears later, in the confirmed bundle's directory.
    (library_root / "Cosmos" / "cosmos.en.srt").write_text("s")
    scan_library(session, library_root)  # new provisional one-file bundle

    plan = suggest_for_session(session)
    additions = [p for p in plan.proposals if p.target_bundle_id is not None]
    assert len(additions) == 1
    assert additions[0].target_bundle_id == bundle_id
    assert additions[0].kind is ProposalKind.BUNDLE
    assert additions[0].files[0].role is FileRole.SUBTITLE
    # The confirmed bundle is never re-proposed as a fresh grouping.
    assert all(p.target_bundle_id is not None for p in plan.proposals)


def test_applying_an_addition_folds_the_file_in_and_links_subtitle(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)
    (library_root / "Cosmos" / "soundtrack.mp3").write_text("a")
    (library_root / "Cosmos" / "cosmos.en.srt").write_text("s")
    scan_library(session, library_root)
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 3

    plan = plan_store.generate_plan(session)
    addition = next(proposal for proposal in plan.proposals if proposal.target_bundle_id)
    plan_store.move_proposal_file(
        session,
        plan.id,
        addition.id,
        addition.files[0].asset_file_id,
        addition.id,
        len(addition.files),
    )
    result = apply_service.apply_plan(session, plan)

    assert result.files_added_to_bundles == 2
    assert result.subtitles_linked == 1
    # The provisional one-file bundle was emptied and removed.
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None and bundle.grouping_state is GroupingState.CONFIRMED
    rels = [
        relative_path
        for (relative_path,) in session.execute(
            select(AssetFile.relative_path)
            .where(AssetFile.bundle_id == bundle.id)
            .order_by(AssetFile.sequence)
        )
    ]
    assert rels == [
        "Cosmos/cosmos.mp4",
        "Cosmos/poster.jpg",
        "Cosmos/cosmos.en.srt",
        "Cosmos/soundtrack.mp3",
    ]
    track = session.scalars(select(SubtitleTrack)).one()
    assert track.video_file_id is not None


def test_addition_apply_is_idempotent(session: Session, library_root: Path) -> None:
    _confirm_movie_folder(session, library_root)
    (library_root / "Cosmos" / "cosmos.en.srt").write_text("s")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    apply_service.apply_plan(session, plan)
    second = apply_service.apply_plan(session, plan)
    assert second.files_added_to_bundles == 0
    assert not second.conflicts


def test_new_file_in_unowned_directory_is_a_fresh_bundle(
    session: Session, library_root: Path
) -> None:
    _confirm_movie_folder(session, library_root)
    # A new file in a *different* directory is not an addition.
    (library_root / "other.mp4").write_text("v")
    scan_library(session, library_root)

    plan = suggest_for_session(session)
    assert [p.target_bundle_id for p in plan.proposals] == [None]
    assert (
        plan.proposals[0].files[0].asset_file_id
        == session.scalars(select(AssetFile.id).where(AssetFile.relative_path == "other.mp4")).one()
    )
