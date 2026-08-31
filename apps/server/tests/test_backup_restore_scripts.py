"""Integration tests for the release backup and restore shell helpers."""

from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKUP = _REPO_ROOT / "infra" / "backup.sh"
_RESTORE = _REPO_ROOT / "infra" / "restore.sh"


# Create one small SQLite database with a value worth recovering
def make_database(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE state (value TEXT NOT NULL)")
        connection.execute("INSERT INTO state VALUES (?)", (value,))


# Read the one test value from a database
def read_value(path: Path) -> str:
    with sqlite3.connect(path) as connection:
        return str(connection.execute("SELECT value FROM state").fetchone()[0])


# Return the backup path printed by backup.sh
def run_backup(database: Path, destination: Path) -> Path:
    result = subprocess.run(
        [_BACKUP, database, destination],
        check=True,
        capture_output=True,
        text=True,
    )
    output = result.stdout.removeprefix("backup ok: ")
    return Path(output.rsplit(" (", 1)[0])


def test_library_backups_use_uuid_and_never_collide(tmp_path: Path):
    backup_dir = tmp_path / "backups"
    outputs: list[Path] = []
    for library_uuid, value in (("library-one", "first"), ("library-two", "second")):
        marker = tmp_path / library_uuid / ".cairndex"
        database = marker / "library.db"
        make_database(database, value)
        (marker / "manifest.json").write_text(
            json.dumps({"library_uuid": library_uuid}), encoding="utf-8"
        )
        outputs.append(run_backup(database, backup_dir))

    assert outputs[0] != outputs[1]
    assert outputs[0].name.startswith("library-library-one-")
    assert outputs[1].name.startswith("library-library-two-")
    assert outputs[0].stat().st_mode & 0o777 == 0o600
    assert outputs[1].stat().st_mode & 0o777 == 0o600
    assert read_value(outputs[0]) == "first"
    assert read_value(outputs[1]) == "second"


def test_restore_is_guarded_atomic_and_keeps_the_previous_file(tmp_path: Path):
    database = tmp_path / "registry.db"
    backup_dir = tmp_path / "backups"
    make_database(database, "before")
    backup = run_backup(database, backup_dir)

    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE state SET value = 'after'")

    refused = subprocess.run([_RESTORE, backup, database], capture_output=True, text=True)
    assert refused.returncode == 2
    assert "--stopped" in refused.stderr

    subprocess.run([_RESTORE, "--stopped", backup, database], check=True)
    assert read_value(database) == "before"
    rollback = list(tmp_path.glob("registry.db.pre-restore-*"))
    assert len(rollback) == 1
    assert read_value(rollback[0]) == "after"


def test_restore_refuses_a_database_with_wal_sidecars(tmp_path: Path):
    database = tmp_path / "registry.db"
    backup_dir = tmp_path / "backups"
    make_database(database, "value")
    backup = run_backup(database, backup_dir)
    wal = Path(f"{database}-wal")
    wal.touch()

    result = subprocess.run(
        [_RESTORE, "--stopped", backup, database], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert str(wal) in result.stderr


@pytest.mark.parametrize("label", ["../escape", "space leak", "/absolute"])
def test_backup_rejects_unsafe_labels(tmp_path: Path, label: str):
    database = tmp_path / "registry.db"
    make_database(database, "value")
    result = subprocess.run(
        [_BACKUP, database, tmp_path / "backups", label], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert "backup label" in result.stderr
