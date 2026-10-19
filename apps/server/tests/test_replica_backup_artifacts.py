"""Live backups tolerate SQLite sidecar removal while rejecting unsafe artifacts."""

from pathlib import Path

import pytest

from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.recovery import check_store_files


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_last_connection_can_remove_a_listed_sidecar(tmp_path, monkeypatch, suffix):
    (tmp_path / "replica.db").write_bytes(b"synthetic database")
    sidecar = tmp_path / f"replica.db{suffix}"
    sidecar.write_bytes(b"synthetic SQLite sidecar")
    original = Path.iterdir

    def listed_then_removed(path):
        entries = list(original(path))
        if path == tmp_path:
            sidecar.unlink()
        return iter(entries)

    monkeypatch.setattr(Path, "iterdir", listed_then_removed)
    check_store_files(tmp_path)


@pytest.mark.parametrize("kind", ["directory", "symlink", "unknown"])
def test_live_backup_still_refuses_unsafe_artifacts(tmp_path, kind):
    database = tmp_path / "replica.db"
    database.write_bytes(b"synthetic database")
    sidecar = tmp_path / "replica.db-wal"
    if kind == "directory":
        sidecar.mkdir()
    elif kind == "symlink":
        sidecar.symlink_to(database)
    else:
        (tmp_path / "unclassified").write_bytes(b"synthetic unknown artifact")
    with pytest.raises(ReplicaError):
        check_store_files(tmp_path)


@pytest.mark.parametrize("name", ["replica.db", "unclassified"])
def test_disappearing_primary_or_unknown_entry_has_no_sidecar_exception(
    tmp_path, monkeypatch, name
):
    (tmp_path / "replica.db").write_bytes(b"synthetic database")
    disappearing = tmp_path / name
    disappearing.write_bytes(b"synthetic artifact")
    original = Path.iterdir

    def listed_then_removed(path):
        entries = list(original(path))
        if path == tmp_path:
            disappearing.unlink()
        return iter(entries)

    monkeypatch.setattr(Path, "iterdir", listed_then_removed)
    with pytest.raises(ReplicaError):
        check_store_files(tmp_path)
