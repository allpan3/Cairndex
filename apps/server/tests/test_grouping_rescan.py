"""Re-scan additions suggested into confirmed bundles (ADR-0009 phase 5)."""

from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, ValidationError
from cairndex.domain.enums import FileRole, GroupingState
from cairndex.grouping import ProposalKind, plan_store
from cairndex.grouping import apply as apply_service
from cairndex.grouping.service import suggest_for_session
from cairndex.persistence.models import AssetBundle, AssetFile, Collection, SubtitleTrack
from cairndex.scanning.scanner import scan_library


def _confirm_movie_folder(session: Session, root: Path) -> str:
    """Scan a movie folder and apply the plan so its bundle is confirmed."""
    (root / "Cosmos").mkdir()
    (root / "Cosmos" / "cosmos.mp4").write_text("v")
    (root / "Cosmos" / "poster.jpg").write_text("i")
    scan_library(session, root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    return session.scalars(select(AssetBundle)).one().id


# Stage one video/image addition in the confirmed owner's directory
def _scan_sequel(session: Session, root: Path) -> set[str]:
    """Scan a new video/image pair into provisional bundles in the owned folder."""
    (root / "Cosmos" / "sequel.mp4").write_text("v2")
    (root / "Cosmos" / "sequel.jpg").write_text("i2")
    scan_library(session, root)
    return set(
        session.scalars(
            select(AssetFile.id).where(
                AssetFile.relative_path.in_(["Cosmos/sequel.mp4", "Cosmos/sequel.jpg"])
            )
        )
    )


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
    assert additions[0].target_bundle_title == "Cosmos"
    assert additions[0].create_new_bundle is False
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


# A reviewed override creates a separate bundle and preserves the target
def test_addition_can_create_a_new_bundle_without_touching_the_target(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)
    original = session.get(AssetBundle, bundle_id)
    assert original is not None
    original_file_ids = {file.id for file in original.files}
    new_file_ids = _scan_sequel(session, library_root)
    plan = plan_store.generate_plan(session)
    addition = next(proposal for proposal in plan.proposals if proposal.target_bundle_id)

    with pytest.raises(ValidationError, match="titles cannot be changed"):
        plan_store.rename_proposal(session, plan.id, addition.id, "Not Yet Renameable")
    switched = plan_store.set_proposal_destination(session, plan.id, addition.id, True)
    assert switched.create_new_bundle is True
    assert switched.title == "sequel"
    assert [file.proposed_role for file in switched.files] == [
        FileRole.PRIMARY_VIDEO,
        FileRole.COVER,
    ]
    plan_store.rename_proposal(session, plan.id, addition.id, "Sequel Cut")
    result = apply_service.apply_plan(session, plan)

    assert result.bundles_confirmed == 1
    original = session.get(AssetBundle, bundle_id)
    assert original is not None
    assert {file.id for file in original.files} == original_file_ids
    created = session.scalar(select(AssetBundle).where(AssetBundle.title == "Sequel Cut"))
    assert created is not None and created.id != bundle_id
    assert {file.id for file in created.files} == new_file_ids
    assert created.cover_file_id == next(
        file.id for file in created.files if file.relative_path == "Cosmos/sequel.jpg"
    )


# A new-bundle override keeps the confirmed target's existing collection context
def test_new_bundle_override_reuses_the_target_collection(
    session: Session, library_root: Path
) -> None:
    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    scan_library(session, library_root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    movies = session.scalars(select(Collection).where(Collection.name == "Movies")).one()
    target = session.scalars(select(AssetBundle)).one()
    assert movies in target.collections

    (library_root / "Movies" / "Cosmos" / "sequel.mp4").write_text("v2")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)
    addition = next(proposal for proposal in plan.proposals if proposal.target_bundle_id)
    parent = session.get(type(addition), addition.parent_proposal_id)
    assert parent is not None and parent.title == "Movies"

    plan_store.set_proposal_destination(session, plan.id, addition.id, True)
    plan_store.rename_proposal(session, plan.id, addition.id, "Sequel")
    result = apply_service.apply_plan(session, plan)

    assert result.collections_created == 0
    created = session.scalars(select(AssetBundle).where(AssetBundle.title == "Sequel")).one()
    assert movies in created.collections


# A direct fresh file reuses a matching collection hidden by confirmed siblings
def test_fresh_bundle_reuses_an_existing_same_path_collection(
    session: Session, library_root: Path
) -> None:
    (library_root / "Series").mkdir()
    (library_root / "Series" / "alpha.mp4").write_text("a")
    (library_root / "Series" / "beta.mp4").write_text("b")
    scan_library(session, library_root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    series = session.scalars(select(Collection).where(Collection.name == "Series")).one()

    (library_root / "Series" / "gamma.mp4").write_text("g")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)
    gamma = next(proposal for proposal in plan.proposals if proposal.kind is ProposalKind.BUNDLE)
    parent = session.get(type(gamma), gamma.parent_proposal_id)
    assert parent is not None and parent.title == "Series"

    result = apply_service.apply_plan(session, plan)

    assert result.collections_created == 0
    created = session.scalars(select(AssetBundle).where(AssetBundle.title == "Series")).one()
    assert series in created.collections


# Switching retains the edited title and upgrades legacy open-plan snapshots
def test_destination_switch_is_reversible_and_backfills_a_legacy_plan(
    session: Session, library_root: Path
) -> None:
    bundle_id = _confirm_movie_folder(session, library_root)
    _scan_sequel(session, library_root)
    plan = plan_store.generate_plan(session)
    addition = next(proposal for proposal in plan.proposals if proposal.target_bundle_id)
    addition.target_bundle_title = None
    addition.title = "Cosmos"
    session.flush()

    switched = plan_store.set_proposal_destination(session, plan.id, addition.id, True)
    assert switched.target_bundle_title == "Cosmos"
    assert switched.title == "sequel"
    plan_store.rename_proposal(session, plan.id, addition.id, "Remembered Sequel")

    restored = plan_store.set_proposal_destination(session, plan.id, addition.id, False)
    assert restored.title == "Remembered Sequel"
    assert [file.proposed_role for file in restored.files] == [
        FileRole.VIDEO_PART,
        FileRole.IMAGE,
    ]
    assert plan_store.set_proposal_destination(session, plan.id, addition.id, True).title == (
        "Remembered Sequel"
    )

    target = session.get(AssetBundle, bundle_id)
    assert target is not None
    session.delete(target)
    session.flush()
    with pytest.raises(ConflictError, match="no longer available"):
        plan_store.set_proposal_destination(session, plan.id, addition.id, False)

    result = apply_service.apply_plan(session, plan)
    assert result.bundles_confirmed == 1
    assert session.scalar(select(AssetBundle).where(AssetBundle.title == "Remembered Sequel"))


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


# An addition surfaces inside the collection its target bundle already belongs to
def test_addition_nests_under_the_targets_collection_not_its_folder(
    session: Session, library_root: Path
) -> None:
    """The reported shape: the bundle's collection does not mirror its folder.

    A bundle whose files sit in ``Studios/`` but which the owner filed under the
    nested ``Studios/StudioAlpha`` collection. Its addition surfaced under
    **Studios** — outside the collection it was joining — because membership
    candidates were re-ranked by whether the collection's name path also prefixed
    the proposal's directory, and only the shallow "Studios" could match a
    one-segment folder.
    """
    studios_dir = library_root / "Studios"
    nested = studios_dir / "StudioAlpha"
    nested.mkdir(parents=True)
    (studios_dir / "sceneone.mp4").write_text("v")
    (nested / "scenetwo.mp4").write_text("v")
    (nested / "scenethree.mp4").write_text("v")
    scan_library(session, library_root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))

    studios = session.scalars(select(Collection).where(Collection.name == "Studios")).one()
    premium = session.scalars(select(Collection).where(Collection.name == "StudioAlpha")).one()
    target = next(
        bundle
        for bundle in session.scalars(select(AssetBundle))
        if any(file.relative_path == "Studios/sceneone.mp4" for file in bundle.files)
    )
    # Filed under both the parent and the nested collection — the shape that
    # exposed the bug, since only the shallow "Studios" can prefix-match a
    # one-segment folder, so it used to win despite being the less specific place.
    target.collections.clear()
    target.collections.extend([studios, premium])
    session.flush()
    assert premium.parent_id == studios.id

    (studios_dir / "sceneone.bts.mp4").write_text("v2")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    addition = next(p for p in plan.proposals if p.target_bundle_id == target.id)
    parent = session.get(type(addition), addition.parent_proposal_id)
    assert parent is not None, "the addition should be nested, not left at the top level"
    assert parent.title == "StudioAlpha"


