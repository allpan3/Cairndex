"""Scanner: idempotency, missing-file state, no full-hashing, cancellation."""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import FileAvailability, JobStatus, JobType
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import execute_job
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.registry import jobs as job_service
from cairndex.registry import library_package as pkg
from cairndex.scanning.scanner import scan_library


def _make_media(root: Path) -> None:
    (root / "Show" / "S01").mkdir(parents=True)
    (root / "Show" / "S01" / "ep1.mkv").write_text("video one")
    (root / "Show" / "S01" / "ep2.mkv").write_text("video two")
    (root / "Show" / "cover.jpg").write_text("poster")
    (root / "Show" / "ep1.en.srt").write_text("subs")
    (root / "Show" / "notes.txt").write_text("ignored")  # unknown ext -> skipped


def _file_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(AssetFile)) or 0


def test_scan_discovers_media_and_skips_unknown(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    summary = scan_library(session, library_root)

    # 2 videos + 1 image + 1 subtitle = 4; notes.txt skipped.
    assert summary.discovered == 4
    assert summary.created == 4
    assert _file_count(session) == 4
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 4


def test_rescan_is_idempotent_no_duplicates(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    second = scan_library(session, library_root)

    assert second.created == 0
    assert second.updated == 4
    assert _file_count(session) == 4


def test_scan_does_not_full_hash(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    files = list(session.scalars(select(AssetFile)))
    assert all(f.full_hash is None for f in files)
    assert all(f.quick_fingerprint is not None for f in files)


def test_missing_file_is_marked_not_deleted(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    scan_library(session, library_root)

    (library_root / "Show" / "S01" / "ep2.mkv").unlink()
    summary = scan_library(session, library_root)

    assert summary.missing == 1
    assert _file_count(session) == 4  # row preserved, not deleted
    gone = session.scalar(select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv"))
    assert gone is not None
    assert gone.availability == FileAvailability.MISSING


def test_returning_file_becomes_available_again(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    target = library_root / "Show" / "S01" / "ep2.mkv"
    target.unlink()
    scan_library(session, library_root)
    target.write_text("video two again")
    scan_library(session, library_root)

    repaired = session.scalar(
        select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv")
    )
    assert repaired is not None
    assert repaired.availability == FileAvailability.AVAILABLE


def test_unreachable_root_marks_files_missing(
    session: Session, library_root: Path, tmp_path: Path
) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    # Scan against a now-missing root (simulate an unmounted NAS).
    summary = scan_library(session, tmp_path / "unmounted")
    assert summary.missing == 4
    assert _file_count(session) == 4  # nothing deleted


def _count_in_library(library_root: Path) -> int:
    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        with eng.connect() as conn:
            return conn.execute(select(func.count()).select_from(AssetFile.__table__)).scalar() or 0
    finally:
        eng.dispose()


def test_scan_can_be_cancelled_and_retried(
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    _make_media(library_root)

    # Cancellation requested up front: the handler aborts at the first checkpoint
    # during the walk. New-bundle creation is deferred until after the full walk,
    # so a mid-walk cancel commits no new bundles.
    with registry_session_factory() as reg:
        job = job_service.create_job(
            reg, library_id=library_id, job_type=JobType.SCAN, payload={"batch_size": 1}
        )
        job_service.request_cancel(reg, job.id)
        reg.commit()
        cancel_job_id = job.id

    status = execute_job(registry_session_factory, cancel_job_id, build_registry())
    assert status == JobStatus.CANCELLED
    assert _count_in_library(library_root) == 0  # creation is atomic-after-walk

    # Retry: a fresh scan job completes and reaches the full set (idempotent).
    with registry_session_factory() as reg:
        retry = job_service.create_job(reg, library_id=library_id, job_type=JobType.SCAN)
        reg.commit()
        retry_id = retry.id

    assert execute_job(registry_session_factory, retry_id, build_registry()) == JobStatus.SUCCEEDED
    assert _count_in_library(library_root) == 4
