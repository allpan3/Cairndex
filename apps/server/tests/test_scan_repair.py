"""Moved-file repair: a same-volume move keeps the AssetFile.id and all metadata.

Covers AGENTS.md §5.3: high-confidence moves update the existing row in place;
ambiguous matches, copies, and same-path edits do not spawn or merge bundles.
"""

import os
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability
from cairndex.persistence.models import AssetBundle, AssetFile, PlaybackProgress, SubtitleTrack
from cairndex.scanning import scanner
from cairndex.scanning.repair import find_repair_candidate, repair_file
from cairndex.scanning.scanner import scan_library
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service


def _only_file(session: Session) -> AssetFile:
    f = session.scalar(select(AssetFile))
    assert f is not None
    return f


def test_same_volume_move_repairs_in_place(session: Session, library_root: Path) -> None:
    (library_root / "a").mkdir()
    src = library_root / "a" / "movie.mp4"
    src.write_text("the movie bytes")
    scan_library(session, library_root)

    f = _only_file(session)
    original_id, bundle_id = f.id, f.bundle_id
    # Decorate the bundle with metadata that must survive the repair.
    collection = collection_service.create_collection(session, name="Films")
    bundle_service.set_bundle_collections(session, bundle_id, [collection.id])
    bundle_service.update_bundle(session, bundle_id, {"rating": 5, "notes": ["keep me"]})
    bundle_service.update_bundle(session, bundle_id, {"cover_file_id": original_id})
    session.add(
        PlaybackProgress(
            file_id=original_id,
            bundle_id=bundle_id,
            position_s=42,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 6, tzinfo=UTC),
        )
    )
    session.commit()

    # Move it (same volume → same inode).
    (library_root / "b").mkdir()
    src.rename(library_root / "b" / "movie.mp4")

    summary = scan_library(session, library_root)
    assert summary.repaired == 1
    assert summary.created == 0
    assert summary.missing == 0

    assert session.scalar(select(func.count()).select_from(AssetFile)) == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    moved = _only_file(session)
    assert moved.id == original_id
    assert moved.bundle_id == bundle_id
    assert moved.relative_path == "b/movie.mp4"
    assert moved.availability == FileAvailability.AVAILABLE

    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    assert bundle.rating == 5 and bundle.notes == ["keep me"]
    assert bundle.cover_file_id == original_id
    assert {c.name for c in bundle.collections} == {"Films"}
    progress = session.get(PlaybackProgress, original_id)
    assert progress is not None
    assert progress.file_id == original_id and progress.bundle_id == bundle_id
    assert progress.position_s == 42


def test_unsigned_64bit_identity_is_stored_and_repairs_in_place(
    session: Session, library_root: Path, monkeypatch
) -> None:
    """Network filesystem identities above SQLite's range remain usable."""
    high_device = (1 << 64) - 1
    high_inode = 12_533_741_083_415_795_663
    stored_device = -1
    stored_inode = high_inode - (1 << 64)

    def stat_with_high_inode(entry):
        stat = entry.stat()
        if entry.name != "movie.mp4":
            return stat
        return SimpleNamespace(
            st_size=stat.st_size,
            st_mtime=stat.st_mtime,
            st_mtime_ns=stat.st_mtime_ns,
            st_dev=high_device,
            st_ino=high_inode,
        )

    source = library_root / "a" / "movie.mp4"
    source.parent.mkdir()
    source.write_text("network movie")
    monkeypatch.setattr(scanner, "_entry_stat", stat_with_high_inode)

    first = scan_library(session, library_root)
    row = _only_file(session)
    original_id = row.id
    assert first.created == 1
    assert row.filesystem_device == stored_device
    assert row.filesystem_inode == stored_inode

    destination = library_root / "b" / "movie.mp4"
    destination.parent.mkdir()
    source.rename(destination)
    second = scan_library(session, library_root)

    repaired = _only_file(session)
    assert second.repaired == 1
    assert repaired.id == original_id
    assert repaired.relative_path == "b/movie.mp4"
    assert repaired.filesystem_device == stored_device
    assert repaired.filesystem_inode == stored_inode


def test_same_path_edit_is_update_not_move(session: Session, library_root: Path) -> None:
    f_path = library_root / "clip.mp4"
    f_path.write_text("v1")
    scan_library(session, library_root)
    original_id = _only_file(session).id

    f_path.write_text("a much longer version 2")  # same path, new size/mtime
    summary = scan_library(session, library_root)

    assert summary.repaired == 0
    assert summary.created == 0
    assert summary.updated == 1
    f = _only_file(session)
    assert f.id == original_id and f.relative_path == "clip.mp4"


