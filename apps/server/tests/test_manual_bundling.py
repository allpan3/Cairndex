"""Manual bundling assistant: unbundled staging, suggestions, and metadata-only
confirm mutations (Unbundled staging follow-up to ADR-0009)."""

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.grouping import apply as grouping_apply
from cairndex.grouping import plan_store
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
    assert bundle.primary_file_id is None  # ordered files replace the legacy pointer


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
    # Role heuristics remain grouping metadata; playback follows file sequence
    assert bundle.primary_file_id is None
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


# --- paths-in (auto-link) from File Browser -------------------------------------
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


def test_create_bundle_skips_non_media_paths_without_aborting(
    session: Session, library_root: Path
) -> None:
    """A drag-in of a folder of media plus a stray sidecar bundles the media and
    reports the skip, instead of one non-media path aborting the whole batch."""
    (library_root / "clips").mkdir()
    (library_root / "clips" / "a.mp4").write_text("v")
    (library_root / "clips" / "a.nfo").write_text("meta")
    session.commit()

    result = apply_service.create_bundle_from_unbundled(
        session,
        # A directory, a media file, and a non-media sidecar — as a folder drop
        # would deliver after reverse-mapping (the directory itself is filtered in
        # the shell, but the apply path must also tolerate non-media files).
        relative_paths=["clips/a.mp4", "clips/a.nfo"],
        title="Clips",
    )

    assert result.files_added == 1
    assert result.skipped_non_media == 1
    assert result.files_skipped == 1
    paths = {
        f.relative_path
        for f in session.scalars(select(AssetFile).where(AssetFile.bundle_id == result.bundle_id))
    }
    assert paths == {"clips/a.mp4"}


def test_create_bundle_reports_skip_reasons_separately(
    session: Session, library_root: Path
) -> None:
    """A folder mixing new media, already-confirmed media, and a sidecar adds the
    new media and tallies the other two by their own reason (not lumped)."""
    (library_root / "m").mkdir()
    (library_root / "m" / "new.mp4").write_text("v")
    (library_root / "m" / "already.mp4").write_text("v")
    (library_root / "m" / "trailer.nfo").write_text("meta")
    _confirmed_with_video(session, "Existing", "m/already.mp4")
    session.commit()

    result = apply_service.create_bundle_from_unbundled(
        session,
        relative_paths=["m/new.mp4", "m/already.mp4", "m/trailer.nfo", "m/gone.mp4"],
    )

    assert result.files_added == 1  # only new.mp4
    assert result.skipped_already_bundled == 1  # already.mp4
    assert result.skipped_non_media == 1  # trailer.nfo
    assert result.skipped_missing == 1  # m/gone.mp4 never existed on disk
    assert result.files_skipped == 3


def test_create_bundle_from_only_non_media_reports_clearly(
    session: Session, library_root: Path
) -> None:
    (library_root / "clips").mkdir()
    (library_root / "clips" / "notes.nfo").write_text("meta")
    session.commit()

    with pytest.raises(ValidationError, match="linkable media"):
        apply_service.create_bundle_from_unbundled(session, relative_paths=["clips/notes.nfo"])


def test_add_files_skips_non_media_paths_without_aborting(
    session: Session, library_root: Path
) -> None:
    (library_root / "s").mkdir()
    (library_root / "s" / "ep.mp4").write_text("v")
    (library_root / "s" / "cover.nfo").write_text("meta")
    target = _confirmed_with_video(session, "Show", "s/existing.mp4")
    session.commit()

    result = apply_service.add_unbundled_files_to_bundle(
        session, target.id, relative_paths=["s/ep.mp4", "s/cover.nfo"]
    )

    assert result.files_added == 1
    assert result.skipped_non_media == 1
    assert result.files_skipped == 1


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


def test_paths_in_skips_confirmed_and_fails_clearly_when_all_skipped(
    session: Session, library_root: Path
) -> None:
    (library_root / "m").mkdir()
    (library_root / "m" / "movie.mp4").write_text("v")
    _confirmed_with_video(session, "Movie", "m/movie.mp4")
    session.commit()
    # A path already in a confirmed bundle is skipped, not rejected mid-batch (so a
    # partly-organized folder still adds the rest); a selection of only such paths
    # fails with the clear all-unaddable message.
    with pytest.raises(ValidationError, match="linkable media"):
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


