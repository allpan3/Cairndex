"""Manual bundling assistant: unbundled staging, suggestions, and metadata-only
confirm mutations (Unbundled staging follow-up to ADR-0009)."""

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import (
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.manual_bundling import apply as apply_service
from cairndex.manual_bundling import suggest as suggest_service
from cairndex.persistence.models import AssetBundle, AssetFile, SubtitleTrack
from cairndex.services import bundles as bundle_service

_KIND_BY_EXT = {
    "mp4": MediaKind.VIDEO,
    "mkv": MediaKind.VIDEO,
    "jpg": MediaKind.IMAGE,
    "png": MediaKind.IMAGE,
    "srt": MediaKind.SUBTITLE,
}


def _unbundled(session: Session, relative_path: str) -> AssetFile:
    """A scan-staged provisional one-file bundle (an "unbundled" file)."""
    ext = relative_path.rsplit(".", 1)[-1].lower()
    kind = _KIND_BY_EXT.get(ext, MediaKind.OTHER)
    name = relative_path.rsplit("/", 1)[-1]
    bundle = AssetBundle(
        # The scanner titles a provisional one-file bundle with the file stem.
        title=name.rsplit(".", 1)[0],
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(bundle)
    session.flush()
    row = AssetFile(
        bundle_id=bundle.id,
        relative_path=relative_path,
        original_filename=relative_path.rsplit("/", 1)[-1],
        display_title=relative_path.rsplit("/", 1)[-1],
        role=FileRole.OTHER,
        media_kind=kind,
        size_bytes=1,
    )
    session.add(row)
    session.flush()
    return row


def _confirmed_with_video(session: Session, title: str, relative_path: str) -> AssetBundle:
    bundle = bundle_service.create_bundle(session, title=title)
    bundle_service.add_file(
        session,
        bundle.id,
        relative_path=relative_path,
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    return bundle


# --- create empty ------------------------------------------------------------
def test_create_empty_bundle(session: Session) -> None:
    result = apply_service.create_empty_bundle(session, title="  Holiday 2024 ")
    bundle = session.get(AssetBundle, result.bundle_id)
    assert bundle is not None
    assert result.created is True and result.files_added == 0
    assert bundle.title == "Holiday 2024"
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.grouping_source is GroupingSource.MANUAL
    assert bundle.confirmed_at is not None


# --- create from unbundled ---------------------------------------------------
def test_create_bundle_from_single_file(session: Session) -> None:
    clip = _unbundled(session, "loose/clip.mp4")
    provisional_bundle_id = clip.bundle_id
    session.commit()

    result = apply_service.create_bundle_from_unbundled(session, [clip.id])

    # The provisional bundle is reused (id preserved) and confirmed in place.
    assert result.bundle_id == provisional_bundle_id
    assert result.created is True and result.bundles_removed == 0
    bundle = session.get(AssetBundle, result.bundle_id)
    assert bundle is not None
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.grouping_source is GroupingSource.MANUAL
    assert bundle.title == "clip"  # derived from the file stem
    reloaded = session.get(AssetFile, clip.id)
    assert reloaded is not None and reloaded.bundle_id == bundle.id
    assert bundle.primary_file_id == clip.id


def test_create_bundle_from_multiple_files_merges_and_reaps(session: Session) -> None:
    video = _unbundled(session, "movie/feature.mp4")
    cover = _unbundled(session, "movie/cover.jpg")
    sub = _unbundled(session, "movie/feature.srt")
    source_ids = {video.bundle_id, cover.bundle_id, sub.bundle_id}
    assert len(source_ids) == 3
    session.commit()

    result = apply_service.create_bundle_from_unbundled(
        session, [video.id, cover.id, sub.id], title="Feature Film"
    )

    bundle = session.get(AssetBundle, result.bundle_id)
    assert bundle is not None and bundle.title == "Feature Film"
    assert result.files_added == 3
    # Two of the three provisional source bundles are emptied and removed.
    assert result.bundles_removed == 2
    remaining = session.scalars(select(AssetFile.id).where(AssetFile.bundle_id == bundle.id)).all()
    assert set(remaining) == {video.id, cover.id, sub.id}
    # Role heuristic: cover image → cover, video → primary.
    assert bundle.primary_file_id == video.id
    assert bundle.cover_file_id == cover.id
    # No stray provisional bundles left behind.
    assert (
        session.scalar(
            select(AssetBundle.id).where(AssetBundle.grouping_state == GroupingState.PROVISIONAL)
        )
        is None
    )


def test_subtitle_autolink_runs_after_create(session: Session) -> None:
    video = _unbundled(session, "show/ep01.mp4")
    sub = _unbundled(session, "show/ep01.srt")
    session.commit()

    result = apply_service.create_bundle_from_unbundled(session, [video.id, sub.id])

    assert result.subtitles_linked == 1
    track = session.scalar(select(SubtitleTrack).where(SubtitleTrack.bundle_id == result.bundle_id))
    assert track is not None
    assert track.source_file_id == sub.id and track.video_file_id == video.id


# --- add to existing confirmed bundle ----------------------------------------
def test_add_unbundled_files_to_bundle(session: Session) -> None:
    bundle = _confirmed_with_video(session, "Show", "show/ep01.mp4")
    extra = _unbundled(session, "show/ep01.srt")
    provisional_bundle_id = extra.bundle_id
    session.commit()

    result = apply_service.add_unbundled_files_to_bundle(session, bundle.id, [extra.id])

    assert result.files_added == 1 and result.bundles_removed == 1
    assert result.subtitles_linked == 1  # subtitle auto-linked to the video
    reloaded = session.get(AssetFile, extra.id)
    assert reloaded is not None and reloaded.bundle_id == bundle.id
    assert reloaded.role is FileRole.SUBTITLE
    # Appended after the existing file.
    assert reloaded.sequence >= 1
    # The emptied provisional source bundle is gone.
    assert session.get(AssetBundle, provisional_bundle_id) is None


def test_add_requires_confirmed_target(session: Session) -> None:
    provisional = _unbundled(session, "a/x.mp4")
    extra = _unbundled(session, "a/y.jpg")
    session.commit()
    with pytest.raises(ValidationError, match="confirmed"):
        apply_service.add_unbundled_files_to_bundle(session, provisional.bundle_id, [extra.id])


def test_add_rejects_files_from_confirmed_bundle(session: Session) -> None:
    target = _confirmed_with_video(session, "Target", "t/a.mp4")
    other = _confirmed_with_video(session, "Other", "o/b.mp4")
    other_file = other.files[0]
    session.commit()
    with pytest.raises(ValidationError, match="unbundled"):
        apply_service.add_unbundled_files_to_bundle(session, target.id, [other_file.id])


def test_confirmed_bundle_not_disturbed_by_manual_create(session: Session) -> None:
    confirmed = _confirmed_with_video(session, "Keep Me", "keep/movie.mp4")
    keep_file_id = confirmed.files[0].id
    loose = _unbundled(session, "other/clip.mp4")
    session.commit()

    apply_service.create_bundle_from_unbundled(session, [loose.id])

    reloaded = session.get(AssetBundle, confirmed.id)
    assert reloaded is not None
    assert reloaded.grouping_state is GroupingState.CONFIRMED
    assert [f.id for f in reloaded.files] == [keep_file_id]


def test_operations_are_metadata_only(session: Session) -> None:
    """Paths and file ids never change — only bundle membership/metadata does."""
    video = _unbundled(session, "dir/movie.mp4")
    cover = _unbundled(session, "dir/cover.jpg")
    before = {f.id: f.relative_path for f in session.scalars(select(AssetFile)).all()}
    session.commit()

    apply_service.create_bundle_from_unbundled(session, [video.id, cover.id])

    after = {f.id: f.relative_path for f in session.scalars(select(AssetFile)).all()}
    assert after == before  # same ids, same on-disk paths


# --- paths-in (auto-link) from File View -------------------------------------
def test_create_bundle_from_relative_paths_autolinks_unlinked(
    session: Session, library_root: Path
) -> None:
    """A File-View path with no AssetFile row is staged then confirmed."""
    (library_root / "clips").mkdir()
    (library_root / "clips" / "a.mp4").write_text("v")
    (library_root / "clips" / "b.mp4").write_text("v")
    session.commit()

    result = apply_service.create_bundle_from_unbundled(
        session, relative_paths=["clips/a.mp4", "clips/b.mp4"], title="Clips"
    )

    bundle = session.get(AssetBundle, result.bundle_id)
    assert bundle is not None and bundle.grouping_state is GroupingState.CONFIRMED
    assert result.files_added == 2
    paths = {
        f.relative_path
        for f in session.scalars(select(AssetFile).where(AssetFile.bundle_id == bundle.id))
    }
    assert paths == {"clips/a.mp4", "clips/b.mp4"}


def test_add_files_from_paths_mixes_linked_and_unlinked(
    session: Session, library_root: Path
) -> None:
    (library_root / "s").mkdir()
    (library_root / "s" / "ep.mp4").write_text("v")
    (library_root / "s" / "ep.srt").write_text("s")
    target = _confirmed_with_video(session, "Show", "s/ep.mp4")
    # ep.mp4 is confirmed (target's file); ep.srt is unlinked on disk.
    session.commit()

    result = apply_service.add_unbundled_files_to_bundle(
        session, target.id, relative_paths=["s/ep.srt"]
    )
    assert result.files_added == 1
    assert result.subtitles_linked == 1  # auto-linked to the video
    linked = session.scalar(select(AssetFile).where(AssetFile.relative_path == "s/ep.srt"))
    assert linked is not None and linked.bundle_id == target.id


def test_paths_in_rejects_confirmed_file(session: Session, library_root: Path) -> None:
    (library_root / "m").mkdir()
    (library_root / "m" / "movie.mp4").write_text("v")
    _confirmed_with_video(session, "Movie", "m/movie.mp4")
    session.commit()
    with pytest.raises(ValidationError, match="confirmed"):
        apply_service.create_bundle_from_unbundled(session, relative_paths=["m/movie.mp4"])


def test_suggest_bundle_from_paths_without_staging(session: Session, library_root: Path) -> None:
    """Suggestions over unlinked paths stay read-only (no rows created)."""
    (library_root / "d").mkdir()
    (library_root / "d" / "song.mp4").write_text("v")
    (library_root / "d" / "cover.jpg").write_text("i")
    session.commit()
    before = session.scalar(select(AssetFile.id))
    assert before is None  # nothing linked yet

    draft = suggest_service.suggest_bundle_from_files(session, relative_paths=["d/song.mp4"])
    assert draft.proposed_title == "song"
    # Still nothing linked — suggesting must not write.
    assert session.scalar(select(AssetFile.id)) is None


# --- delete falls back to Unbundled ------------------------------------------
def test_deleting_confirmed_bundle_restages_files_as_unbundled(session: Session) -> None:
    """Deleting a confirmed bundle dissolves it: its files return to Unbundled
    (new provisional/scan_suggestion one-file bundles) with ids preserved."""
    video = _unbundled(session, "movie/feature.mp4")
    cover = _unbundled(session, "movie/cover.jpg")
    result = apply_service.create_bundle_from_unbundled(
        session, [video.id, cover.id], title="Feature"
    )
    session.commit()
    bundle_id = result.bundle_id
    file_ids = {video.id, cover.id}

    bundle_service.delete_bundle(session, bundle_id)
    session.commit()
    session.expire_all()  # the shared test session keeps rows unexpired on commit

    # The confirmed bundle is gone; both files survive, each in its own fresh
    # provisional (unbundled) bundle.
    assert session.get(AssetBundle, bundle_id) is None
    for fid in file_ids:
        row = session.get(AssetFile, fid)
        assert row is not None  # id preserved
        assert row.bundle_id != bundle_id
        parent = row.bundle
        assert parent.grouping_state is GroupingState.PROVISIONAL
        assert parent.grouping_source is GroupingSource.SCAN_SUGGESTION


def test_deleting_unbundled_bundle_removes_the_file(session: Session) -> None:
    """Deleting an already-unbundled bundle removes its row — the way to drop a
    loose file from the library (it does not loop back into Unbundled)."""
    loose = _unbundled(session, "loose/clip.mp4")
    session.commit()
    bundle_id = loose.bundle_id
    file_id = loose.id

    bundle_service.delete_bundle(session, bundle_id)
    session.commit()

    assert session.get(AssetBundle, bundle_id) is None
    assert session.get(AssetFile, file_id) is None


# --- suggestions -------------------------------------------------------------
def test_suggest_target_bundles_ranks_same_folder_first(session: Session) -> None:
    show = _confirmed_with_video(session, "Cosmos", "cosmos/ep01.mp4")
    _confirmed_with_video(session, "Unrelated", "beach/holiday.mp4")
    session.commit()

    # A subtitle sitting in the same folder as the confirmed show's video.
    sub = _unbundled(session, "cosmos/ep01.srt")
    session.commit()

    results = suggest_service.suggest_target_bundles(session, [sub.id])
    assert results, "expected at least one suggested target"
    assert results[0].bundle_id == show.id
    assert results[0].confidence > 0.4
    assert "folder" in results[0].reason


def test_suggest_unbundled_files_for_bundle(session: Session) -> None:
    bundle = _confirmed_with_video(session, "Trip", "trip/day1.mp4")
    match = _unbundled(session, "trip/day1.srt")
    _unbundled(session, "unrelated/other.mp4")
    session.commit()

    results = suggest_service.suggest_unbundled_files_for_bundle(session, bundle.id)
    ids = [r.file_id for r in results]
    assert match.id in ids
    top = next(r for r in results if r.file_id == match.id)
    assert top.confidence > 0.4


def test_suggest_bundle_from_files_proposes_title_roles_and_extras(session: Session) -> None:
    video = _unbundled(session, "album/song.mp4")
    nearby_cover = _unbundled(session, "album/cover.jpg")
    session.commit()

    draft = suggest_service.suggest_bundle_from_files(session, [video.id])
    assert draft.proposed_title == "song"
    assert [r.role for r in draft.roles] == [FileRole.PRIMARY_VIDEO]
    # The cover in the same folder is offered as an addition.
    assert nearby_cover.id in [s.file_id for s in draft.additional]
