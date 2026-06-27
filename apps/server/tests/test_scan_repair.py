"""Moved-file repair: a same-volume move keeps the AssetFile.id and all metadata.

Covers AGENTS.md §5.3: high-confidence moves update the existing row in place;
ambiguous matches, copies, and same-path edits do not spawn or merge bundles.
"""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.scanner import scan_storage_root
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services import storage_roots as root_service


def _root(session: Session, tmp_path: Path) -> tuple[str, Path]:
    media = tmp_path / "media"
    media.mkdir()
    root = root_service.create_storage_root(session, name="lib", canonical_path=str(media))
    session.commit()
    return root.id, media


def _only_file(session: Session) -> AssetFile:
    f = session.scalar(select(AssetFile))
    assert f is not None
    return f


def test_same_volume_move_repairs_in_place(session: Session, tmp_path: Path) -> None:
    root_id, media = _root(session, tmp_path)
    (media / "a").mkdir()
    src = media / "a" / "movie.mp4"
    src.write_text("the movie bytes")
    scan_storage_root(session, root_id)

    f = _only_file(session)
    original_id, bundle_id = f.id, f.bundle_id
    # Decorate the bundle with metadata that must survive the repair.
    collection = collection_service.create_collection(session, name="Films")
    bundle_service.set_bundle_collections(session, bundle_id, [collection.id])
    bundle_service.update_bundle(session, bundle_id, {"rating": 5, "note": "keep me"})
    bundle_service.update_bundle(session, bundle_id, {"cover_file_id": original_id})
    session.commit()

    # Move it (same volume → same inode).
    (media / "b").mkdir()
    src.rename(media / "b" / "movie.mp4")

    summary = scan_storage_root(session, root_id)
    assert summary.repaired == 1
    assert summary.created == 0
    assert summary.missing == 0

    # Same AssetFile row and bundle; new path; still available.
    assert session.scalar(select(func.count()).select_from(AssetFile)) == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    moved = _only_file(session)
    assert moved.id == original_id
    assert moved.bundle_id == bundle_id
    assert moved.relative_path == "b/movie.mp4"
    assert moved.availability == FileAvailability.AVAILABLE

    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    assert bundle.rating == 5 and bundle.note == "keep me"
    assert bundle.cover_file_id == original_id
    assert {c.name for c in bundle.collections} == {"Films"}


def test_same_path_edit_is_update_not_move(session: Session, tmp_path: Path) -> None:
    root_id, media = _root(session, tmp_path)
    f_path = media / "clip.mp4"
    f_path.write_text("v1")
    scan_storage_root(session, root_id)
    original_id = _only_file(session).id

    f_path.write_text("a much longer version 2")  # same path, new size/mtime
    summary = scan_storage_root(session, root_id)

    assert summary.repaired == 0
    assert summary.created == 0
    assert summary.updated == 1
    f = _only_file(session)
    assert f.id == original_id and f.relative_path == "clip.mp4"


def test_copy_does_not_merge_or_repair(session: Session, tmp_path: Path) -> None:
    root_id, media = _root(session, tmp_path)
    src = media / "orig.mp4"
    src.write_text("content")
    scan_storage_root(session, root_id)

    # A copy at a new path while the original stays put: the original is not a
    # disappeared row, so the copy must become its own new bundle (no merge).
    (media / "copy.mp4").write_bytes(src.read_bytes())
    summary = scan_storage_root(session, root_id)

    assert summary.repaired == 0
    assert summary.created == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 2


def test_missing_file_stays_visible_when_no_match(session: Session, tmp_path: Path) -> None:
    root_id, media = _root(session, tmp_path)
    (media / "gone.mp4").write_text("bytes")
    scan_storage_root(session, root_id)
    original_id = _only_file(session).id

    (media / "gone.mp4").unlink()  # deleted, nothing appears to match it
    summary = scan_storage_root(session, root_id)

    assert summary.repaired == 0
    assert summary.missing == 1
    f = _only_file(session)
    assert f.id == original_id  # row preserved, not deleted
    assert f.availability == FileAvailability.MISSING


def test_two_simultaneous_moves_preserve_both_rows(session: Session, tmp_path: Path) -> None:
    root_id, media = _root(session, tmp_path)
    (media / "x").mkdir()
    (media / "y").mkdir()
    (media / "x" / "a.mp4").write_text("alpha")
    (media / "y" / "b.mp4").write_text("beta")
    scan_storage_root(session, root_id)
    ids = {f.id for f in session.scalars(select(AssetFile))}

    (media / "z").mkdir()
    (media / "x" / "a.mp4").rename(media / "z" / "a.mp4")
    (media / "y" / "b.mp4").rename(media / "z" / "b.mp4")
    summary = scan_storage_root(session, root_id)

    # Each move is uniquely identified (by inode), so both repair in place; never
    # a merge and never a duplicate.
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
        f = AssetFile(
            id=rid,
            bundle_id="bnd",
            storage_root_id="r",
            relative_path=rel,
            original_filename="dup.mp4",
            display_title="dup.mp4",
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
            quick_fingerprint="10:5",
            identity_available=False,
        )
        return f

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