def test_suggest_bundle_preview_matches_apply_filtering(
    session: Session, library_root: Path
) -> None:
    """The Create Bundle preview drops non-media seed paths just like apply, so it
    can't propose bundling a file that apply would skip (D4 review P1-5)."""
    (library_root / "d").mkdir()
    (library_root / "d" / "movie.mp4").write_text("v")
    (library_root / "d" / "movie.nfo").write_text("meta")
    session.commit()

    draft = suggest_service.suggest_bundle_from_files(
        session, relative_paths=["d/movie.mp4", "d/movie.nfo"]
    )

    assert [r.relative_path for r in draft.roles] == ["d/movie.mp4"]

    # An all-non-media selection previews as empty (roles/title), so the dialog can
    # explain instead of offering a dead-end submit.
    empty = suggest_service.suggest_bundle_from_files(session, relative_paths=["d/movie.nfo"])
    assert empty.roles == []
    assert empty.proposed_title == ""


# --- stale grouping plan vs. manual bundling ---------------------------------
def test_applying_stale_plan_does_not_override_manual_bundling(session: Session) -> None:
    """A grouping plan generated before manual bundling is safe to apply: a
    proposal whose files are now in a *confirmed* manual bundle is reported as a
    conflict and skipped — it never re-groups the user's confirmed decision.

    (This is the reported scenario: Update → don't apply → manually bundle some
    files → reopen Review grouping → Apply. Confirmed bundles win; regenerating
    the suggestions afterward gives a fresh plan.)
    """
    video = _unbundled(session, "movie/feature.mp4")
    sub = _unbundled(session, "movie/feature.srt")
    session.commit()

    # Snapshot the suggestions (one BUNDLE proposal grouping the video + sidecar).
    plan = plan_store.generate_plan(session)
    session.commit()
    assert any(p.kind.value == "bundle" for p in plan.proposals)

    # Manually confirm the video into its own bundle *before* applying the plan.
    manual = apply_service.create_bundle_from_unbundled(session, [video.id], title="My Cut")
    session.commit()

    # Applying the now-stale plan must not disturb the confirmed manual bundle.
    result = grouping_apply.apply_plan(session, plan)
    session.commit()

    assert result.conflicts, "the proposal touching the confirmed file should conflict"
    assert result.bundles_confirmed == 0
    reloaded = session.get(AssetFile, video.id)
    assert reloaded is not None and reloaded.bundle_id == manual.bundle_id  # untouched
    manual_bundle = session.get(AssetBundle, manual.bundle_id)
    assert manual_bundle is not None
    assert manual_bundle.grouping_state is GroupingState.CONFIRMED
    assert manual_bundle.title == "My Cut"
    # The subtitle the proposal also wanted is left as an unbundled file.
    sub_row = session.get(AssetFile, sub.id)
    assert sub_row is not None
    assert sub_row.bundle.grouping_state is GroupingState.PROVISIONAL


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


def test_removing_a_file_from_a_bundle_restages_it_as_unbundled(session: Session) -> None:
    """Removing a file from a bundle does not unlink it from the library: it
    returns to Unbundled (a new provisional/scan_suggestion one-file bundle), id
    preserved, and any cover/primary pointer to it on the source is cleared."""
    video = _unbundled(session, "clip/main.mp4")
    extra = _unbundled(session, "clip/extra.jpg")
    result = apply_service.create_bundle_from_unbundled(session, [video.id, extra.id], title="Clip")
    session.commit()
    bundle_id = result.bundle_id
    bundle_service.update_bundle(session, bundle_id, {"cover_file_id": extra.id})
    session.commit()

    bundle_service.remove_file(session, bundle_id, extra.id)
    session.commit()
    session.expire_all()  # the shared test session keeps rows unexpired on commit

    source = session.get(AssetBundle, bundle_id)
    assert source is not None  # the source bundle survives
    assert source.cover_file_id is None  # the dangling cover pointer was cleared
    assert {f.id for f in source.files} == {video.id}

    row = session.get(AssetFile, extra.id)
    assert row is not None  # id preserved — not unlinked from disk-tracking
    assert row.bundle_id != bundle_id
    parent = row.bundle
    assert parent.grouping_state is GroupingState.PROVISIONAL
    assert parent.grouping_source is GroupingSource.SCAN_SUGGESTION


