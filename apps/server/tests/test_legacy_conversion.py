"""Owner conversion of legacy packages: inspection, preparation, activation and Undo."""

import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from cairndex.devtools.catalog_fixture import insert_row, synthetic_row
from cairndex.registry import library_package as pkg
from cairndex.replicas.catalog import legacy_conversion as conversion
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError


def _tree(folder: Path) -> dict[str, str]:
    return {
        path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    }


def _legacy(tmp_path: Path) -> Path:
    """A package made by the legacy code path, with rows in each converted family."""
    root = (tmp_path / "Library").resolve()
    root.mkdir()
    pkg.create_package(root, "Synthetic old library")
    (root / "Synthetic").mkdir()
    (root / "Synthetic" / "clip.mp4").write_bytes(b"synthetic media bytes\n")
    metadata = root / ".cairndex"
    (metadata / "trash" / "operation-trash").mkdir(parents=True)
    (metadata / "trash" / "operation-trash" / "old.txt").write_text("synthetic trash\n")
    with closing(sqlite3.connect(metadata / "library.db")) as db:
        for index in range(3):
            insert_row(
                db,
                "asset_bundles",
                synthetic_row(
                    "asset_bundles",
                    f"bundle-{index}",
                    title=f"Synthetic bundle {index}",
                    notes='["first note"]' if index else None,
                    extra_metadata="{}",
                    last_opened_at="2026-01-02 03:04:05.000001" if index == 0 else None,
                    cover_file_id="file-video" if index == 0 else None,
                    primary_file_id="file-video" if index == 0 else None,
                ),
            )
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "file-video",
                bundle_id="bundle-0",
                relative_path="Synthetic/clip.mp4",
                directory_path="Synthetic",
                original_filename="clip.mp4",
                display_title="clip.mp4",
                role="PRIMARY_VIDEO",
                tech_metadata="{}",
            ),
        )
        for suffix, parent in (("root", None), ("child", "tags-root")):
            insert_row(
                db,
                "tags",
                synthetic_row("tags", f"tags-{suffix}", parent_id=parent, name=suffix),
            )
        insert_row(db, "asset_bundle_tags", {"bundle_id": "bundle-0", "tag_id": "tags-child"})
        insert_row(
            db,
            "collections",
            synthetic_row("collections", "collection-one", parent_id=None, name="Synthetic"),
        )
        insert_row(
            db,
            "asset_bundle_collections",
            {"bundle_id": "bundle-1", "collection_id": "collection-one", "sort_order": 3},
        )
        insert_row(
            db,
            "playback_progress",
            synthetic_row("playback_progress", "file-video", bundle_id="bundle-0", position_s=12.5),
        )
        for identity, op in (("operation-trash", "TRASH"), ("operation-rename", "RENAME")):
            insert_row(
                db,
                "file_operations",
                synthetic_row("file_operations", identity, op=op, status="DONE", payload="{}"),
            )
        db.commit()
    return root


def _base(tmp_path: Path) -> Path:
    base = (tmp_path / "data").resolve()
    base.mkdir(exist_ok=True)
    return base


def _join(root: Path, directory: Path) -> CatalogStore:
    """Reconstruct the published package the way another server joins it."""
    descriptor = CatalogDescriptor.model_validate(
        json.loads((root / ".cairndex" / "manifest.json").read_bytes())
    )
    store = CatalogStore(directory, descriptor)
    objects = sorted((root / ".cairndex" / "replica" / "objects").glob("*/*.json"))
    for file in objects:
        store.ingest(file.read_bytes())
    for _ in range(len(objects) + 1):
        store.import_batch()
    assert store.status()["ready"] and not store.status()["blocked"]
    return store


def _rows(store: CatalogStore, family: str) -> dict[str, dict[str, object]]:
    with store.connection() as db:
        return {
            row["entity"]: json.loads(row["body"])
            for row in db.execute("SELECT entity,body FROM catalog_rows WHERE family=?", (family,))
        }


