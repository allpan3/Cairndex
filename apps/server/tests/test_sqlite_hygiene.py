"""WAL checkpointing and consistent snapshots (ADR-0018 §6).

A library in WAL mode is three files on disk, and a cloud-sync engine uploads
whatever it happens to find. These tests assert on the *files*, because the file
set is precisely what the sync engine sees and therefore what the feature is
about.
"""

import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import Engine, text

from cairndex.persistence.checkpoint import (
    checkpoint_wal,
    snapshot_database,
    snapshot_path_for,
)
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.maintenance import SqliteMaintenance
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.library_engine import (
    close_library_engines,
    get_library_sessionmaker,
    maintain_library_engines,
)


def write_rows(engine: Engine, count: int = 500) -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS t (x INTEGER)"))
        for i in range(count):
            conn.execute(text("INSERT INTO t VALUES (:x)"), {"x": i})


def sidecar_sizes(db: Path) -> tuple[int, int]:
    wal = Path(f"{db}-wal")
    shm = Path(f"{db}-shm")
    return (
        wal.stat().st_size if wal.exists() else 0,
        shm.stat().st_size if shm.exists() else 0,
    )


# --- checkpointing --------------------------------------------------------


def test_writing_leaves_a_wal_that_a_sync_engine_would_pick_up(tmp_path: Path) -> None:
    """The problem statement, pinned: without a checkpoint the WAL just sits there."""
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
        wal_size, _ = sidecar_sizes(db)
        assert wal_size > 0
    finally:
        engine.dispose()


def test_a_checkpoint_truncates_the_wal_to_nothing(tmp_path: Path) -> None:
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
        assert checkpoint_wal(engine) is True
        # TRUNCATE, not PASSIVE: a passive checkpoint would leave the file at its
        # high-water mark, so the sync engine keeps shipping a large second file
        # that carries nothing.
        assert sidecar_sizes(db)[0] == 0
    finally:
        engine.dispose()


def test_data_survives_a_checkpoint(tmp_path: Path) -> None:
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
        checkpoint_wal(engine)
        with engine.connect() as conn:
            assert conn.execute(text("SELECT count(*) FROM t")).scalar_one() == 500
    finally:
        engine.dispose()


def test_a_clean_close_leaves_one_file(tmp_path: Path, library_id: str, library_root: Path) -> None:
    """The ADR's "clean close" outcome, asserted on the directory listing."""
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    with maker() as session:
        session.execute(text("CREATE TABLE IF NOT EXISTS t (x INTEGER)"))
        for i in range(500):
            session.execute(text("INSERT INTO t VALUES (:x)"), {"x": i})
        session.commit()

    db = pkg.db_path(library_root)
    assert sidecar_sizes(db)[0] > 0  # dirty before

    close_library_engines()

    assert db.is_file()
    assert not Path(f"{db}-wal").exists()
    assert not Path(f"{db}-shm").exists()


# --- snapshots ------------------------------------------------------------


def test_a_snapshot_is_a_readable_copy_of_the_database(tmp_path: Path) -> None:
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
    finally:
        engine.dispose()

    destination = snapshot_path_for(db)
    assert snapshot_database(db, destination) is True

    with sqlite3.connect(destination) as conn:
        assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 500


def test_a_snapshot_captures_data_still_sitting_in_the_wal(tmp_path: Path) -> None:
    """Why the backup API and not a file copy.

    A plain copy of ``library.db`` while a WAL is outstanding misses everything
    the WAL holds. The backup API reads a transactionally consistent view.
    """
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
        assert sidecar_sizes(db)[0] > 0  # uncheckpointed
        assert snapshot_database(db, snapshot_path_for(db)) is True
    finally:
        engine.dispose()

    with sqlite3.connect(snapshot_path_for(db)) as conn:
        assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 500


def test_a_snapshot_leaves_no_temporary_files_behind(tmp_path: Path) -> None:
    db = tmp_path / "library.db"
    engine = create_app_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        write_rows(engine)
    finally:
        engine.dispose()

    snapshot_database(db, snapshot_path_for(db))

    assert sorted(p.name for p in tmp_path.iterdir()) == ["library.db", "library.db.bak"]


def test_snapshotting_a_missing_database_reports_failure(tmp_path: Path) -> None:
    assert snapshot_database(tmp_path / "nope.db", tmp_path / "nope.db.bak") is False


def test_the_snapshot_lives_beside_the_db_inside_the_marker_dir(library_root: Path) -> None:
    """So it travels with the library and can never be mistaken for media."""
    snapshot = snapshot_path_for(pkg.db_path(library_root))
    assert snapshot.parent == pkg.marker_dir(library_root)
    assert snapshot.name == "library.db.bak"


# --- the maintenance pass -------------------------------------------------


def _registered(library_root: Path, library_id: str):  # type: ignore[no-untyped-def]
    from cairndex.registry.models import RegisteredLibrary

    return RegisteredLibrary(
        id=library_id,
        library_uuid="x" * 26,
        name="Test",
        root_path=str(library_root),
        manifest_path=str(pkg.manifest_path(library_root)),
    )


