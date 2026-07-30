"""Journal-mode lifecycle for library databases (ADR-0021).

The journal mode lives in the database *file header*, not on a connection, and
these tests assert on those header bytes wherever the claim is about the file.
A ``PRAGMA journal_mode`` answer would pass just as happily against a connection
that never wrote anything through — and the whole incident behind this ADR was a
pragma reporting a mode nobody had actually achieved.

The filesystem seam is patched rather than mocked at the SQLite level: whether a
mount can host WAL is a genuine property of the machine running the tests, and
the interesting cases (SMB, NFS) cannot be created on demand in a temp dir.
"""

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from cairndex.core.errors import LibraryDatabaseOpenError
from cairndex.persistence import journal
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.journal import (
    ROLLBACK,
    WAL,
    FilesystemInfo,
    diagnose_open_failure,
    journal_mode_in_file,
)
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import create_registry_engine
from cairndex.registry.library_engine import (
    close_library_engines,
    dispose_library_engine,
    get_library_sessionmaker,
)
from cairndex.registry.models import RegisteredLibrary


def _registered(root: Path, library_id: str) -> RegisteredLibrary:
    return RegisteredLibrary(
        id=library_id,
        library_uuid="x" * 26,
        name="Test",
        root_path=str(root),
        manifest_path=str(pkg.manifest_path(root)),
    )


def _write_rows(maker, count: int = 100) -> None:  # type: ignore[no-untyped-def]
    with maker() as session:
        session.execute(text("CREATE TABLE IF NOT EXISTS t (x INTEGER)"))
        for i in range(count):
            session.execute(text("INSERT INTO t VALUES (:x)"), {"x": i})
        session.commit()