def test_inspect_reports_what_converts_and_what_stays(tmp_path):
    root = _legacy(tmp_path)
    before = _tree(root / ".cairndex")
    report = conversion.inspect(root)
    assert report["blocking"] == []
    assert report["lease"] == "absent"
    assert report["converts"]["bundles"] == 3
    assert report["converts"]["files"] == 1
    assert report["converts"]["tags"] == 2
    assert report["stays_in_backup"]["resume_positions"] == 1
    assert report["stays_in_backup"]["last_opened"] == 1
    assert report["stays_in_backup"]["trashed_items"] == 1
    assert report["caches"] is True and report["passphrase"] is False
    assert _tree(root / ".cairndex") == before


def test_conversion_publishes_a_package_that_another_server_can_join(tmp_path):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    legacy = _tree(root / ".cairndex")
    media = _tree(root / "Synthetic")
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)
    assert _tree(root / ".cairndex") == legacy
    assert sorted(path.name for path in root.iterdir()) == [".cairndex", "Synthetic"]
    result = conversion.activate(root, base, attempt, review["receipt"])
    assert result["state"] == "converted"
    # The old folder is kept byte for byte under the reviewed backup name
    assert _tree(root / review["backup_name"]) == legacy
    assert _tree(root / "Synthetic") == media
    manifest = pkg.detect(root)
    assert manifest is not None and manifest.replica is not None
    assert manifest.library_uuid == review["library_uuid"]
    store = _join(root, tmp_path / "joined")
    bundles = _rows(store, "asset_bundles")
    assert sorted(bundles) == ["bundle-0", "bundle-1", "bundle-2"]
    assert bundles["bundle-1"]["title"] == "Synthetic bundle 1"
    assert set(_rows(store, "tags")) == {"tags-root", "tags-child"}
    # A repeated activation reports the same finished conversion
    assert conversion.activate(root, base, attempt, review["receipt"])["state"] == "converted"


def test_older_schema_receives_the_defaults_of_its_upgrades(tmp_path):
    root = _legacy(tmp_path)
    with closing(sqlite3.connect(root / ".cairndex" / "library.db")) as db:
        db.execute("DROP INDEX IF EXISTS ix_asset_bundles_manual_order")
        for index in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='asset_bundles' "
            "AND sql LIKE '%manual_order%'"
        ).fetchall():
            db.execute(f'DROP INDEX "{index[0]}"')
        db.execute("ALTER TABLE asset_bundles DROP COLUMN manual_order")
        db.execute("ALTER TABLE asset_bundles ADD COLUMN note TEXT")
        db.execute("UPDATE asset_bundles SET note='single note' WHERE id='bundle-0'")
        db.execute("CREATE TABLE grouping_plans (id TEXT PRIMARY KEY)")
        db.execute("INSERT INTO grouping_plans VALUES ('plan-one')")
        db.commit()
    report = conversion.inspect(root)
    assert report["blocking"] == []
    assert report["stays_in_backup"]["retired_notes"] == 1
    assert report["stays_in_backup"]["grouping_suggestions"] == 1
    base = _base(tmp_path)
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)
    bundles = _rows(conversion.store_at(base, review), "asset_bundles")
    assert {row["manual_order"] for row in bundles.values()} == {0}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ("CREATE TABLE unknown_rows (id TEXT)", "unknown table"),
        ("ALTER TABLE tags ADD COLUMN unknown_value TEXT", "unknown column"),
        (
            "INSERT INTO file_operations (id,op,status,payload,created_at) "
            "VALUES ('pending-op','MOVE','PENDING','{}','2026-01-01 00:00:00')",
            "did not finish",
        ),
    ],
)
def test_unsupported_content_blocks_without_changes(tmp_path, change, message):
    root = _legacy(tmp_path)
    with closing(sqlite3.connect(root / ".cairndex" / "library.db")) as db:
        db.execute(change)
        db.commit()
    before = _tree(root)
    assert any(message in reason for reason in conversion.inspect(root)["blocking"])
    with pytest.raises(ReplicaError):
        conversion.prepare(root, _base(tmp_path), uuid4().hex)
    assert _tree(root) == before


