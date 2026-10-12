"""Retained metadata, exact retries, and confined conversion publication."""

import shutil
import sqlite3
from contextlib import closing
from uuid import uuid4

import pytest

from cairndex.replicas.binding import BindingLock, bind
from cairndex.replicas.catalog import legacy_conversion as conversion
from cairndex.replicas.catalog import legacy_input
from cairndex.replicas.protocol import ReplicaError
from tests.test_legacy_conversion import _base, _join, _legacy, _tree


@pytest.mark.parametrize("kind", ["search-prefix", "sqlite-prefix"])
def test_unknown_entries_cannot_impersonate_derived_metadata(tmp_path, kind):
    root = _legacy(tmp_path)
    if kind == "search-prefix":
        with closing(sqlite3.connect(root / ".cairndex/library.db")) as db:
            db.execute("CREATE TABLE bundle_search_custom (value TEXT)")
            db.execute("INSERT INTO bundle_search_custom VALUES ('Synthetic retained value')")
            db.commit()
    else:
        (root / ".cairndex/library.db-extra").write_text("Synthetic retained value")
    before = _tree(root)
    assert conversion.inspect(root)["blocking"]
    with pytest.raises(ReplicaError):
        conversion.prepare(root, _base(tmp_path), uuid4().hex)
    assert _tree(root) == before


def test_known_search_index_and_os_entries_remain_in_the_backup(tmp_path):
    root = _legacy(tmp_path)
    with closing(sqlite3.connect(root / ".cairndex/library.db")) as db:
        db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS bundle_search USING fts5(title)")
        db.commit()
    for name in (".DS_Store", "._manifest.json", "Thumbs.db", "desktop.ini"):
        (root / ".cairndex" / name).write_text("Synthetic platform metadata")
    before = _tree(root / ".cairndex")
    base, attempt = _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    assert _tree(root / review["backup_name"]) == before


@pytest.mark.parametrize("linked", ["root", "parent"])
def test_staging_links_never_write_outside_the_selected_folder(tmp_path, linked):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    original = _tree(root / ".cairndex")
    outside = tmp_path / "outside"
    outside.mkdir()
    staging = root / (conversion.STAGING + attempt)
    if linked == "root":
        staging.symlink_to(outside, target_is_directory=True)
    else:
        staging.mkdir()
        (staging / "replica").symlink_to(outside, target_is_directory=True)
    with pytest.raises((OSError, ReplicaError)):
        conversion.activate(root, base, attempt, review["receipt"])
    assert not list(outside.iterdir())
    assert _tree(root / ".cairndex") == original
    assert not (root / review["backup_name"]).exists()


def test_activation_checks_the_database_again_after_staging(tmp_path):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)

    def edit(point):
        if point == "staged":
            with closing(sqlite3.connect(root / ".cairndex/library.db")) as db:
                db.execute(
                    "UPDATE asset_bundles SET title='Saved during staging' WHERE id='bundle-2'"
                )
                db.commit()

    with pytest.raises(ReplicaError, match="changed after review"):
        conversion.activate(root, base, attempt, review["receipt"], fault=edit)
    assert not (root / review["backup_name"]).exists()
    with closing(sqlite3.connect(root / ".cairndex/library.db")) as db:
        assert db.execute("SELECT title FROM asset_bundles WHERE id='bundle-2'").fetchone() == (
            "Saved during staging",
        )


@pytest.mark.parametrize(
    "point",
    ["converted_retained", "legacy_restored", "store_retired", "binding_retired", "undo_completed"],
)
def test_interrupted_undo_retains_new_private_work_and_finishes_on_retry(tmp_path, point):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    original = _tree(root / ".cairndex")
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    store = _join(root, base / "replicas" / review["library_uuid"])
    store.draft("retained-draft", "bundle-0", 1, {"text": "Work after conversion"})
    guard = BindingLock(base, store.descriptor)
    try:
        bind(base, store.descriptor, "original", "initial")
    finally:
        guard.close()
    converted = _tree(root / ".cairndex")

    def interrupt(name):
        if name == point:
            raise RuntimeError("Synthetic interruption")

    with pytest.raises(RuntimeError):
        conversion.undo(root, base, attempt, review["receipt"], fault=interrupt)
    result = conversion.undo(root, base, attempt, review["receipt"])
    assert _tree(root / ".cairndex") == original
    assert _tree(root / result["retained"]) == converted
    retained = (
        conversion.workspace(base, review["library_uuid"], attempt) / "retired/store/replica.db"
    )
    with closing(sqlite3.connect(retained)) as db:
        assert (
            db.execute("SELECT body FROM drafts WHERE id='retained-draft'").fetchone() is not None
        )
    assert conversion.undo(root, base, attempt, review["receipt"]) == result