def test_a_rename_found_by_scan_carries_the_shown_name(
    session: Session, library_root: Path
) -> None:
    """A rename Cairndex did not perform still has to update the shown name.

    ``display_title`` is what every bundle surface renders, so leaving it behind
    showed the file under its old name inside its bundle while the File Browser
    showed the new one — the owner's report, reaching the repair pass rather than
    the rename operation (2026-07-30).
    """
    src = library_root / "SET-0251.webp"
    src.write_text("image bytes")
    scan_library(session, library_root)
    original_id = _only_file(session).id

    src.rename(library_root / "Catalogue 0251.webp")
    summary = scan_library(session, library_root)

    assert summary.repaired == 1
    f = _only_file(session)
    assert f.id == original_id
    assert f.relative_path == "Catalogue 0251.webp"
    assert f.display_title == "Catalogue 0251.webp"


def test_a_rename_found_by_scan_leaves_a_chosen_title_alone(
    session: Session, library_root: Path
) -> None:
    src = library_root / "clip.mp4"
    src.write_text("bytes")
    scan_library(session, library_root)
    chosen = _only_file(session)
    chosen.display_title = "Opening titles"
    session.commit()

    src.rename(library_root / "renamed.mp4")
    scan_library(session, library_root)

    f = _only_file(session)
    assert f.relative_path == "renamed.mp4"
    assert f.display_title == "Opening titles"


def test_copy_does_not_merge_or_repair(session: Session, library_root: Path) -> None:
    src = library_root / "orig.mp4"
    src.write_text("content")
    scan_library(session, library_root)

    (library_root / "copy.mp4").write_bytes(src.read_bytes())
    summary = scan_library(session, library_root)

    assert summary.repaired == 0
    assert summary.created == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 2


def test_missing_file_stays_visible_when_no_match(session: Session, library_root: Path) -> None:
    (library_root / "gone.mp4").write_text("bytes")
    scan_library(session, library_root)
    original_id = _only_file(session).id

    (library_root / "gone.mp4").unlink()
    summary = scan_library(session, library_root)

    assert summary.repaired == 0
    assert summary.missing == 1
    f = _only_file(session)
    assert f.id == original_id
    assert f.availability == FileAvailability.MISSING


def test_explicit_repair_collapses_a_renamed_network_duplicate(
    session: Session, library_root: Path, monkeypatch
) -> None:
    """A confirmed relink heals the state a later rescan cannot reconsider."""
    old_path = library_root / "movie-[2023].mp4"
    old_path.write_text("network movie")
    scan_library(session, library_root)
    original = _only_file(session)
    original_id = original.id
    target_bundle_id = original.bundle_id
    bundle_service.update_bundle(session, target_bundle_id, {"rating": 5, "notes": ["keep"]})
    bundle_service.update_bundle(session, target_bundle_id, {"cover_file_id": original_id})
    session.add(
        PlaybackProgress(
            file_id=original_id,
            bundle_id=target_bundle_id,
            position_s=10,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 1, tzinfo=UTC),
        )
    )
    session.commit()

    new_path = library_root / "movie-[2023.07.18].mp4"
    old_path.rename(new_path)

    def unstable_network_stat(entry):
        stat = entry.stat()
        if entry.name != new_path.name:
            return stat
        return SimpleNamespace(
            st_size=stat.st_size,
            st_mtime=stat.st_mtime,
            st_mtime_ns=stat.st_mtime_ns,
            st_dev=stat.st_dev,
            st_ino=stat.st_ino + 1,
        )

    monkeypatch.setattr(scanner, "_entry_stat", unstable_network_stat)
    missed = scan_library(session, library_root)
    assert missed.created == 1 and missed.repaired == 0 and missed.missing_total == 1

    replacement = session.scalar(
        select(AssetFile).where(AssetFile.availability == FileAvailability.AVAILABLE)
    )
    assert replacement is not None and replacement.id != original_id
    replacement_bundle_id = replacement.bundle_id
    track = SubtitleTrack(
        bundle_id=replacement.bundle_id,
        video_file_id=replacement.id,
        embedded_index=2,
        language="en",
    )
    session.add(track)
    session.add(
        PlaybackProgress(
            file_id=replacement.id,
            bundle_id=replacement.bundle_id,
            position_s=45,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 2, tzinfo=UTC),
        )
    )
    session.commit()

    candidate = find_repair_candidate(session, target_bundle_id, original_id)
    assert candidate is not None and candidate.replacement_file_id == replacement.id
    repaired = repair_file(session, target_bundle_id, original_id, replacement.id)
    session.commit()

    assert repaired.id == original_id
    assert repaired.relative_path == new_path.name
    # The name a bundle shows follows the repair too, or the healed row keeps the
    # name of the path it no longer points at (owner report, 2026-07-30).
    assert repaired.display_title == new_path.name
    assert repaired.availability == FileAvailability.AVAILABLE
    assert session.scalar(select(func.count()).select_from(AssetFile)) == 1
    assert session.get(AssetBundle, replacement_bundle_id) is None
    target = session.get(AssetBundle, target_bundle_id)
    assert target is not None and target.rating == 5 and target.notes == ["keep"]
    assert target.cover_file_id == original_id
    progress = session.get(PlaybackProgress, original_id)
    assert progress is not None and progress.position_s == 45
    repaired_track = session.get(SubtitleTrack, track.id)
    assert repaired_track is not None
    assert repaired_track.bundle_id == target_bundle_id
    assert repaired_track.video_file_id == original_id

    rescanned = scan_library(session, library_root)
    assert rescanned.created == 0 and rescanned.repaired == 0 and rescanned.missing_total == 0