def test_an_active_library_is_left_alone(library_root: Path, library_id: str) -> None:
    """A checkpoint competes with live readers, and at-rest tidiness is the goal."""
    get_library_sessionmaker(_registered(library_root, library_id))

    checkpointed, _ = maintain_library_engines(
        idle_after=3600.0, snapshot_interval=0, library_ids={library_id}
    )

    assert checkpointed == 0


def test_an_idle_library_is_checkpointed(library_root: Path, library_id: str) -> None:
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    with maker() as session:
        session.execute(text("CREATE TABLE IF NOT EXISTS t (x INTEGER)"))
        for i in range(500):
            session.execute(text("INSERT INTO t VALUES (:x)"), {"x": i})
        session.commit()
    assert sidecar_sizes(pkg.db_path(library_root))[0] > 0

    checkpointed, _ = maintain_library_engines(
        idle_after=0.0, snapshot_interval=0, library_ids={library_id}
    )

    assert checkpointed == 1
    assert sidecar_sizes(pkg.db_path(library_root))[0] == 0


def test_an_idle_library_is_not_checkpointed_twice(library_root: Path, library_id: str) -> None:
    """Nothing changed since the last pass, so there is nothing to fold in."""
    get_library_sessionmaker(_registered(library_root, library_id))
    maintain_library_engines(idle_after=0.0, snapshot_interval=0, library_ids={library_id})

    checkpointed, _ = maintain_library_engines(
        idle_after=0.0, snapshot_interval=0, library_ids={library_id}
    )

    assert checkpointed == 0


def test_use_re_arms_the_checkpoint(library_root: Path, library_id: str) -> None:
    library = _registered(library_root, library_id)
    get_library_sessionmaker(library)
    maintain_library_engines(idle_after=0.0, snapshot_interval=0, library_ids={library_id})

    get_library_sessionmaker(library)  # used again — new writes may have landed
    checkpointed, _ = maintain_library_engines(
        idle_after=0.0, snapshot_interval=0, library_ids={library_id}
    )

    assert checkpointed == 1


def test_a_library_we_do_not_own_is_never_touched(library_root: Path, library_id: str) -> None:
    """Maintaining a library whose lease we lost would be writing to another
    server's library (ADR-0018 §4)."""
    get_library_sessionmaker(_registered(library_root, library_id))

    checkpointed, snapshotted = maintain_library_engines(
        idle_after=0.0, snapshot_interval=1.0, library_ids=set()
    )

    assert (checkpointed, snapshotted) == (0, 0)
    assert not snapshot_path_for(pkg.db_path(library_root)).exists()


def test_the_pass_writes_a_snapshot_when_one_is_due(library_root: Path, library_id: str) -> None:
    get_library_sessionmaker(_registered(library_root, library_id))

    _, snapshotted = maintain_library_engines(
        idle_after=0.0, snapshot_interval=1.0, library_ids={library_id}
    )

    assert snapshotted == 1
    assert snapshot_path_for(pkg.db_path(library_root)).is_file()


def test_snapshots_are_skipped_when_the_interval_is_disabled(
    library_root: Path, library_id: str
) -> None:
    get_library_sessionmaker(_registered(library_root, library_id))

    _, snapshotted = maintain_library_engines(
        idle_after=0.0, snapshot_interval=0, library_ids={library_id}
    )

    assert snapshotted == 0
    assert not snapshot_path_for(pkg.db_path(library_root)).exists()


def test_a_snapshot_is_not_rewritten_before_its_interval_elapses(
    library_root: Path, library_id: str
) -> None:
    get_library_sessionmaker(_registered(library_root, library_id))
    maintain_library_engines(idle_after=0.0, snapshot_interval=3600.0, library_ids={library_id})

    _, snapshotted = maintain_library_engines(
        idle_after=0.0, snapshot_interval=3600.0, library_ids={library_id}
    )

    assert snapshotted == 0


def test_the_maintenance_loop_only_covers_owned_libraries(
    library_root: Path, library_id: str
) -> None:
    get_library_sessionmaker(_registered(library_root, library_id))
    owned: set[str] = set()

    maintenance = SqliteMaintenance(
        owned_library_ids=lambda: owned,
        interval=60.0,
        idle_after=0.0,
        snapshot_interval=0,
    )
    assert maintenance.run_once() == (0, 0)

    owned.add(library_id)
    assert maintenance.run_once()[0] == 1


@pytest.fixture
def second_library(tmp_path: Path, registry_session) -> tuple[str, Path]:  # type: ignore[no-untyped-def]
    root = tmp_path / "second"
    root.mkdir()
    pkg.create_package(root, "Second")
    library = registry_service.register_existing_library(registry_session, root_path=str(root))
    registry_session.commit()
    return str(library.id), root


def test_maintenance_is_per_library(
    library_root: Path, library_id: str, second_library: tuple[str, Path]
) -> None:
    second_id, second_root = second_library
    get_library_sessionmaker(_registered(library_root, library_id))
    get_library_sessionmaker(_registered(second_root, second_id))

    maintain_library_engines(idle_after=0.0, snapshot_interval=1.0, library_ids={library_id})

    assert snapshot_path_for(pkg.db_path(library_root)).is_file()
    assert not snapshot_path_for(pkg.db_path(second_root)).exists()
