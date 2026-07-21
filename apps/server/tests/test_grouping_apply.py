"""Durable grouping plans + conflict-aware apply (ADR-0009 phase 3)."""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, FileRole, GroupingPlanStatus, GroupingState
from cairndex.grouping import apply as apply_service
from cairndex.grouping import plan_store
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    SubtitleTrack,
)


def _make_movie_folder(root: Path) -> None:
    (root / "Cosmos").mkdir()
    (root / "Cosmos" / "cosmos.mp4").write_text("video")
    (root / "Cosmos" / "poster.jpg").write_text("image")
    (root / "Cosmos" / "cosmos.en.srt").write_text("subs")


def _bundle_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(AssetBundle)) or 0


def _file_ids(session: Session) -> set[str]:
    return set(session.scalars(select(AssetFile.id)).all())


def test_apply_merges_scan_fragments_into_one_confirmed_bundle(
    session: Session, library_root: Path
) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)
    assert _bundle_count(session) == 3  # over-fragmented: one bundle per file
    ids_before = _file_ids(session)

    plan = plan_store.generate_plan(session)
    result = apply_service.apply_plan(session, plan)

    assert result.bundles_confirmed == 1
    assert result.bundles_removed == 2  # the two emptied single-file bundles
    assert result.subtitles_linked == 1
    assert not result.conflicts
    assert _bundle_count(session) == 1
    # AssetFile ids are preserved across the merge (moved-file repair stays stable).
    assert _file_ids(session) == ids_before

    bundle = session.scalars(select(AssetBundle)).one()
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.confirmed_at is not None
    files = {f.relative_path: f for f in bundle.files}
    assert files["Cosmos/cosmos.mp4"].role is FileRole.PRIMARY_VIDEO
    assert files["Cosmos/poster.jpg"].role is FileRole.COVER
    assert bundle.primary_file_id is None  # legacy column is no longer assigned
    assert bundle.cover_file_id == files["Cosmos/poster.jpg"].id

    track = session.scalars(select(SubtitleTrack)).one()
    assert track.source_file_id == files["Cosmos/cosmos.en.srt"].id
    assert track.video_file_id == files["Cosmos/cosmos.mp4"].id
    assert plan.status is GroupingPlanStatus.APPLIED


def test_apply_is_idempotent(session: Session, library_root: Path) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    apply_service.apply_plan(session, plan)
    second = apply_service.apply_plan(session, plan)

    # Re-applying a settled plan changes nothing and raises no conflicts.
    assert second.bundles_confirmed == 0
    assert second.bundles_removed == 0
    assert second.subtitles_linked == 0
    assert not second.conflicts
    assert _bundle_count(session) == 1


def test_apply_container_creates_collection_with_member_bundles(
    session: Session, library_root: Path
) -> None:
    from cairndex.scanning.scanner import scan_library

    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Movies" / "Cosmos" / "poster.jpg").write_text("i")
    (library_root / "Movies" / "Waves").mkdir()
    (library_root / "Movies" / "Waves" / "waves.mp4").write_text("v")
    scan_library(session, library_root)

    plan = plan_store.generate_plan(session)
    result = apply_service.apply_plan(session, plan)

    assert result.collections_created == 1
    assert result.bundles_confirmed == 2
    assert result.bundles_added_to_collections == 2

    movies = session.scalars(select(Collection).where(Collection.name == "Movies")).one()
    confirmed = session.scalars(
        select(AssetBundle).where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
    )
    member_titles = {b.title for b in confirmed if any(c.id == movies.id for c in b.collections)}
    assert member_titles == {"Cosmos", "Waves"}


# Applying a selected subset leaves unselected proposals provisional
def test_apply_selected_proposals_only(session: Session, library_root: Path) -> None:
    from cairndex.scanning.scanner import scan_library

    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Movies" / "Waves").mkdir()
    (library_root / "Movies" / "Waves" / "waves.mp4").write_text("v")
    scan_library(session, library_root)

    plan = plan_store.generate_plan(session)
    movies = next(p for p in plan.proposals if p.kind.value == "container")
    cosmos = next(p for p in plan.proposals if p.title == "Cosmos")
    result = apply_service.apply_plan(session, plan, proposal_ids={movies.id, cosmos.id})

    assert result.bundles_confirmed == 1
    assert result.collections_created == 1
    assert result.bundles_added_to_collections == 1
    states = {b.title: b.grouping_state for b in session.scalars(select(AssetBundle)).all()}
    assert states["Cosmos"] is GroupingState.CONFIRMED
    assert states["waves"] is GroupingState.PROVISIONAL


def test_apply_skips_proposal_when_a_file_was_manually_regrouped(
    session: Session, library_root: Path
) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    # The user confirms one file's bundle out-of-band before applying.
    poster = session.scalars(
        select(AssetFile).where(AssetFile.relative_path == "Cosmos/poster.jpg")
    ).one()
    poster.bundle.grouping_state = GroupingState.CONFIRMED
    session.flush()

    result = apply_service.apply_plan(session, plan)

    assert result.bundles_confirmed == 0
    assert len(result.conflicts) == 1
    assert "confirmed bundle" in result.conflicts[0].reason
    # No provisional bundle was merged away; the confirmed decision stands.
    assert _bundle_count(session) == 3


def test_apply_reports_missing_files_as_conflict(session: Session, library_root: Path) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    # A referenced file vanishes from the DB after the plan was generated.
    srt = session.scalars(
        select(AssetFile).where(AssetFile.relative_path == "Cosmos/cosmos.en.srt")
    ).one()
    session.delete(srt.bundle)  # DB cascade removes the file row too
    session.flush()
    # Drop the now-stale identity-map copy, as a fresh apply session would.
    session.expire_all()

    result = apply_service.apply_plan(session, plan)

    # The remaining video+poster still group; the vanished srt is a localized note.
    assert result.bundles_confirmed == 1
    assert any("no longer exist" in c.reason for c in result.conflicts)


# A stale plan fails closed after scan marks one of its files missing
def test_apply_reports_file_marked_missing_as_conflict(
    session: Session, library_root: Path
) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    srt = session.scalars(
        select(AssetFile).where(AssetFile.relative_path == "Cosmos/cosmos.en.srt")
    ).one()
    srt.availability = FileAvailability.MISSING
    session.flush()

    result = apply_service.apply_plan(session, plan)

    assert result.bundles_confirmed == 1
    assert any("no longer exist" in conflict.reason for conflict in result.conflicts)


def test_generating_a_plan_supersedes_the_previous_open_one(
    session: Session, library_root: Path
) -> None:
    from cairndex.scanning.scanner import scan_library

    _make_movie_folder(library_root)
    scan_library(session, library_root)

    first = plan_store.generate_plan(session)
    second = plan_store.generate_plan(session)

    session.refresh(first)
    assert first.status is GroupingPlanStatus.SUPERSEDED
    assert second.status is GroupingPlanStatus.OPEN