def test_repair_api_exposes_and_applies_the_unique_candidate(
    client: TestClient,
    library_id: str,
    session: Session,
    library_root: Path,
    monkeypatch,
) -> None:
    old_path = library_root / "old-name.mp4"
    old_path.write_text("same bytes")
    scan_library(session, library_root)
    missing = _only_file(session)
    old_path.rename(library_root / "new-name.mp4")

    def changed_inode(entry):
        stat = entry.stat()
        if entry.name != "new-name.mp4":
            return stat
        return SimpleNamespace(
            st_size=stat.st_size,
            st_mtime=stat.st_mtime,
            st_mtime_ns=stat.st_mtime_ns,
            st_dev=stat.st_dev,
            st_ino=stat.st_ino + 1,
        )

    monkeypatch.setattr(scanner, "_entry_stat", changed_inode)
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/bundles/{missing.bundle_id}/files/{missing.id}"

    candidate = client.get(f"{base}/repair-candidate")
    assert candidate.status_code == 200
    replacement_id = candidate.json()["replacement_file_id"]

    repaired = client.put(f"{base}/repair", json={"replacement_file_id": replacement_id})
    assert repaired.status_code == 200
    assert repaired.json()["id"] == missing.id
    assert repaired.json()["relative_path"] == "new-name.mp4"


def test_repair_candidate_rejects_an_ambiguous_fingerprint(
    session: Session, library_root: Path
) -> None:
    old_path = library_root / "old.mp4"
    old_path.write_text("same")
    scan_library(session, library_root)
    missing = _only_file(session)
    fingerprint = missing.quick_fingerprint
    assert fingerprint is not None
    mtime_ns = int(fingerprint.rsplit(":", 1)[1])
    old_path.unlink()
    missing.availability = FileAvailability.MISSING

    for name in ("candidate-a.mp4", "candidate-b.mp4"):
        bundle = bundle_service.create_bundle(session, title=name)
        row = bundle_service.add_file(
            session,
            bundle.id,
            relative_path=name,
            role=missing.role,
            media_kind=missing.media_kind,
        )
        path = library_root / name
        path.write_text("same")
        os.utime(path, ns=(mtime_ns, mtime_ns))
        stat = path.stat()
        row.quick_fingerprint = fingerprint
        row.size_bytes = stat.st_size
        row.availability = FileAvailability.AVAILABLE
    session.commit()

    assert find_repair_candidate(session, missing.bundle_id, missing.id) is None


def test_two_simultaneous_moves_preserve_both_rows(session: Session, library_root: Path) -> None:
    (library_root / "x").mkdir()
    (library_root / "y").mkdir()
    (library_root / "x" / "a.mp4").write_text("alpha")
    (library_root / "y" / "b.mp4").write_text("beta")
    scan_library(session, library_root)
    ids = {f.id for f in session.scalars(select(AssetFile))}

    (library_root / "z").mkdir()
    (library_root / "x" / "a.mp4").rename(library_root / "z" / "a.mp4")
    (library_root / "y" / "b.mp4").rename(library_root / "z" / "b.mp4")
    summary = scan_library(session, library_root)

    assert summary.created == 0 and summary.missing == 0
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 2
    assert {f.id for f in session.scalars(select(AssetFile))} == ids


def test_ambiguous_content_match_without_identity_is_skipped() -> None:
    # Two disappeared rows with identical fingerprint + basename and *no* trusted
    # filesystem identity (e.g. a network mount): an appeared path matches both,
    # so the move is ambiguous and must not be auto-repaired.
    from datetime import UTC, datetime

    from cairndex.domain.enums import FileRole, MediaKind
    from cairndex.scanning.scanner import _Observed, _plan_repairs

    def row(rid: str, rel: str) -> AssetFile:
        return AssetFile(
            id=rid,
            bundle_id="bnd",
            relative_path=rel,
            original_filename="dup.mp4",
            display_title="dup.mp4",
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
            quick_fingerprint="10:5",
            identity_available=False,
        )

    missing = [row("r1", "x/dup.mp4"), row("r2", "y/dup.mp4")]
    obs = _Observed(
        rel="z/dup.mp4",
        name="dup.mp4",
        size=10,
        mtime=datetime.now(UTC),
        fingerprint="10:5",
        device=0,
        inode=0,
        identity_available=False,
        kind=MediaKind.VIDEO,
        role=FileRole.PRIMARY_VIDEO,
    )
    assert _plan_repairs([obs], missing) == []  # two candidates → no repair
