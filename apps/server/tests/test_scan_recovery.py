"""Controlled incomplete walks preserve stable identities and authored metadata"""

import shutil
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, GroupingState
from cairndex.persistence.models import AssetFile
from cairndex.scanning import scanner


# An unreadable original is not evidence that its matching copy is a move
def test_partial_walk_does_not_repair_or_stage_copy(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = library_root / "original" / "specimen.mp4"
    source.parent.mkdir()
    source.write_bytes(b"synthetic specimen")
    scanner.scan_library(session, library_root)
    row = session.scalars(select(AssetFile)).one()
    file_id, bundle_id = row.id, row.bundle_id
    row.bundle.grouping_state = GroupingState.CONFIRMED
    row.bundle.notes = ["Synthetic annotation"]
    row.bundle.rating = 4.5
    session.commit()
    destination = library_root / "copy" / source.name
    destination.parent.mkdir()
    shutil.copy2(source, destination)
    listing = scanner._list_directory

    # The directory refusal represents an unavailable subtree on a mounted root
    def partial(directory: Path):
        return ([], [], False) if directory == source.parent else listing(directory)

    with monkeypatch.context() as patch:
        patch.setattr(scanner, "_list_directory", partial)
        result = scanner.scan_library(session, library_root)
    assert result.repaired == result.created == result.forgotten == 0
    session.expire_all()
    row = session.get(AssetFile, file_id)
    assert row is not None and row.relative_path == "original/specimen.mp4"
    assert row.bundle_id == bundle_id
    assert row.bundle.notes == ["Synthetic annotation"] and row.bundle.rating == 4.5
    assert row.availability is FileAvailability.MISSING
    result = scanner.scan_library(session, library_root)
    assert result.created == 1 and result.repaired == 0
    assert session.get(AssetFile, file_id).availability is FileAvailability.AVAILABLE


# Symlink targets outside the library never become scan observations or repair candidates
def test_scan_ignores_media_symlinks(session: Session, library_root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"outside synthetic specimen")
    (library_root / "escape.mp4").symlink_to(outside)
    result = scanner.scan_library(session, library_root)
    assert result.discovered == result.created == 0


# Replacing a root while its walk is in flight cannot reconcile the old catalog against it
def test_rebound_root_stops_reconciliation(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (library_root / "specimen.mp4").write_bytes(b"synthetic specimen")
    scanner.scan_library(session, library_root)
    row = session.scalars(select(AssetFile)).one()
    original_id = row.id
    row.bundle.notes = ["Retain this"]
    session.commit()
    walk = scanner._iter_media_entries

    # Move the package aside after enumeration, leaving the open DB on the original inode
    def replace_root(root: Path, status=None):
        yield from walk(root, status)
        root.rename(root.with_name("original-package"))
        root.mkdir()

    monkeypatch.setattr(scanner, "_iter_media_entries", replace_root)
    with pytest.raises(OSError, match="root changed"):
        scanner.scan_library(session, library_root)
    session.rollback()
    row = session.get(AssetFile, original_id)
    assert row is not None and row.bundle.notes == ["Retain this"]
    assert row.relative_path == "specimen.mp4"


# Cancellation after a committed observation batch cannot change missing membership or stage a move
@pytest.mark.parametrize("phase", ["walking", "reconciling"])
def test_cancelled_walk_keeps_authored_identity_until_retry(session, library_root, phase):
    from cairndex.jobs.worker import JobCancelled

    stable = library_root / "stable.mp4"
    moved = library_root / "before.mp4"
    stable.write_bytes(b"stable synthetic")
    moved.write_bytes(b"moved synthetic")
    scanner.scan_library(session, library_root)
    files = {row.relative_path: row for row in session.scalars(select(AssetFile))}
    row = files["before.mp4"]
    identity = row.id
    row.bundle.grouping_state = GroupingState.CONFIRMED
    row.bundle.notes = ["Keep during interruption"]
    row.note = "Keep file annotation"
    session.commit()
    moved.rename(library_root / "after.mp4")

    # The production job callback raises this same exception at cancellation checkpoints
    def progress(_processed, _total):
        if phase == "walking":
            raise JobCancelled

    # Stop after enumeration but before any repair/staging takes place
    def transition(name):
        if phase == name:
            raise JobCancelled

    with pytest.raises(JobCancelled):
        scanner.scan_library(
            session, library_root, batch_size=1, on_progress=progress, on_phase=transition
        )
    session.rollback()
    row = session.get(AssetFile, identity)
    assert row.relative_path == "before.mp4"
    assert row.availability is FileAvailability.AVAILABLE
    assert row.bundle.notes == ["Keep during interruption"]
    result = scanner.scan_library(session, library_root)
    assert result.repaired == 1 and result.created == 0
    assert row.relative_path == "after.mp4" and row.note == "Keep file annotation"


# A scan cannot turn a journaled trash decision into an implicit restore
def test_scan_does_not_repair_a_trashed_identity(session, library_root):
    source = library_root / "specimen.mp4"
    source.write_bytes(b"synthetic specimen")
    scanner.scan_library(session, library_root)
    row = session.scalars(select(AssetFile)).one()
    identity = row.id
    row.bundle.grouping_state = GroupingState.CONFIRMED
    row.availability = FileAvailability.TRASHED
    session.commit()
    source.rename(library_root / "returned.mp4")
    result = scanner.scan_library(session, library_root)
    assert result.repaired == 0 and result.created == 1
    assert session.get(AssetFile, identity).availability is FileAvailability.TRASHED


# An incomplete Update reports failure and leaves review generation for a complete retry
def test_partial_update_job_is_failed_and_retryable(
    registry_session_factory, library_id, library_root, monkeypatch
):
    from cairndex.domain.enums import JobStatus, JobType
    from cairndex.jobs.registry import build_registry
    from cairndex.jobs.worker import execute_job
    from cairndex.registry import jobs

    directory = library_root / "specimens"
    directory.mkdir()
    (directory / "clip.mp4").write_bytes(b"synthetic specimen")
    listing = scanner._list_directory

    # Return a genuine incomplete-walk signal from the production listing seam
    def refuse(path):
        return ([], [], False) if path == directory else listing(path)

    with registry_session_factory() as reg:
        job = jobs.create_job(reg, library_id=library_id, job_type=JobType.SCAN)
        reg.commit()
        identity = job.id
    with monkeypatch.context() as patch:
        patch.setattr(scanner, "_list_directory", refuse)
        assert execute_job(registry_session_factory, identity, build_registry()) is JobStatus.FAILED
    with registry_session_factory() as reg:
        failed = jobs.get_job(reg, identity)
        assert "restore access and retry Update" in failed.error
        assert not failed.result
        retry = jobs.create_job(reg, library_id=library_id, job_type=JobType.SCAN)
        reg.commit()
        retry_id = retry.id
    assert execute_job(registry_session_factory, retry_id, build_registry()) is JobStatus.SUCCEEDED


# Renaming a complete bundle retains every authored reference to its stable file identities
def test_move_preserves_authored_reference_graph(session, library_root):
    from cairndex.core.time import utcnow
    from cairndex.grouping import plan_store
    from cairndex.grouping.apply import apply_plan
    from cairndex.persistence.models import (
        AssetBundle,
        BundleCursor,
        Collection,
        Moment,
        PlaybackProgress,
        SubtitleTrack,
        Tag,
    )

    directory = library_root / "specimen"
    directory.mkdir()
    for name in ("clip.mp4", "clip.en.srt", "poster.jpg"):
        (directory / name).write_bytes(b"synthetic media")
    scanner.scan_library(session, library_root)
    apply_plan(session, plan_store.generate_plan(session))
    bundle = session.scalars(select(AssetBundle)).one()
    files = {row.original_filename: row for row in bundle.files}
    video, subtitle = files["clip.mp4"], files["clip.en.srt"]
    bundle.notes = ["First note", "Second note"]
    bundle.rating = 4.5
    bundle.collections.append(Collection(name="Synthetic archive"))
    bundle.tags.append(Tag(name="Synthetic tag"))
    video.note, video.source, video.cover_time = "File note", "Synthetic source", 2.5
    cursor = BundleCursor(bundle_id=bundle.id, file_id=video.id, updated_at=utcnow())
    progress = PlaybackProgress(
        file_id=video.id,
        bundle_id=bundle.id,
        position_s=9,
        duration_s=20,
        completed=False,
        updated_at=utcnow(),
    )
    moment = Moment(
        bundle_id=bundle.id,
        file_id=video.id,
        start_s=3,
        end_s=5,
        comment="Keep this moment",
        tags=[Tag(name="Synthetic moment tag")],
    )
    session.add_all([cursor, progress, moment])
    session.commit()
    identities = {row.id for row in files.values()}
    bundle_id, cover_id, moment_id = bundle.id, bundle.cover_file_id, moment.id
    track = session.scalars(select(SubtitleTrack)).one()
    track_id = track.id
    directory.rename(library_root / "renamed")
    result = scanner.scan_library(session, library_root)
    assert result.repaired == 3 and result.created == result.missing == 0
    session.expire_all()
    bundle = session.get(AssetBundle, bundle_id)
    assert {row.id for row in bundle.files} == identities
    assert all(row.relative_path.startswith("renamed/") for row in bundle.files)
    assert bundle.notes == ["First note", "Second note"] and bundle.rating == 4.5
    assert bundle.cover_file_id == cover_id
    assert [row.name for row in bundle.collections] == ["Synthetic archive"]
    assert "Synthetic tag" in [row.name for row in bundle.tags]
    assert (video.note, video.source, video.cover_time) == ("File note", "Synthetic source", 2.5)
    assert session.get(BundleCursor, bundle_id).file_id == video.id
    assert session.get(PlaybackProgress, video.id).position_s == 9
    restored_moment = session.get(Moment, moment_id)
    assert restored_moment.file_id == video.id and restored_moment.comment == "Keep this moment"
    assert [row.name for row in restored_moment.tags] == ["Synthetic moment tag"]
    restored_track = session.get(SubtitleTrack, track_id)
    assert restored_track.video_file_id == video.id and restored_track.source_file_id == subtitle.id
