"""Scanner: idempotency, missing-file state, no full-hashing, cancellation."""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import FileAvailability, JobStatus, JobType
from cairndex.jobs.worker import execute_job
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.scanner import scan_storage_root
from cairndex.services import jobs as job_service
from cairndex.services import storage_roots as root_service


def _make_root(session: Session, tmp_path: Path) -> tuple[str, Path]:
    media = tmp_path / "media"
    (media / "Show" / "S01").mkdir(parents=True)
    (media / "Show" / "S01" / "ep1.mkv").write_text("video one")
    (media / "Show" / "S01" / "ep2.mkv").write_text("video two")
    (media / "Show" / "cover.jpg").write_text("poster")
    (media / "Show" / "ep1.en.srt").write_text("subs")
    (media / "Show" / "notes.txt").write_text("ignored")  # unknown ext -> skipped
    root = root_service.create_storage_root(session, name="lib", canonical_path=str(media))
    session.commit()
    return root.id, media


def _file_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(AssetFile)) or 0


def test_scan_discovers_media_and_skips_unknown(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    summary = scan_storage_root(session, root_id)

    # 2 videos + 1 image + 1 subtitle = 4; notes.txt skipped.
    assert summary.discovered == 4
    assert summary.created == 4
    assert _file_count(session) == 4
    # Default grouping: one bundle per file.
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 4


def test_rescan_is_idempotent_no_duplicates(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    scan_storage_root(session, root_id)
    second = scan_storage_root(session, root_id)

    assert second.created == 0
    assert second.updated == 4
    assert _file_count(session) == 4  # unchanged


def test_scan_does_not_full_hash(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    scan_storage_root(session, root_id)
    files = list(session.scalars(select(AssetFile)))
    assert all(f.full_hash is None for f in files)  # never full-hashed on scan
    assert all(f.quick_fingerprint is not None for f in files)  # but fingerprinted


def test_missing_file_is_marked_not_deleted(session: Session, tmp_path: Path) -> None:
    root_id, media = _make_root(session, tmp_path)
    scan_storage_root(session, root_id)

    (media / "Show" / "S01" / "ep2.mkv").unlink()  # remove from disk
    summary = scan_storage_root(session, root_id)

    assert summary.missing == 1
    assert _file_count(session) == 4  # row preserved, not deleted
    gone = session.scalar(select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv"))
    assert gone is not None
    assert gone.availability == FileAvailability.MISSING


def test_returning_file_becomes_available_again(session: Session, tmp_path: Path) -> None:
    root_id, media = _make_root(session, tmp_path)
    scan_storage_root(session, root_id)
    target = media / "Show" / "S01" / "ep2.mkv"
    target.unlink()
    scan_storage_root(session, root_id)
    target.write_text("video two again")  # repaired on disk
    scan_storage_root(session, root_id)

    repaired = session.scalar(
        select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv")
    )
    assert repaired is not None
    assert repaired.availability == FileAvailability.AVAILABLE


def test_unreachable_root_marks_files_missing(session: Session, tmp_path: Path) -> None:
    root_id, media = _make_root(session, tmp_path)
    scan_storage_root(session, root_id)
    # Point the root at a now-missing path (simulate an unmounted NAS).
    root = root_service.get_storage_root(session, root_id)
    root.canonical_path = str(tmp_path / "unmounted")
    session.commit()

    summary = scan_storage_root(session, root_id)
    assert summary.missing == 4
    assert _file_count(session) == 4  # nothing deleted


def test_scan_can_be_cancelled_and_retried(
    session_factory: sessionmaker[Session], tmp_path: Path
) -> None:
    with session_factory() as session:
        root_id, _ = _make_root(session, tmp_path)

    # Run a scan job with batch_size=1 and cancellation requested up front:
    # the handler aborts at the first checkpoint, keeping the first file.
    with session_factory() as session:
        job = job_service.create_job(
            session, type=JobType.SCAN, payload={"storage_root_id": root_id, "batch_size": 1}
        )
        job_service.request_cancel(session, job.id)
        session.commit()
        cancel_job_id = job.id

    from cairndex.jobs.registry import build_registry

    status = execute_job(session_factory, cancel_job_id, build_registry())
    assert status == JobStatus.CANCELLED
    with session_factory() as session:
        partial = _file_count(session)
        assert 1 <= partial < 4  # some, but not all, committed before cancel

    # Retry: a fresh scan job completes and reaches the full set (idempotent).
    with session_factory() as session:
        retry = job_service.create_job(
            session, type=JobType.SCAN, payload={"storage_root_id": root_id}
        )
        session.commit()
        retry_id = retry.id

    assert execute_job(session_factory, retry_id, build_registry()) == JobStatus.SUCCEEDED
    with session_factory() as session:
        assert _file_count(session) == 4