def test_deleting_a_bundle_does_not_restage_its_missing_file(session: Session) -> None:
    """A missing member goes with the bundle instead of becoming a new one.

    Staging it produced a fresh provisional one-file bundle, which the Missing
    Files view shows — so the card reappeared under a new id and deleting it took
    a second pass (owner, 2026-08-24). There is nothing on disk for it to fall
    back with; the pending zone is for files awaiting registration.
    """
    video = _unbundled(session, "movie/feature.mp4")
    gone = _unbundled(session, "movie/extra.mp4")
    result = apply_service.create_bundle_from_unbundled(
        session, [video.id, gone.id], title="Feature"
    )
    session.commit()
    bundle_id = result.bundle_id
    gone.availability = FileAvailability.MISSING
    session.commit()
    # Read before the delete: a deleted row's own attributes are unreachable
    # once the shared session is expired.
    video_id, gone_id = video.id, gone.id

    bundle_service.delete_bundle(session, bundle_id)
    session.commit()
    session.expire_all()  # the shared test session keeps rows unexpired on commit

    assert session.get(AssetBundle, bundle_id) is None
    # The live file still falls back to Unbundled, id preserved.
    live = session.get(AssetFile, video_id)
    assert live is not None
    assert live.bundle.grouping_state is GroupingState.PROVISIONAL
    # The missing one is gone, and left no staging bundle behind.
    assert session.get(AssetFile, gone_id) is None
    staged = session.scalars(select(AssetBundle)).all()
    assert [b.id for b in staged] == [live.bundle_id]


def test_removing_a_missing_file_drops_it_and_the_bundle_it_emptied(
    session: Session,
) -> None:
    """Removing a missing file drops the row rather than staging it, and takes
    the bundle with it when that was its last file — otherwise the empty bundle
    would itself sit in Unbundled, which is the same ghost one level up."""
    gone = _unbundled(session, "loose/clip.mp4")
    session.commit()
    bundle_id = gone.bundle_id
    gone.availability = FileAvailability.MISSING
    session.commit()

    bundle_service.remove_file(session, bundle_id, gone.id)
    session.commit()

    assert session.get(AssetFile, gone.id) is None
    assert session.get(AssetBundle, bundle_id) is None


def test_removing_a_missing_file_keeps_a_bundle_that_still_has_files(
    session: Session,
) -> None:
    """The bundle only goes when the removal emptied it."""
    video = _unbundled(session, "clip/main.mp4")
    gone = _unbundled(session, "clip/extra.jpg")
    result = apply_service.create_bundle_from_unbundled(session, [video.id, gone.id], title="Clip")
    session.commit()
    bundle_id = result.bundle_id
    bundle_service.update_bundle(session, bundle_id, {"cover_file_id": gone.id})
    gone.availability = FileAvailability.MISSING
    session.commit()

    video_id, gone_id = video.id, gone.id

    bundle_service.remove_file(session, bundle_id, gone_id)
    session.commit()
    session.expire_all()

    source = session.get(AssetBundle, bundle_id)
    assert source is not None
    assert source.cover_file_id is None  # the dangling cover pointer was cleared
    assert {f.id for f in source.files} == {video_id}
    assert session.get(AssetFile, gone_id) is None


# --- forget a file that is gone ----------------------------------------------
def test_forgetting_a_missing_file_leaves_the_bundle_and_its_live_files(
    session: Session,
) -> None:
    """The point of the action: shed one dead member without dissolving the
    grouping, which deleting the bundle would have done."""
    video = _unbundled(session, "show/ep01.mp4")
    gone = _unbundled(session, "show/ep02.mp4")
    result = apply_service.create_bundle_from_unbundled(session, [video.id, gone.id], title="Show")
    session.commit()
    bundle_id = result.bundle_id
    gone.availability = FileAvailability.MISSING
    session.commit()
    video_id, gone_id = video.id, gone.id

    forgotten = bundle_service.forget_missing_files(session, bundle_id, file_ids=[gone_id])
    session.commit()
    session.expire_all()

    assert (forgotten.forgotten, forgotten.bundle_deleted) == (1, False)
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    assert {f.id for f in bundle.files} == {video_id}
    assert bundle.grouping_state is GroupingState.CONFIRMED  # still the same grouping
    assert session.get(AssetFile, gone_id) is None