@pytest.fixture
def on_a_network_filesystem(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every path look like it lives on an SMB share."""
    monkeypatch.setattr(
        journal, "filesystem_for", lambda _path: FilesystemInfo(kind="smbfs", local=False)
    )


# --- reading the mode out of the file --------------------------------------


def test_the_header_reports_the_mode_of_a_file_we_never_opened(tmp_path: Path) -> None:
    """The property the whole design rests on: mode is a property of the file."""
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE t (x INTEGER)")
    assert journal_mode_in_file(db) == ROLLBACK

    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
    assert journal_mode_in_file(db) == WAL


def test_a_missing_or_too_short_file_has_no_recorded_mode(tmp_path: Path) -> None:
    assert journal_mode_in_file(tmp_path / "nope.db") is None
    stub = tmp_path / "stub.db"
    stub.write_bytes(b"not a database")
    assert journal_mode_in_file(stub) is None


# --- the registry keeps WAL -------------------------------------------------


def test_the_registry_database_stays_in_wal(tmp_path: Path) -> None:
    """It lives on the server's own disk and never travels, so none of the
    portability argument applies to it (ADR-0021)."""
    db = tmp_path / "registry.db"
    engine = create_registry_engine(database_url=f"sqlite:///{db.as_posix()}")
    try:
        assert journal_mode_in_file(db) == WAL
    finally:
        engine.dispose()

    # And it is still WAL at rest — nothing reverts it on the way out.
    assert journal_mode_in_file(db) == WAL


# --- a library uses WAL while it is open ------------------------------------


def test_an_open_library_is_in_wal(library_root: Path, library_id: str) -> None:
    get_library_sessionmaker(_registered(library_root, library_id))

    assert journal_mode_in_file(pkg.db_path(library_root)) == WAL


def test_a_clean_close_leaves_the_library_in_rollback_mode(
    library_root: Path, library_id: str
) -> None:
    """The fix, stated as the file an operator would find afterwards.

    Asserted on the header rather than a pragma: a library at rest in WAL cannot
    be opened over SMB or NFS at all, and that is a fact about these two bytes.
    """
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    _write_rows(maker)
    db = pkg.db_path(library_root)
    assert journal_mode_in_file(db) == WAL

    close_library_engines()

    assert journal_mode_in_file(db) == ROLLBACK
    assert not Path(f"{db}-wal").exists()
    assert not Path(f"{db}-shm").exists()


def test_the_data_written_in_wal_survives_the_conversion(
    library_root: Path, library_id: str
) -> None:
    library = _registered(library_root, library_id)
    _write_rows(get_library_sessionmaker(library))

    close_library_engines()

    with sqlite3.connect(pkg.db_path(library_root)) as conn:
        assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 100


def test_unregistering_a_library_leaves_it_in_rollback_mode(
    library_root: Path, library_id: str
) -> None:
    """Letting go of a library is a clean close like any other."""
    get_library_sessionmaker(_registered(library_root, library_id))

    dispose_library_engine(library_id)

    assert journal_mode_in_file(pkg.db_path(library_root)) == ROLLBACK


def test_losing_ownership_does_not_rewrite_the_journal_mode(
    library_root: Path, library_id: str
) -> None:
    """ADR-0018 §4: a library another server took gets no more writes from us —
    and converting the journal mode is a write. The new holder sets what it
    wants when it opens."""
    get_library_sessionmaker(_registered(library_root, library_id))

    dispose_library_engine(library_id, revert_journal_mode=False)

    assert journal_mode_in_file(pkg.db_path(library_root)) == WAL


# --- the residual risk, and the heal ----------------------------------------


def test_an_unclean_stop_leaves_the_library_in_wal(library_root: Path, library_id: str) -> None:
    """The accepted residual risk of ADR-0021, pinned so it stays visible.

    ``docker kill``, power loss or the OOM killer never reach the clean-close
    path, and the file keeps the WAL flag — which is exactly the state that locks
    a machine reaching the folder over a share out of it.
    """
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    _write_rows(maker)

    _simulate_crash(library_id)

    assert journal_mode_in_file(pkg.db_path(library_root)) == WAL


def test_the_next_capable_open_heals_a_library_left_in_wal(
    library_root: Path, library_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Item 5 of the design: an open that decides this library should not be in
    WAL, and finds it in WAL, converts it. Cannot help the machine already
    locked out — it never gets this far — but it repairs the library the first
    time a capable machine opens it.

    The crash happens on a local filesystem and the re-open on a network one,
    which is the shape of the incident: a container with local access left the
    library in WAL, and the machine that reaches the same folder over a share is
    the one that has to live with it.
    """
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    _write_rows(maker)
    _simulate_crash(library_id)
    assert journal_mode_in_file(pkg.db_path(library_root)) == WAL

    monkeypatch.setattr(
        journal, "filesystem_for", lambda _path: FilesystemInfo(kind="nfs4", local=False)
    )
    get_library_sessionmaker(_registered(library_root, library_id))

    assert journal_mode_in_file(pkg.db_path(library_root)) == ROLLBACK


def test_a_library_on_a_network_filesystem_is_never_put_into_wal(
    library_root: Path, library_id: str, on_a_network_filesystem: None
) -> None:
    """Explicit rather than resting on the pragma's silent no-op — which is what
    made the original bug invisible from the owner's Mac for so long."""
    maker = get_library_sessionmaker(_registered(library_root, library_id))
    _write_rows(maker)

    assert journal_mode_in_file(pkg.db_path(library_root)) == ROLLBACK


def _simulate_crash(library_id: str) -> None:
    """Drop the engine the way a killed process does: connections go away, no
    checkpoint and no conversion run."""
    dispose_library_engine(library_id, revert_journal_mode=False)


# --- identifying the filesystem ---------------------------------------------


def test_network_filesystems_are_refused_wal() -> None:
    for kind in ("smbfs", "smb3", "cifs", "nfs", "nfs4", "afpfs", "fuse.sshfs", "webdav"):
        assert FilesystemInfo(kind=kind).can_host_wal is False, kind


def test_local_filesystems_may_host_wal() -> None:
    for kind in ("apfs", "ext4", "btrfs", "xfs", "overlay", "zfs"):
        assert FilesystemInfo(kind=kind, local=True).can_host_wal is True, kind


def test_an_unidentified_filesystem_gets_the_benefit_of_the_doubt() -> None:
    """Unknown must not silently mean "no WAL" — the answer is settled by
    reading back what SQLite actually did, not by guessing here."""
    assert FilesystemInfo().can_host_wal is True


def test_a_mount_reported_as_non_local_is_refused_whatever_it_is_called() -> None:
    """macOS answers the question directly (``MNT_LOCAL``), so an unfamiliar
    network filesystem needs no name in our list."""
    assert FilesystemInfo(kind="somethingnew", local=False).can_host_wal is False


#: One line per mount, in the real ``/proc/self/mountinfo`` shape: the fields
#: before the ``-`` describe the mount, those after it the filesystem. Invented
#: paths — the point is the parsing, and Linux is where it runs in production.
_MOUNTINFO = """\
21 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw
22 21 0:24 / /srv/tank rw,relatime shared:5 - zfs tank rw
23 22 0:52 / /srv/tank/media\\040archive rw,relatime shared:9 - cifs //nas/media rw
24 21 0:60 / /mnt/exported rw,relatime shared:11 - nfs4 nas:/export rw
"""


@pytest.mark.parametrize(
    ("path", "kind", "can_host_wal"),
    [
        ("/var/lib/cairndex/library.db", "ext4", True),
        ("/srv/tank/library.db", "zfs", True),
        # The nearest enclosing mount wins, not the first or the shortest — a
        # library root can itself contain a mount point (docs/deployment.md).
        ("/srv/tank/media archive/.cairndex/library.db", "cifs", False),
        ("/mnt/exported/.cairndex/library.db", "nfs4", False),
    ],
)
def test_a_linux_mount_table_is_read_correctly(
    tmp_path: Path, path: str, kind: str, can_host_wal: bool
) -> None:
    """Linux is the deployment target, so its parsing is tested from anywhere.

    Includes an octal-escaped space in a mount point, which ``mountinfo`` writes
    as ``\\040`` and which would otherwise split the line's fields apart.
    """
    mountinfo = tmp_path / "mountinfo"
    mountinfo.write_text(_MOUNTINFO, encoding="utf-8")

    info = journal._linux_filesystem(Path(path), mountinfo)

    assert info.kind == kind
    assert info.can_host_wal is can_host_wal


def test_an_unreadable_mount_table_is_not_an_answer(tmp_path: Path) -> None:
    """Unknown, so the caller attempts WAL and reads back what SQLite did."""
    info = journal._linux_filesystem(Path("/anything"), tmp_path / "absent")

    assert info == FilesystemInfo()


def test_the_real_filesystem_of_a_temp_dir_is_identified(tmp_path: Path) -> None:
    """A weak assertion on purpose — a temp dir is local on every machine that
    runs this suite, and the point is that identification returns *something*
    rather than falling through to unknown on the platforms we support."""
    info = journal.filesystem_for(tmp_path / "library.db")
    assert info.can_host_wal is True


# --- the legible failure ----------------------------------------------------


def test_a_wal_library_on_a_network_filesystem_explains_itself(
    tmp_path: Path, on_a_network_filesystem: None
) -> None:
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE t (x INTEGER)")

    failure = diagnose_open_failure(db)

    assert failure.reason == "wal_on_network_filesystem"
    assert failure.filesystem == "smbfs"
    # The recovery command, with the path it needs — the whole point of the
    # error existing at all.
    assert "PRAGMA journal_mode=DELETE" in failure.message
    assert str(db) in failure.message


def test_a_permissions_problem_is_not_blamed_on_wal(tmp_path: Path) -> None:
    """The two produce the same ``unable to open database file`` from SQLite, and
    telling an operator to convert a journal mode that is already fine would send
    them down the wrong path entirely."""
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE t (x INTEGER)")

    failure = diagnose_open_failure(db)

    assert failure.reason == "unreadable"
    assert "journal_mode" not in failure.message


def test_a_missing_database_says_so(tmp_path: Path) -> None:
    failure = diagnose_open_failure(tmp_path / "gone" / "library.db")

    assert failure.reason == "missing"


def _raise_cannot_open(*_args: object, **_kwargs: object) -> str:
    """SQLite's refusal, as it arrives wrapped by SQLAlchemy."""
    raise OperationalError("SELECT 1", {}, sqlite3.OperationalError("unable to open database file"))


def test_an_unopenable_library_raises_a_domain_error_not_a_traceback(
    tmp_path: Path, on_a_network_filesystem: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end through ``create_app_engine``: SQLite's bare
    ``unable to open database file`` becomes an error naming the cause and the
    command that fixes it.

    The failure is injected because a filesystem that refuses WAL cannot be
    conjured in a temp directory; everything downstream of the raise — the
    diagnosis, the message, the structured details — is the real code.
    """
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE t (x INTEGER)")

    monkeypatch.setattr(journal, "apply_library_journal_mode", _raise_cannot_open)

    with pytest.raises(LibraryDatabaseOpenError) as caught:
        create_app_engine(database_url=f"sqlite:///{db.as_posix()}")

    error = caught.value
    assert error.code == "library_database_unopenable"
    assert error.details == {"reason": "wal_on_network_filesystem", "filesystem": "smbfs"}
    assert "PRAGMA journal_mode=DELETE" in error.message


def test_the_details_carry_no_filesystem_path(
    tmp_path: Path, on_a_network_filesystem: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``DomainError.details`` is serialized as-is to every client; the one path
    an operator needs belongs in the human-readable message instead."""
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA journal_mode=WAL")

    monkeypatch.setattr(journal, "apply_library_journal_mode", _raise_cannot_open)

    with pytest.raises(LibraryDatabaseOpenError) as caught:
        create_app_engine(database_url=f"sqlite:///{db.as_posix()}")

    assert str(tmp_path) not in repr(caught.value.details)


def test_an_unrelated_failure_is_not_disguised_as_a_journal_problem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*_args: object, **_kwargs: object) -> str:
        raise OperationalError(
            "SELECT 1", {}, sqlite3.OperationalError("database disk image is malformed")
        )

    monkeypatch.setattr(journal, "apply_library_journal_mode", _boom)

    with pytest.raises(OperationalError):
        create_app_engine(database_url=f"sqlite:///{(tmp_path / 'library.db').as_posix()}")


# --- through the API --------------------------------------------------------


def test_browsing_a_locked_out_library_returns_a_409_that_says_how_to_fix_it(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
    on_a_network_filesystem: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reported symptom, end to end.

    ``GET …/bundles/browse`` on a library left in WAL and reached over SMB was a
    bare 500 whose traceback ended at a pragma. The library here is a real
    package with a real WAL database on a filesystem that says it cannot host
    one; only SQLite's refusal to open it is injected, because no temp directory
    can be made to refuse WAL on demand.
    """
    root = tmp_path / "locked-out"
    root.mkdir()
    pkg.create_package(root, "Locked Out")
    library = registry_service.register_existing_library(registry_session, root_path=str(root))
    registry_session.commit()

    with sqlite3.connect(pkg.db_path(root)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
    monkeypatch.setattr(journal, "apply_library_journal_mode", _raise_cannot_open)

    response = isolated_client.get(f"/api/v1/libraries/{library.id}/bundles/browse")

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "library_database_unopenable"
    assert body["details"] == {"reason": "wal_on_network_filesystem", "filesystem": "smbfs"}
    assert "PRAGMA journal_mode=DELETE" in body["message"]
