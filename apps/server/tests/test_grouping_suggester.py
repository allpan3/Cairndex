"""Read-only grouping suggester (ADR-0009 phase 2).

Fixtures mirror the ADR's worked examples: a movie folder, a photo folder,
nested containers, a multipart video, covers, subtitles, and an
already-confirmed bundle that the suggester must leave alone.
"""

from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, Grouping, GroupingSource, GroupingState, MediaKind
from cairndex.grouping import (
    FileObservation,
    GroupingProposal,
    ProposalKind,
    suggest_grouping,
)
from cairndex.grouping.service import suggest_for_session
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fast_add import fast_add
from cairndex.scanning.scanner import scan_library


def _f(path: str, kind: MediaKind, *, confirmed: bool = False) -> FileObservation:
    return FileObservation(
        asset_file_id=path,  # the path doubles as a stable id in these tests
        relative_path=path,
        media_kind=kind,
        grouping_confirmed=confirmed,
    )


def _bundles(proposals: tuple[GroupingProposal, ...]) -> list[GroupingProposal]:
    return [p for p in proposals if p.kind is ProposalKind.BUNDLE]


def _containers(proposals: tuple[GroupingProposal, ...]) -> list[GroupingProposal]:
    return [p for p in proposals if p.kind is ProposalKind.CONTAINER]


def _roles(p: GroupingProposal) -> dict[str, FileRole]:
    return {pf.asset_file_id: pf.role for pf in p.files}


def test_movie_folder_is_one_bundle_with_roles() -> None:
    plan = suggest_grouping(
        [
            _f("Cosmos/cosmos.mp4", MediaKind.VIDEO),
            _f("Cosmos/poster.jpg", MediaKind.IMAGE),
            _f("Cosmos/cosmos.en.srt", MediaKind.SUBTITLE),
        ]
    )
    bundles = _bundles(plan.proposals)
    assert len(bundles) == 1
    assert not _containers(plan.proposals)
    bundle = bundles[0]
    assert bundle.directory == "Cosmos"
    assert bundle.title == "Cosmos"
    roles = _roles(bundle)
    assert roles["Cosmos/cosmos.mp4"] is FileRole.PRIMARY_VIDEO
    assert roles["Cosmos/poster.jpg"] is FileRole.COVER
    assert roles["Cosmos/cosmos.en.srt"] is FileRole.SUBTITLE


# Default sequence favors openable media while preserving natural order within groups
def test_bundle_sequence_is_video_then_audio_then_image_then_other() -> None:
    plan = suggest_grouping(
        [
            _f("Epic/work.part2.mkv", MediaKind.VIDEO),
            _f("Epic/track2.mp3", MediaKind.AUDIO),
            _f("Epic/work.en.srt", MediaKind.SUBTITLE),
            _f("Epic/poster.jpg", MediaKind.IMAGE),
            _f("Epic/notes.pdf", MediaKind.OTHER),
            _f("Epic/track1.flac", MediaKind.AUDIO),
            _f("Epic/work.part1.mkv", MediaKind.VIDEO),
        ]
    )

    bundle = _bundles(plan.proposals)[0]
    assert [proposed.asset_file_id for proposed in bundle.files] == [
        "Epic/work.part1.mkv",
        "Epic/work.part2.mkv",
        "Epic/track1.flac",
        "Epic/track2.mp3",
        "Epic/poster.jpg",
        "Epic/notes.pdf",
        "Epic/work.en.srt",
    ]
    assert [proposed.sequence for proposed in bundle.files] == list(range(7))


# Multi-video folders attach sidecars by normalized filename subject prefix
def test_multi_subject_folder_groups_sidecars_by_delimited_prefix() -> None:
    plan = suggest_grouping(
        [
            _f("Movies/cosmos.mp4", MediaKind.VIDEO),
            _f("Movies/cosmos.en.srt", MediaKind.SUBTITLE),
            _f("Movies/cosmos-poster.jpg", MediaKind.IMAGE),
            _f("Movies/waves.mp4", MediaKind.VIDEO),
            _f("Movies/waves.en.srt", MediaKind.SUBTITLE),
        ]
    )

    bundles = _bundles(plan.proposals)
    assert len(bundles) == 2
    by_title = {b.title: b for b in bundles}
    assert set(by_title) == {"cosmos", "waves"}
    assert {pf.asset_file_id for pf in by_title["cosmos"].files} == {
        "Movies/cosmos.mp4",
        "Movies/cosmos.en.srt",
        "Movies/cosmos-poster.jpg",
    }
    assert {pf.asset_file_id for pf in by_title["waves"].files} == {
        "Movies/waves.mp4",
        "Movies/waves.en.srt",
    }
    assert _roles(by_title["cosmos"])["Movies/cosmos-poster.jpg"] is FileRole.COVER
    assert _roles(by_title["waves"])["Movies/waves.en.srt"] is FileRole.SUBTITLE