def test_addition_nests_with_its_siblings_from_the_same_folder(
    session: Session, library_root: Path
) -> None:
    """The reported layout: everything in one folder, addition included.

    The folder-derived parent is not enough here. Once the folder's remaining
    fresh files form a single bundle it *owns* that folder, so no collection
    suggestion exists for it and walking up lands on the grandparent — "Studios".
    The target bundle's membership is what knows better, and it was being ignored
    for any suggestion that already had a parent.
    """
    folder = library_root / "Studios" / "StudioAlpha"
    folder.mkdir(parents=True)
    for name in ("sceneone", "scenetwo", "scenethree"):
        (folder / f"{name}.mp4").write_text("v")
    scan_library(session, library_root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    premium = session.scalars(select(Collection).where(Collection.name == "StudioAlpha")).one()
    target = session.scalars(select(AssetBundle).where(AssetBundle.title == "sceneone")).one()
    assert premium in target.collections

    # A new file for the confirmed bundle, plus an unrelated new subject that
    # takes over the folder — which is what pushes the folder-derived parent up.
    (folder / "sceneone.bts.mp4").write_text("v")
    (folder / "brandnew.mp4").write_text("v")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    addition = next(p for p in plan.proposals if p.target_bundle_id == target.id)
    parent = session.get(type(addition), addition.parent_proposal_id)
    assert parent is not None and parent.title == "StudioAlpha"


def test_addition_still_falls_back_to_its_folder_without_a_membership(
    session: Session, library_root: Path
) -> None:
    """No collection to inherit, so where the files live still decides."""
    folder = library_root / "Loose"
    folder.mkdir()
    (folder / "movie.mp4").write_text("v")
    scan_library(session, library_root)
    apply_service.apply_plan(session, plan_store.generate_plan(session))
    target = session.scalars(select(AssetBundle)).one()
    target.collections.clear()
    session.flush()

    (folder / "movie.en.srt").write_text("s")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)

    addition = next(p for p in plan.proposals if p.target_bundle_id == target.id)
    assert addition.parent_proposal_id is None
