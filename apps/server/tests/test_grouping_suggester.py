"""Read-only grouping suggester (ADR-0009 phase 2).

Fixtures mirror the ADR's worked examples: a movie folder, a photo folder,
nested containers, a multipart video, covers, subtitles, and an
already-confirmed bundle that the suggester must leave alone.
"""

import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import (
    DEFAULT_STEM_LEVEL,
    FileRole,
    Grouping,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.grouping import (
    FileObservation,
    GroupingProposal,
    ProposalKind,
    suggest_grouping,
)
from cairndex.grouping.service import suggest_for_session
from cairndex.grouping.suggester import max_stem_level
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fast_add import fast_add
from cairndex.scanning.scanner import scan_library


def _f(
    path: str,
    kind: MediaKind,
    *,
    confirmed: bool = False,
    bundle_id: str | None = None,
    bundle_title: str | None = None,
) -> FileObservation:
    return FileObservation(
        asset_file_id=path,  # the path doubles as a stable id in these tests
        relative_path=path,
        media_kind=kind,
        grouping_confirmed=confirmed,
        bundle_id=bundle_id,
        bundle_title=bundle_title,
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
    # Collection suggestions carry no reason: the row already shows the bundles it
    # holds, and the three call sites had each grown their own phrasing for it
    # (owner-reported, 2026-07-29). Bundle reasons are still asserted above.
    assert anna.reason == ""


# One settled bundle no longer claims every new video subject in its directory
def test_confirmed_owner_matches_groups_by_stem_before_directory_fallback() -> None:
    directory = "Western/Nora Vance"
    settled = "Nora Vance - [Lumina.com] - [2023.02.07] - A Walk In The Park - 4K"
    bath = "Nora Vance - [Lumina.com] - [2023.05.09] - Old Barn - 4K"
    private = "Nora Vance - [WEB] - [2023.04.15] - Evening Set 5 [P1A]"
    files = [
        _f(
            f"{directory}/{settled}.mp4",
            MediaKind.VIDEO,
            confirmed=True,
            bundle_id="settled",
            bundle_title=settled,
        ),
        _f(f"{directory}/{bath}.mp4", MediaKind.VIDEO),
        _f(f"{directory}/{bath}.jpg", MediaKind.IMAGE),
        _f(f"{directory}/{private}.mp4", MediaKind.VIDEO),
        _f(f"{directory}/{private}.jpg", MediaKind.IMAGE),
    ]

    plan = suggest_grouping(files)
    bundles = _bundles(plan.proposals)

    assert len(bundles) == 2
    assert not any(bundle.target_bundle_id for bundle in bundles)
    assert {bundle.title for bundle in bundles} == {bath, private}
    assert all(len(bundle.files) == 2 for bundle in bundles)


# A trailing rendition label is a version of an existing stem, not a new title
def test_rendition_suffix_matches_a_confirmed_bundle() -> None:
    directory = "Western/Nora Vance"
    title = "Nora Vance - [WEB] - [2023.04.15] - Evening Set 5 [P1A]"
    plan = suggest_grouping(
        [
            _f(
                f"{directory}/{title}.mp4",
                MediaKind.VIDEO,
                confirmed=True,
                bundle_id="private-show",
                bundle_title=title,
            ),
            _f(f"{directory}/{title} - 720p.mp4", MediaKind.VIDEO),
        ]
    )

    bundles = _bundles(plan.proposals)
    assert len(bundles) == 1
    assert bundles[0].target_bundle_id == "private-show"
    assert bundles[0].target_bundle_title == title


# Sidecar matching must not be quadratic in the size of a folder
def test_a_large_flat_folder_groups_in_linear_time() -> None:
    """A folder of thousands of releases must not cost the square of its size.

    Sidecars were matched by scanning every group for every sidecar, with a nested
    scan over each group's stems inside that — so a single folder of 1,600 subjects
    spent 10.2 million ``startswith`` calls and 4.3 seconds, and a folder of
    several thousand took minutes. Narrow and Widen re-run the whole suggester, so
    the same cost landed on every click (owner-reported, 2026-08-13).

    Asserted as a *ratio* rather than a duration: wall-clock bounds are flaky on a
    shared machine, but quadratic growth shows up as a quadrupling per doubling
    however slow the machine is.
    """

    def folder(subjects: int) -> list[FileObservation]:
        files: list[FileObservation] = []
        for index in range(subjects):
            stem = f"Studio.24.{index % 12 + 1:02d}.{index:04d}.Release.Title"
            files.append(_f(f"Flat/{stem}.mp4", MediaKind.VIDEO))
            files.append(_f(f"Flat/{stem}.jpg", MediaKind.IMAGE))
            files.append(_f(f"Flat/{stem}.en.srt", MediaKind.SUBTITLE))
        return files

    def elapsed(subjects: int) -> float:
        files = folder(subjects)
        start = time.perf_counter()
        plan = suggest_grouping(files)
        taken = time.perf_counter() - start
        # Each subject is still its own bundle: this is about cost, not grouping.
        assert len(_bundles(plan.proposals)) == subjects
        return taken

    small = elapsed(300)
    large = elapsed(1200)

    # Four times the work should cost about four times as much. Quadratic would be
    # sixteen; the bound is loose enough for a noisy machine and nowhere near it.
    assert large < small * 8, f"4x the folder cost {large / small:.1f}x the time"


# The stem level is a dial: widening merges monotonically to a fixed endpoint
def test_widening_the_stem_level_only_ever_merges_and_reaches_one_bundle() -> None:
    directory = "Western/Nora Vance"
    studio_one = "Nora Vance - [Lumina.com] - [2023.02.07] - A Walk In The Park - 4K"
    studio_two = "Nora Vance - [Lumina.com] - [2023.05.09] - Old Barn - 4K"
    web_release = "Nora Vance - [WEB] - [2023.04.15] - Evening Set 5 [P1A]"
    files = [
        _f(f"{directory}/{studio_one}.mp4", MediaKind.VIDEO),
        _f(f"{directory}/{studio_one}.jpg", MediaKind.IMAGE),
        _f(f"{directory}/{studio_two}.mp4", MediaKind.VIDEO),
        _f(f"{directory}/{studio_two}.jpg", MediaKind.IMAGE),
        _f(f"{directory}/{web_release}.mp4", MediaKind.VIDEO),
        _f(f"{directory}/{web_release}.jpg", MediaKind.IMAGE),
    ]
    top = max_stem_level(file.relative_path for file in files)

    plans = [suggest_grouping(files, {directory: level}) for level in range(top + 1)]
    counts = [len(_bundles(plan.proposals)) for plan in plans]

    # The default is unchanged by the move to a dial: three separate releases.
    assert counts[DEFAULT_STEM_LEVEL] == 3
    # Widening never splits. This is the whole promise of a dial, and what three
    # named stops could not offer: "balanced" folded a rendition tag while "wide"
    # switched to an unrelated key, so one step could go either way.
    assert counts == sorted(counts, reverse=True), counts
    # Partway up, the two releases from one studio meet — and they meet each
    # other, not whichever pair happens to shorten at the same rate. Every name in
    # the folder is compared on the same number of leading segments, which is why
    # this dial is absolute rather than "drop one segment from each name".
    merged = next(
        bundle for plan in plans for bundle in _bundles(plan.proposals) if len(bundle.files) == 4
    )
    assert {file.asset_file_id for file in merged.files} == {
        f"{directory}/{studio_one}.mp4",
        f"{directory}/{studio_one}.jpg",
        f"{directory}/{studio_two}.mp4",
        f"{directory}/{studio_two}.jpg",
    }
    # And the top of the dial is genuinely the top: every name is down to its
    # first segment, so there is nothing left to widen.
    assert counts[top] == 1
    assert plans[top].stem_levels == {directory: top}


# Level 0 is the complete stem, renditions included; the default folds them
def test_level_zero_keeps_renditions_of_one_title_apart() -> None:
    files = [
        _f("Versions/Movie.mp4", MediaKind.VIDEO),
        _f("Versions/Movie.jpg", MediaKind.IMAGE),
        _f("Versions/Movie - 720p.mp4", MediaKind.VIDEO),
        _f("Versions/Movie - 720p.jpg", MediaKind.IMAGE),
    ]

    assert len(_bundles(suggest_grouping(files, {"Versions": 0}).proposals)) == 2
    assert len(_bundles(suggest_grouping(files).proposals)) == 1
    # Nothing to widen: every folded stem is already one segment, so the dial
    # for this folder ends at the default and Widen has to be offered as spent.
    assert max_stem_level(file.relative_path for file in files) == DEFAULT_STEM_LEVEL


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


# Missing rows stay repairable without entering fresh grouping proposals
def test_suggest_for_session_excludes_files_marked_missing(
    session: Session, library_root: Path
) -> None:
    present = library_root / "present.mp4"
    stale = library_root / "stale.mp4"
    present.write_text("video")
    stale.write_text("video")
    scan_library(session, library_root)
    stale.unlink()
    scan_library(session, library_root)

    plan = suggest_for_session(session)
    path_by_id = dict(session.execute(select(AssetFile.id, AssetFile.relative_path)).all())
    suggested_paths = {
        path_by_id[file.asset_file_id]
        for proposal in _bundles(plan.proposals)
        for file in proposal.files
    }

    assert suggested_paths == {"present.mp4"}


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


# --- Bundle titles come from the shared filename part ------------------------
def test_prefix_grouped_bundle_is_titled_by_the_shared_stem() -> None:
    """A bundle formed by matching a prefix must not be named after one member.

    Reported with a real group of four: the title was
    "StudioAlpha.19.12.20.Lead.Player.#2.Session.Behind.The.Scenes", carrying
    the first file's tail and implying the rest were behind-the-scenes clips.
    """
    files = [
        _f(f"Scenes/{name}", MediaKind.VIDEO)
        for name in (
            "StudioAlpha.19.12.20.Lead.Player.#2.Session.Behind.The.Scenes.mp4",
            "StudioAlpha.19.12.20.Lead.Player.#2.Session.mp4",
            "StudioAlpha.19.12.27.Lead.Player.#2.Guest.Player.mp4",
            "StudioAlpha.19.12.27.Lead.Player.#2.Session.Interview.mp4",
            # A second subject, so the four above are one bundle *among several*
            # rather than filling the folder — a bundle that owns its folder is
            # titled by the folder, which is not the reported case.
            "SomethingElse.21.05.09.Other.Title.mp4",
        )
    ]

    # Widened to where the four dated releases meet: they agree on their first
    # three segments only, and this folder's dial tops out at eleven, so level 9
    # is the rung that compares three (``max - level + 1``).
    plan = suggest_grouping(files, stem_levels={"Scenes": 9})
    bundle = next(p for p in _bundles(plan.proposals) if len(p.files) == 4)
    # The shared part, trimmed to a delimiter so it never ends mid-token.
    assert bundle.title == "StudioAlpha.19.12"


def test_multipart_bundle_drops_the_part_marker_from_its_title() -> None:
    """The old rule titled a three-part video "Trip.part1"."""
    files = [_f(f"Box/Trip/Trip.part{index}.mp4", MediaKind.VIDEO) for index in (1, 2, 3)]
    files.append(_f("Box/Trip/extra.jpg", MediaKind.IMAGE))

    plan = suggest_grouping(files)
    trip = next(p for p in _bundles(plan.proposals) if len(p.files) == 4)
    # Not "Trip.part1": the parts share "Trip.part", trimmed back to "Trip".
    assert trip.title == "Trip"


def test_single_subject_bundle_keeps_its_own_filename() -> None:
    """One video with sidecars is titled by the video, not a shared fragment."""
    files = [
        _f("Box/cosmos.mp4", MediaKind.VIDEO),
        _f("Box/cosmos.en.srt", MediaKind.SUBTITLE),
        _f("Box/other.mp4", MediaKind.VIDEO),
    ]

    plan = suggest_grouping(files)
    cosmos = next(p for p in _bundles(plan.proposals) if len(p.files) == 2)
    assert cosmos.title == "cosmos"


def test_addition_sits_inside_the_collection_its_folder_becomes() -> None:
    """An addition belongs where its files live, like any other suggestion.

    Reported: an "Add to …" row sat at the top level, outside the very collection
    its own folder was being proposed as, reading as unrelated to its siblings.
    """
    confirmed = _f(
        "Studios/StudioAlpha/StudioAlpha.19.12.20.Lead.Player.mp4",
        MediaKind.VIDEO,
        confirmed=True,
        bundle_id="bundle-1",
        bundle_title="StudioAlpha - Lead Player - #1",
    )
    # A sidecar for the confirmed bundle -> an addition to it.
    addition = _f("Studios/StudioAlpha/StudioAlpha.19.12.20.Lead.Player.srt", MediaKind.SUBTITLE)
    # Two unrelated subjects in the same folder, so the folder is a collection.
    others = [
        _f("Studios/StudioAlpha/Alpha.Title.mp4", MediaKind.VIDEO),
        _f("Studios/StudioAlpha/Beta.Title.mp4", MediaKind.VIDEO),
    ]

    plan = suggest_grouping([confirmed, addition, *others])

    container = next(p for p in _containers(plan.proposals) if p.directory == "Studios/StudioAlpha")
    added = next(p for p in plan.proposals if p.target_bundle_id == "bundle-1")
    assert added.parent_directory == container.directory


def test_addition_with_no_enclosing_collection_stays_at_the_top_level() -> None:
    """Nothing to nest inside, so the previous behaviour is still right."""
    confirmed = _f(
        "Solo/movie.mp4", MediaKind.VIDEO, confirmed=True, bundle_id="b", bundle_title="Movie"
    )
    addition = _f("Solo/movie.en.srt", MediaKind.SUBTITLE)

    plan = suggest_grouping([confirmed, addition])

    added = next(p for p in plan.proposals if p.target_bundle_id == "b")
    assert added.parent_directory is None