# Full stems disambiguate sidecars when long video names share a leading token
def test_multi_subject_folder_pairs_images_by_complete_filename_stem() -> None:
    beach = "Nora Vance - [Lumina.com] - [2023] - Surf On The Ridge - 4K"
    sea = "Nora Vance - [Lumina.com] - [2023] - Sky, Sand, Sea & Salt - 4K"
    plan = suggest_grouping(
        [
            _f(f"Western/Nora Vance/{beach}.mp4", MediaKind.VIDEO),
            _f(f"Western/Nora Vance/{sea}.mp4", MediaKind.VIDEO),
            _f(f"Western/Nora Vance/{beach}.jpg", MediaKind.IMAGE),
            _f(f"Western/Nora Vance/{sea}.jpg", MediaKind.IMAGE),
        ]
    )

    bundles = _bundles(plan.proposals)
    assert len(bundles) == 2
    by_title = {bundle.title: bundle for bundle in bundles}
    assert set(by_title) == {beach, sea}
    for title, bundle in by_title.items():
        assert {file.asset_file_id for file in bundle.files} == {
            f"Western/Nora Vance/{title}.mp4",
            f"Western/Nora Vance/{title}.jpg",
        }
        assert _roles(bundle)[f"Western/Nora Vance/{title}.jpg"] is FileRole.COVER
        assert bundle.reason == "one video with 1 sidecar file(s)"

    anna = next(
        proposal
        for proposal in plan.proposals
        if proposal.kind is ProposalKind.CONTAINER and proposal.directory == "Western/Nora Vance"
    )
    assert anna.reason == "2 filename-matched bundle(s) from 4 files"


# Image-only folders remain item collections even when camera prefixes match
def test_photo_folder_with_shared_prefix_does_not_collapse() -> None:
    plan = suggest_grouping(
        [
            _f("Photos/IMG-0001.jpg", MediaKind.IMAGE),
            _f("Photos/IMG-0002.jpg", MediaKind.IMAGE),
            _f("Photos/IMG-0003.jpg", MediaKind.IMAGE),
        ]
    )

    containers = _containers(plan.proposals)
    bundles = _bundles(plan.proposals)
    assert len(containers) == 1
    assert containers[0].directory == "Photos"
    assert len(bundles) == 3
    assert all(len(p.files) == 1 for p in bundles)


def test_cover_named_image_wins_over_first_image() -> None:
    plan = suggest_grouping(
        [
            _f("Show/aaa.jpg", MediaKind.IMAGE),
            _f("Show/cover.jpg", MediaKind.IMAGE),
            _f("Show/show.mkv", MediaKind.VIDEO),
        ]
    )
    bundle = _bundles(plan.proposals)[0]
    roles = _roles(bundle)
    assert roles["Show/cover.jpg"] is FileRole.COVER
    assert roles["Show/aaa.jpg"] is FileRole.IMAGE


def test_photo_folder_is_a_container_of_single_file_bundles() -> None:
    plan = suggest_grouping(
        [
            _f("Photos/beach.jpg", MediaKind.IMAGE),
            _f("Photos/sunset.png", MediaKind.IMAGE),
            _f("Photos/mountains.jpg", MediaKind.IMAGE),
        ]
    )
    containers = _containers(plan.proposals)
    bundles = _bundles(plan.proposals)
    assert len(containers) == 1
    assert containers[0].directory == "Photos"
    assert len(bundles) == 3
    assert all(p.parent_directory == "Photos" for p in bundles)
    assert all(len(p.files) == 1 for p in bundles)


def test_multipart_video_is_one_bundle_with_video_parts() -> None:
    plan = suggest_grouping(
        [
            _f("Epic/epic.part1.mkv", MediaKind.VIDEO),
            _f("Epic/epic.part2.mkv", MediaKind.VIDEO),
            _f("Epic/cover.jpg", MediaKind.IMAGE),
        ]
    )
    bundles = _bundles(plan.proposals)
    assert len(bundles) == 1
    roles = _roles(bundles[0])
    assert roles["Epic/epic.part1.mkv"] is FileRole.VIDEO_PART
    assert roles["Epic/epic.part2.mkv"] is FileRole.VIDEO_PART
    assert roles["Epic/cover.jpg"] is FileRole.COVER
    # Sequence keeps natural order within the video group
    seq = {pf.asset_file_id: pf.sequence for pf in bundles[0].files}
    assert seq["Epic/epic.part1.mkv"] < seq["Epic/epic.part2.mkv"]


