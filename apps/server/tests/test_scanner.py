"""Scanner: idempotency, missing-file state, no full-hashing, cancellation."""

from pathlib import Path

from sqlalchemy import event, func, select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingPlanStatus,
    GroupingSource,
    GroupingState,
    JobStatus,
    JobType,
    MediaKind,
)
from cairndex.grouping import plan_store
from cairndex.grouping.service import suggest_for_session
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import execute_job
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetBundle, AssetFile, GroupingPlan
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
    assert summary.missing_total == 1
    assert _file_count(session) == 4  # row preserved, not deleted
    gone = session.scalar(select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv"))
    assert gone is not None
    assert gone.availability == FileAvailability.MISSING

    second = scan_library(session, library_root)
    assert second.missing == 0  # newly missing this run
    assert second.missing_total == 1  # still linked and missing overall


def test_returning_file_becomes_available_again(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    target = library_root / "Show" / "S01" / "ep2.mkv"
    target.unlink()
    scan_library(session, library_root)
    target.write_text("video two again")
    restored = scan_library(session, library_root)

    repaired = session.scalar(
        select(AssetFile).where(AssetFile.relative_path == "Show/S01/ep2.mkv")
    )
    assert repaired is not None
    assert repaired.availability == FileAvailability.AVAILABLE
    assert restored.missing_total == 0


def test_unreachable_root_marks_files_missing(
    session: Session, library_root: Path, tmp_path: Path
) -> None:
    _make_media(library_root)
    scan_library(session, library_root)
    # Scan against a now-missing root (simulate an unmounted NAS).
    summary = scan_library(session, tmp_path / "unmounted")
    assert summary.missing == 4
    assert summary.missing_total == 4
    assert _file_count(session) == 4  # nothing deleted


# Hidden library metadata/cache directories are never scanned as assets
def test_scan_ignores_hidden_directories(session: Session, library_root: Path) -> None:
    (library_root / ".cairndex" / "cache" / "thumbnails" / "01").mkdir(parents=True, exist_ok=True)
    (library_root / ".cairndex" / "cache" / "thumbnails" / "01" / "thumb.jpg").write_text("cache")
    (library_root / "visible.jpg").write_text("image")

    summary = scan_library(session, library_root)

    assert summary.discovered == 1
    assert summary.created == 1
    rels = set(session.scalars(select(AssetFile.relative_path)).all())
    assert rels == {"visible.jpg"}


# Previously scanned hidden cache rows are safe to drop when they were provisional
def test_scan_removes_previously_staged_hidden_rows(session: Session, library_root: Path) -> None:
    bundle = AssetBundle(
        title="thumb",
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(bundle)
    session.flush()
    session.add(
        AssetFile(
            bundle_id=bundle.id,
            relative_path=".cairndex/cache/thumbnails/01/thumb.jpg",
            original_filename="thumb.jpg",
            display_title="thumb.jpg",
            role=FileRole.COVER,
            media_kind=MediaKind.IMAGE,
        )
    )
    session.commit()

    scan_library(session, library_root)

    assert session.scalar(select(func.count()).select_from(AssetFile)) == 0
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 0


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


# Scan jobs persist suggestions but leave discovered bundles provisional
def test_scan_job_generates_grouping_plan_without_applying(
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    (library_root / "Cosmos").mkdir()
    (library_root / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Cosmos" / "cosmos.en.srt").write_text("s")

    with registry_session_factory() as reg:
        job = job_service.create_job(reg, library_id=library_id, job_type=JobType.SCAN)
        reg.commit()
        job_id = job.id

    assert execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED
    with registry_session_factory() as reg:
        result = job_service.get_job(reg, job_id).result

    assert result is not None
    assert result["missing_total"] == 0
    assert result["grouping_plan_id"]
    assert result["grouping_proposal_count"] == 1

    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        maker = sessionmaker(eng)
        with maker() as db:
            plan = db.get(GroupingPlan, result["grouping_plan_id"])
            assert plan is not None
            assert plan.status is GroupingPlanStatus.OPEN
            assert len(plan.proposals) == 1
            states = set(db.scalars(select(AssetBundle.grouping_state)).all())
            assert states == {GroupingState.PROVISIONAL}
    finally:
        eng.dispose()


def test_a_scan_only_job_writes_no_plan_and_reports_none(
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    """Discovery on its own, which is what "Scan new files" asks for.

    Grouping is the reviewable step in the same menu; running it here made one
    menu item do the other's work and put its dialog on screen at the end of a
    scan (owner-reported, 2026-08-15). The client opens that dialog off the two
    grouping keys in the result, so a scan-only pass must report neither.
    """
    (library_root / "Set07").mkdir()
    (library_root / "Set07" / "clip1.mp4").write_text("v")
    (library_root / "Set07" / "clip1.en.srt").write_text("s")

    with registry_session_factory() as reg:
        job = job_service.create_job(
            reg,
            library_id=library_id,
            job_type=JobType.SCAN,
            payload={"suggest_grouping": False},
        )
        reg.commit()
        job_id = job.id

    assert execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED
    with registry_session_factory() as reg:
        result = job_service.get_job(reg, job_id).result

    assert result is not None
    assert result["discovered"] == 2  # the scan itself still ran
    assert result["grouping_plan_id"] is None
    assert result["grouping_proposal_count"] == 0

    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        with sessionmaker(eng)() as db:
            assert list(db.scalars(select(GroupingPlan))) == []
    finally:
        eng.dispose()


def test_a_second_scan_keeps_the_plan_it_already_wrote(
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    """Update must not rewrite an identical plan, or discard the review with it.

    A plan is a snapshot of suggestions over the files not yet in a confirmed
    bundle. If a scan finds nothing new, moved, or missing, that set is unchanged
    and so is every suggestion over it — so regenerating writes a few hundred rows
    of identical content and supersedes the plan the owner was working through.

    On local disk that is milliseconds. On a library whose database is on a network
    share it was **seven minutes**, every press of Update, because the cost is
    scattered journaled page writes rather than a few statements
    (owner-reported, 2026-08-13).
    """
    for index in range(4):
        folder = library_root / f"Set{index}"
        folder.mkdir()
        (folder / f"clip{index}.mp4").write_text("v")
        (folder / f"clip{index}.jpg").write_text("i")

    def update() -> dict[str, object]:
        with registry_session_factory() as reg:
            job = job_service.create_job(reg, library_id=library_id, job_type=JobType.SCAN)
            reg.commit()
            job_id = job.id
        assert (
            execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED
        )
        with registry_session_factory() as reg:
            result = job_service.get_job(reg, job_id).result
        assert result is not None
        return result

    first = update()
    second = update()

    # The same plan, not a fresh one holding the same suggestions.
    assert second["grouping_plan_id"] == first["grouping_plan_id"]
    assert second["grouping_proposal_count"] == first["grouping_proposal_count"]

    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        with sessionmaker(eng)() as db:
            plans = list(db.scalars(select(GroupingPlan)))
            assert len(plans) == 1, "a second scan wrote a second plan"
            assert plans[0].status is GroupingPlanStatus.OPEN
    finally:
        eng.dispose()

    # A real change still regenerates.
    (library_root / "Set0" / "extra.mp4").write_text("v")
    third = update()
    assert third["grouping_plan_id"] != first["grouping_plan_id"]


def test_a_first_scan_inserts_in_a_bounded_number_of_statements(
    session: Session, library_root: Path
) -> None:
    """A scan of new files must not cost a round trip per file.

    It cost two: `session.add(bundle); session.flush()` inside the loop, purely so
    the file could learn its bundle's id — which `UlidPk` makes known before the
    insert, since it defaults to a plain Python callable. On a library whose
    database sits on a network share, where one statement costs about 36 ms, that
    was a minute per thousand new files, and it is what made **Update** take
    minutes (owner-reported, 2026-08-13). `persist_plan` had the same shape.

    Bound is on statements, loose on purpose: what matters is that it does not grow
    with the number of files.
    """
    for index in range(60):
        folder = library_root / f"Set{index:02d}"
        folder.mkdir()
        for part in range(4):
            (folder / f"Set{index:02d}.{part}.mp4").write_text("v")
            (folder / f"Set{index:02d}.{part}.jpg").write_text("i")

    statements: list[str] = []
    bind = session.get_bind()

    def record(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        statements.append(statement)

    event.listen(bind, "before_cursor_execute", record)
    try:
        summary = scan_library(session, library_root)
        session.commit()
    finally:
        event.remove(bind, "before_cursor_execute", record)

    assert summary.created == 480
    assert len(statements) <= 30, (
        f"a first scan of {summary.created} files issued {len(statements)} statements"
    )


def test_writing_grouping_suggestions_reports_its_own_progress(
    session: Session, library_root: Path
) -> None:
    """The grouping phase must count its work, not just animate.

    It was one opaque call, so on a large library the bar ran indeterminate for
    tens of seconds under a label that never changed — which reads as a hang
    (owner-reported, 2026-08-13). Suggesting recurses a directory tree and has no
    count to offer, so it says what it is doing; writing the rows does have one.
    """
    for index in range(6):
        folder = library_root / f"Set{index}"
        folder.mkdir()
        (folder / f"clip{index}.mp4").write_text("v")
    scan_library(session, library_root)
    data = suggest_for_session(session)
    seen: list[tuple[int, int]] = []

    plan_store.persist_plan(
        session, data, on_progress=lambda done, total: seen.append((done, total))
    )

    assert len(seen) == len(data.proposals) >= 6
    assert seen[0] == (1, len(data.proposals))
    assert seen[-1] == (len(data.proposals), len(data.proposals))


def test_progress_is_reported_for_a_library_smaller_than_one_batch(
    session: Session, library_root: Path
) -> None:
    """Progress must not be welded to the commit batch size.

    It used to fire only on `processed % batch_size == 0`, with batch_size 200.
    Any library smaller than one batch therefore reported nothing until the
    scan was over — the owner watched a bar sit at zero for a 79-file library
    and had no idea what the scan was doing (2026-07-30).

    Committing per file is still the wrong trade on a large library, so the two
    cadences are deliberately different: this asserts the reporting one.
    """
    _make_media(library_root)  # 4 media files, far below any sane batch size
    seen: list[tuple[int, int | None]] = []

    summary = scan_library(
        session,
        library_root,
        on_progress=lambda processed, total: seen.append((processed, total)),
        batch_size=200,
    )

    assert summary.discovered == 4
    # One call per file during the walk, plus the final report.
    assert [processed for processed, _ in seen] == [1, 2, 3, 4, 4]
    # A first scan has no idea how many files there are and does not pretend to:
    # the exact total used to come from a second full walk, which on a library over
    # a network share cost about as much again as the scan.
    assert all(total is None for _, total in seen)

    # A re-scan does know, because the rows it is about to revisit are the estimate.
    again: list[tuple[int, int | None]] = []
    scan_library(session, library_root, on_progress=lambda p, t: again.append((p, t)))
    assert all(total == 4 for _, total in again)