def test_forgetting_every_missing_file_takes_the_emptied_bundle_with_it(
    session: Session,
) -> None:
    """No file_ids means every missing file in the bundle — the card-level action.
    A bundle with nothing left is removed rather than kept as an empty shell."""
    first = _unbundled(session, "set/a.mp4")
    second = _unbundled(session, "set/b.mp4")
    result = apply_service.create_bundle_from_unbundled(session, [first.id, second.id], title="Set")
    session.commit()
    bundle_id = result.bundle_id
    first.availability = FileAvailability.MISSING
    second.availability = FileAvailability.MISSING
    session.commit()

    forgotten = bundle_service.forget_missing_files(session, bundle_id)
    session.commit()

    assert (forgotten.forgotten, forgotten.bundle_deleted) == (2, True)
    assert session.get(AssetBundle, bundle_id) is None


def test_forgetting_refuses_a_file_that_is_still_there(session: Session) -> None:
    """Only a dead row can be forgotten. A present file is removed or trashed —
    both of which mean something else — and a trashed one is recoverable, so it
    is not dead either."""
    live = _unbundled(session, "keep/clip.mp4")
    session.commit()
    bundle_id, live_id = live.bundle_id, live.id

    with pytest.raises(ValidationError):
        bundle_service.forget_missing_files(session, bundle_id, file_ids=[live_id])

    live.availability = FileAvailability.TRASHED
    session.commit()
    with pytest.raises(ValidationError):
        bundle_service.forget_missing_files(session, bundle_id, file_ids=[live_id])
    # Asking for nothing in particular finds nothing to forget, and says so.
    session.rollback()
    assert bundle_service.forget_missing_files(session, bundle_id).forgotten == 0


def test_forgetting_rejects_a_file_from_another_bundle(session: Session) -> None:
    mine = _unbundled(session, "mine/clip.mp4")
    theirs = _unbundled(session, "theirs/clip.mp4")
    session.commit()
    mine.availability = FileAvailability.MISSING
    session.commit()

    with pytest.raises(NotFoundError):
        bundle_service.forget_missing_files(session, mine.bundle_id, file_ids=[theirs.id])


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


def test_suggest_target_bundles_finds_a_bundle_in_an_enclosing_folder(session: Session) -> None:
    """A file landing *below* a bundle's folder still finds it.

    The import case: the owner adds a file into a subfolder of where the bundle
    already lives. Names are deliberately disjoint here, so locality is the only
    signal that can produce this answer.
    """
    show = _confirmed_with_video(session, "Reel", "archive/reel.mp4")
    session.commit()
    landing = _unbundled(session, "archive/extras/clip.mp4")
    session.commit()

    results = suggest_service.suggest_target_bundles(session, [landing.id])
    assert [r.bundle_id for r in results] == [show.id]
    assert results[0].reason == "parent folder"


def test_suggest_target_bundles_prefers_the_closer_folder(session: Session) -> None:
    """Two equally nameless candidates order by how close their folder is."""
    near = _confirmed_with_video(session, "Near", "archive/extras/other.mp4")
    far = _confirmed_with_video(session, "Far", "archive/reel.mp4")
    session.commit()
    landing = _unbundled(session, "archive/extras/clip.mp4")
    session.commit()

    results = suggest_service.suggest_target_bundles(session, [landing.id])
    assert [r.bundle_id for r in results] == [near.id, far.id]
    assert results[0].confidence > results[1].confidence


def test_suggest_target_bundles_separates_two_bundles_sharing_one_folder(
    session: Session,
) -> None:
    """One folder holding several bundles is the case a path alone cannot answer.

    Both are offered — the answer is a ranked list, never a single pick — but the
    one whose name the landing file echoes leads.
    """
    alpha = _confirmed_with_video(session, "Alpha", "shows/alpha-ep01.mp4")
    beta = _confirmed_with_video(session, "Beta", "shows/beta-ep01.mp4")
    session.commit()
    landing = _unbundled(session, "shows/alpha-ep02.mp4")
    session.commit()

    results = suggest_service.suggest_target_bundles(session, [landing.id])
    assert [r.bundle_id for r in results] == [alpha.id, beta.id]
    assert results[0].confidence > results[1].confidence