def test_nested_containers_recurse() -> None:
    plan = suggest_grouping(
        [
            _f("Movies/Cosmos/cosmos.mp4", MediaKind.VIDEO),
            _f("Movies/Cosmos/poster.jpg", MediaKind.IMAGE),
            _f("Movies/Waves/waves.mp4", MediaKind.VIDEO),
        ]
    )
    containers = _containers(plan.proposals)
    bundles = _bundles(plan.proposals)
    assert [c.directory for c in containers] == ["Movies"]
    assert containers[0].parent_directory is None
    assert {b.directory for b in bundles} == {"Movies/Cosmos", "Movies/Waves"}
    assert all(b.parent_directory == "Movies" for b in bundles)


def test_confirmed_files_are_excluded() -> None:
    plan = suggest_grouping(
        [
            _f("Old/old.mp4", MediaKind.VIDEO, confirmed=True),
            _f("Old/old.jpg", MediaKind.IMAGE, confirmed=True),
            _f("New/new.mp4", MediaKind.VIDEO),
        ]
    )
    bundles = _bundles(plan.proposals)
    assert len(bundles) == 1
    assert bundles[0].directory == "New"


def test_loose_root_files_become_top_level_bundles() -> None:
    plan = suggest_grouping(
        [
            _f("a.mp4", MediaKind.VIDEO),
            _f("b.mkv", MediaKind.VIDEO),
        ]
    )
    bundles = _bundles(plan.proposals)
    assert not _containers(plan.proposals)
    assert len(bundles) == 2
    assert all(b.parent_directory is None for b in bundles)


def test_empty_input_is_empty_plan() -> None:
    plan = suggest_grouping([])
    assert plan.proposals == ()


# --- DB adapter (read-only) over a real scan --------------------------------


def test_suggest_for_session_over_a_scanned_movie_folder(
    session: Session, library_root: Path
) -> None:
    (library_root / "Cosmos").mkdir()
    (library_root / "Cosmos" / "cosmos.mp4").write_text("video")
    (library_root / "Cosmos" / "poster.jpg").write_text("image")
    (library_root / "Cosmos" / "cosmos.en.srt").write_text("subs")
    scan_library(session, library_root)  # creates three provisional bundles

    plan = suggest_for_session(session)
    bundles = _bundles(plan.proposals)
    assert len(bundles) == 1  # the suggester re-groups the over-fragmented scan
    assert {pf.role for pf in bundles[0].files} == {
        FileRole.PRIMARY_VIDEO,
        FileRole.COVER,
        FileRole.SUBTITLE,
    }


# Hidden cache files are not grouping candidates
def test_suggest_for_session_excludes_hidden_paths(session: Session) -> None:
    hidden = AssetBundle(
        title="thumb",
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    visible = AssetBundle(
        title="cosmos",
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add_all([hidden, visible])
    session.flush()
    session.add_all(
        [
            AssetFile(
                bundle_id=hidden.id,
                relative_path=".cairndex/cache/thumbnails/01/thumb.jpg",
                original_filename="thumb.jpg",
                display_title="thumb.jpg",
                role=FileRole.COVER,
                media_kind=MediaKind.IMAGE,
            ),
            AssetFile(
                bundle_id=visible.id,
                relative_path="Movies/Cosmos/cosmos.mp4",
                original_filename="cosmos.mp4",
                display_title="cosmos.mp4",
                role=FileRole.PRIMARY_VIDEO,
                media_kind=MediaKind.VIDEO,
            ),
        ]
    )
    session.commit()

    plan = suggest_for_session(session)

    directories = {p.directory for p in plan.proposals}
    assert ".cairndex" not in directories
    assert directories == {"Movies", "Movies/Cosmos"}


def test_suggest_for_session_excludes_confirmed_bundles(
    session: Session, library_root: Path
) -> None:
    (library_root / "keep.mp4").write_text("video")
    (library_root / "decided.mp4").write_text("video")
    # Confirm one grouping via fast-add; scan the rest as provisional.
    fast_add(session, paths=["decided.mp4"], grouping=Grouping.PER_FILE)
    scan_library(session, library_root)

    plan = suggest_for_session(session)
    suggested_files = {pf.asset_file_id for b in _bundles(plan.proposals) for pf in b.files}
    relative_paths = {p.directory for p in plan.proposals}
    # The confirmed file is excluded; only the provisional "keep.mp4" is open.
    assert relative_paths == {""}
    assert len(suggested_files) == 1