def _write_lease(root: Path, heartbeat: datetime) -> None:
    lease = root / ".cairndex" / "locks" / "active-owner.json"
    lease.parent.mkdir(exist_ok=True)
    lease.write_text(
        json.dumps(
            {
                "server_uuid": "synthetic-server",
                "machine_name": "Synthetic machine",
                "advertised_url": None,
                "acquired_at": heartbeat.isoformat(),
                "heartbeat_at": heartbeat.isoformat(),
                "nonce": "synthetic-nonce",
            }
        )
    )


def test_a_serving_old_version_blocks_and_a_stale_lease_needs_confirmation(tmp_path):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    _write_lease(root, datetime.now(UTC))
    assert conversion.inspect(root)["lease"] == "fresh"
    with pytest.raises(ReplicaError, match="serving this library"):
        conversion.prepare(root, base, uuid4().hex)
    _write_lease(root, datetime.now(UTC) - timedelta(hours=1))
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)
    assert review["inspection"]["lease"] == "stale"
    with pytest.raises(ReplicaError, match="Confirm"):
        conversion.activate(root, base, attempt, review["receipt"])
    # The old version resumes serving after review: confirmation cannot override it
    _write_lease(root, datetime.now(UTC))
    with pytest.raises(ReplicaError, match="serving this library"):
        conversion.activate(root, base, attempt, review["receipt"], confirm_stale_lease=True)
    assert pkg.detect(root).replica is None
    _write_lease(root, datetime.now(UTC) - timedelta(hours=1))
    result = conversion.activate(root, base, attempt, review["receipt"], confirm_stale_lease=True)
    assert result["state"] == "converted"


def test_activation_refuses_a_library_that_changed_after_review(tmp_path):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)
    with closing(sqlite3.connect(root / ".cairndex" / "library.db")) as db:
        db.execute("UPDATE asset_bundles SET title='Edited later' WHERE id='bundle-2'")
        db.commit()
    before = _tree(root)
    with pytest.raises(ReplicaError, match="changed after review"):
        conversion.activate(root, base, attempt, review["receipt"])
    assert _tree(root) == before
    with pytest.raises(ReplicaError, match="review changed"):
        conversion.activate(root, base, attempt, "0" * 64)


@pytest.mark.parametrize("point", ["staged", "legacy_moved", "published"])
def test_an_interrupted_activation_finishes_on_retry(tmp_path, point):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    legacy = _tree(root / ".cairndex")
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)

    def stop(name: str) -> None:
        if name == point:
            raise RuntimeError("synthetic interruption")

    with pytest.raises(RuntimeError):
        conversion.activate(root, base, attempt, review["receipt"], fault=stop)
    result = conversion.activate(root, base, attempt, review["receipt"])
    assert result["state"] == "converted"
    assert _tree(root / review["backup_name"]) == legacy
    assert sorted(path.name for path in root.iterdir()) == sorted(
        [".cairndex", review["backup_name"], "Synthetic"]
    )
    _join(root, tmp_path / "joined")


def test_undo_restores_the_old_folder_and_keeps_the_converted_one(tmp_path):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    legacy = _tree(root / ".cairndex")
    attempt = uuid4().hex
    review = conversion.prepare(root, base, attempt)
    conversion.activate(root, base, attempt, review["receipt"])
    converted = _tree(root / ".cairndex")
    result = conversion.undo(root, base, attempt, review["receipt"])
    assert _tree(root / ".cairndex") == legacy
    assert _tree(root / result["retained"]) == converted
    assert pkg.detect(root).replica is None
    assert conversion.undo(root, base, attempt, review["receipt"]) == result
    # A new attempt converts again under a new identity history
    second = uuid4().hex
    review = conversion.prepare(root, base, second)
    assert conversion.activate(root, base, second, review["receipt"])["state"] == "converted"


def test_preparation_is_idempotent_and_rejects_invalid_identities(tmp_path):
    root = _legacy(tmp_path)
    base = _base(tmp_path)
    attempt = uuid4().hex
    first = conversion.prepare(root, base, attempt)
    assert conversion.prepare(root, base, attempt)["receipt"] == first["receipt"]
    with pytest.raises(ReplicaError, match="Invalid"):
        conversion.prepare(root, base, "../escape")
    with pytest.raises(ReplicaError, match="outside the library"):
        conversion.prepare(root, root / "data", uuid4().hex)