def test_suggest_target_bundles_answers_for_a_path_that_has_no_row_yet(
    session: Session,
) -> None:
    """The import-time question: where should a file *about to land here* go?

    Asked before the bytes exist, so there is no ``AssetFile`` row and nothing on
    disk — only a destination folder and a filename.
    """
    show = _confirmed_with_video(session, "Reel", "archive/reel.mp4")
    session.commit()

    results = suggest_service.suggest_target_bundles(
        session, [], relative_paths=["archive/reel-behind-the-scenes.mp4"]
    )
    assert [r.bundle_id for r in results] == [show.id]
    assert (
        session.scalar(
            select(AssetFile).where(AssetFile.relative_path == "archive/reel-behind-the-scenes.mp4")
        )
        is None
    ), "asking must not stage a row"


def test_suggest_target_bundles_does_not_treat_the_library_root_as_locality(
    session: Session,
) -> None:
    """A bundle at the top of the library is not near everything.

    The root encloses every path, so matching on it is evidence of nothing — it
    would offer the same handful of root-level bundles for every import.
    """
    _confirmed_with_video(session, "Loose", "stray.mp4")
    session.commit()
    landing = _unbundled(session, "archive/extras/clip.mp4")
    session.commit()

    assert suggest_service.suggest_target_bundles(session, [landing.id]) == []


def test_suggest_target_bundles_stops_walking_up_after_a_few_levels(session: Session) -> None:
    """The ancestor walk is bounded, so a deep import does not reach a far bundle."""
    show = _confirmed_with_video(session, "Reel", "archive/reel.mp4")
    session.commit()
    within = _unbundled(session, "archive/one/two/three/clip.mp4")
    beyond = _unbundled(session, "archive/one/two/three/four/clip.mp4")
    session.commit()

    assert [r.bundle_id for r in suggest_service.suggest_target_bundles(session, [within.id])] == [
        show.id
    ]
    assert suggest_service.suggest_target_bundles(session, [beyond.id]) == []


def test_locality_lookups_resolve_through_the_directory_index(session: Session) -> None:
    """Both directions of the locality relation must be index seeks.

    These generators run when a dialog opens, so reading ``asset_files`` whole is
    a stall the owner feels on a large library — and it is invisible in a test
    library of four rows, which is why this asserts the query plan rather than a
    duration.

    The assertion is deliberately *positive* — the plan must name
    ``ix_asset_files_directory_path`` — rather than "no full scan". A ``LIKE
    'dir/%'`` prefix cannot use that index under SQLite's default
    case-insensitive rules (nor with an ``ESCAPE`` clause, which disables the
    optimization outright), but it does not necessarily show up as ``SCAN
    asset_files`` either: the planner may drive from ``asset_bundles`` instead and
    test each bundle's files, which is just as slow and reads as innocent. Naming
    the index is the only form of this test that fails when the spelling regresses.
    """
    bundle = _confirmed_with_video(session, "Reel", "archive/reel.mp4")
    session.commit()
    landing = _unbundled(session, "archive/extras/clip.mp4")
    session.commit()

    engine = session.get_bind()
    seen: list[tuple[str, Any]] = []

    def record(conn, cursor, statement, parameters, context, executemany) -> None:  # type: ignore[no-untyped-def]
        # The two candidate-gathering statements, by shape: bundle ids off
        # asset_files, joined to asset_bundles for the grouping-state filter.
        compact = " ".join(statement.split())
        if compact.startswith("SELECT asset_files.bundle_id FROM asset_files JOIN asset_bundles"):
            seen.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", record)
    try:
        # Bundles enclosing a file, then files within a bundle's folder.
        suggest_service.suggest_target_bundles(session, [landing.id])
        suggest_service.suggest_unbundled_files_for_bundle(session, bundle.id)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert len(seen) == 2, f"expected one locality lookup per direction, got {len(seen)}"
    for statement, parameters in seen:
        plan = [
            detail
            for *_, detail in session.connection()
            .exec_driver_sql(f"EXPLAIN QUERY PLAN {statement}", parameters)
            .all()
        ]
        assert any("ix_asset_files_directory_path" in line for line in plan), (
            f"locality lookup does not use the directory index:\n{statement}\n{plan}"
        )
        assert not [line for line in plan if line.startswith("SCAN ")], (
            f"full table scan on the suggestion path:\n{statement}\n{plan}"
        )


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