def test_undo_can_reverse_an_activation_interrupted_between_the_renames(tmp_path):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    original = _tree(root / ".cairndex")
    review = conversion.prepare(root, base, attempt)

    def interrupt(point):
        if point == "legacy_moved":
            raise RuntimeError("Synthetic interruption")

    with pytest.raises(RuntimeError):
        conversion.activate(root, base, attempt, review["receipt"], fault=interrupt)
    result = conversion.undo(root, base, attempt, review["receipt"])
    assert _tree(root / ".cairndex") == original
    joined_root = tmp_path / "joined-root"
    joined_root.mkdir()
    shutil.copytree(root / result["retained"], joined_root / ".cairndex")
    _join(joined_root, tmp_path / "joined")


def test_repeated_undo_never_rewinds_later_legacy_edits(tmp_path):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    result = conversion.undo(root, base, attempt, review["receipt"])
    with closing(sqlite3.connect(root / ".cairndex/library.db")) as db:
        db.execute("UPDATE asset_bundles SET title='Saved after Undo' WHERE id='bundle-2'")
        db.commit()
    before = _tree(root / ".cairndex")
    assert conversion.undo(root, base, attempt, review["receipt"]) == result
    assert _tree(root / ".cairndex") == before


def test_another_folder_or_a_changed_receipt_cannot_authorize_a_swap(tmp_path):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    other = tmp_path / "another-folder"
    other.mkdir()
    with pytest.raises(ReplicaError, match="same library folder"):
        conversion.activate(other, base, attempt, review["receipt"])
    conversion.activate(root, base, attempt, review["receipt"])
    before = _tree(root)
    with pytest.raises(ReplicaError, match="review changed"):
        conversion.undo(root, base, attempt, "0" * 64)
    assert _tree(root) == before


def test_fresh_lease_stops_inspection_before_copying_the_database(tmp_path, monkeypatch):
    from datetime import UTC, datetime

    from tests.test_legacy_conversion import _write_lease

    root = _legacy(tmp_path)
    _write_lease(root, datetime.now(UTC))

    def refuse(*args):
        raise AssertionError("A serving database must not be copied")

    monkeypatch.setattr(legacy_input, "_copy_database", refuse)
    assert conversion.inspect(root)["lease"] == "fresh"


def test_a_missing_catalog_schema_blocks_without_changing_the_package(tmp_path):
    root = _legacy(tmp_path)
    for name in ("library.db", "library.db-wal", "library.db-shm", "library.db-journal"):
        (root / ".cairndex" / name).unlink(missing_ok=True)
    with closing(sqlite3.connect(root / ".cairndex/library.db")):
        pass
    before = _tree(root)
    assert any("required table" in reason for reason in conversion.inspect(root)["blocking"])
    with pytest.raises(ReplicaError, match="required table"):
        conversion.prepare(root, _base(tmp_path), uuid4().hex)
    assert _tree(root) == before


def test_activation_cannot_resume_after_undo_started(tmp_path):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    conversion.undo(root, base, attempt, review["receipt"])
    before = _tree(root)
    with pytest.raises(ReplicaError, match="Undo started"):
        conversion.activate(root, base, attempt, review["receipt"])
    assert _tree(root) == before


def test_undo_refuses_another_private_history(tmp_path):
    from cairndex.replicas.binding import BindingLock, bind
    from cairndex.replicas.catalog.protocol import CatalogDescriptor

    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    descriptor = CatalogDescriptor.model_validate(review["descriptor"])
    other = descriptor.model_copy(update={"epoch": uuid4().hex})
    guard = BindingLock(base, other)
    try:
        bind(base, other, "original", "synthetic-other-history")
    finally:
        guard.close()
    before = _tree(root)
    with pytest.raises(ReplicaError, match="authority changed"):
        conversion.undo(root, base, attempt, review["receipt"])
    assert _tree(root) == before


@pytest.mark.parametrize("action", ["activate", "undo"])
def test_a_new_metadata_folder_between_renames_is_never_overwritten(tmp_path, action):
    root, base, attempt = _legacy(tmp_path), _base(tmp_path), uuid4().hex
    review = conversion.prepare(root, base, attempt)
    original = _tree(root / ".cairndex")
    if action == "undo":
        conversion.activate(root, base, attempt, review["receipt"])

    def arrive(point):
        if point == ("legacy_moved" if action == "activate" else "converted_retained"):
            metadata = root / ".cairndex"
            metadata.mkdir()
            (metadata / "arriving.txt").write_text("Synthetic arriving metadata")

    with pytest.raises(ReplicaError, match="destination already exists"):
        getattr(conversion, action)(root, base, attempt, review["receipt"], fault=arrive)
    assert (root / ".cairndex/arriving.txt").read_text() == "Synthetic arriving metadata"
    assert _tree(root / review["backup_name"]) == original
