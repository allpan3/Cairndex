"""Disposable conversion, interrupted preparation, and private upgrade boundaries."""

import json
import sqlite3
import subprocess
import sys

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import compare_checkpoints, export_legacy
from cairndex.replicas.catalog.migration import prepare, source_receipt
from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.protocol import CatalogDescriptor, UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.inventory import CONVERSION_AVAILABLE
from cairndex.replicas.private_layout import SOURCE_TABLES
from cairndex.replicas.protocol import ReplicaError


def test_format_three_preserves_all_cells_and_recovery(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=125)
    before = source_receipt(fixture)
    result = prepare(fixture)
    descriptor = result.store.descriptor
    assert descriptor.format_version == 3
    assert descriptor.catalog_version == 2 and descriptor.minimum_reader == 3
    assert descriptor.library_uuid == fixture.library_uuid
    assert descriptor.capabilities[-1] == "discovery_identity_v1"
    assert CONVERSION_AVAILABLE is False
    output = export_legacy(result)
    compare_checkpoints(fixture.source / ".cairndex/library.db", output / "library.db")
    compare_checkpoints(fixture.directory / "private/plans.db", output / "plans.db")
    assert source_receipt(fixture) == before
    assert (output / "manifest.json").read_bytes() == (
        fixture.source / ".cairndex/manifest.json"
    ).read_bytes()
    assert (output / "synthetic-auth.json").read_bytes() == (
        fixture.directory / "private/synthetic-auth.json"
    ).read_bytes()
    assert not list(result.package.rglob("*.db"))
    assert "auth" not in json.loads((result.package / ".cairndex/manifest.json").read_text())
    again = prepare(fixture)
    assert again.package == result.package
    assert again.store.descriptor == descriptor
    assert len(list(fixture.directory.glob("conversion-*"))) == 1


@pytest.mark.parametrize(
    "point",
    [
        "intent_complete",
        "checkpoint_complete",
        "seed_object",
        "reconstruction_complete",
        "before_descriptor",
        "after_descriptor",
        "before_receipt",
        "after_receipt",
    ],
)
def test_process_exit_retry_keeps_epoch_and_source(tmp_path, point):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    before = source_receipt(fixture)
    script = """
import os,sys
from pathlib import Path
from cairndex.devtools.catalog_fixture import DisposableCatalog
from cairndex.replicas.catalog.migration import prepare
fixture = DisposableCatalog(Path(sys.argv[1]), sys.argv[2])
def fault(point):
    if point == sys.argv[3]: os._exit(71)
prepare(fixture, fault=fault)
"""
    process = subprocess.run(
        [sys.executable, "-c", script, str(fixture.directory), fixture.library_uuid, point],
        capture_output=True,
        check=False,
    )
    assert process.returncode == 71, process.stderr.decode()
    intent = json.loads((fixture.directory / "migration/intent.json").read_text())
    attempts = set(fixture.directory.glob("conversion-*"))
    result = prepare(fixture)
    assert result.store.descriptor.epoch == intent["epoch"]
    assert attempts <= set(fixture.directory.glob("conversion-*"))
    assert source_receipt(fixture) == before
    for manifest in fixture.directory.glob("conversion-*/package/.cairndex/manifest.json"):
        assert (
            CatalogDescriptor.model_validate_json(manifest.read_bytes()) == result.store.descriptor
        )
    assert prepare(fixture).package == result.package


@pytest.mark.parametrize("mutation", ["metadata", "media", "private", "symlink"])
def test_changed_checkpoint_cannot_reuse_intent(tmp_path, mutation):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    prepare(fixture)
    if mutation == "metadata":
        with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
            db.execute("UPDATE asset_bundles SET notes='[\"Later note\"]'")
    elif mutation == "media":
        (fixture.source / "Synthetic/雪.mp4").write_bytes(b"Changed specimen")
    elif mutation == "private":
        with sqlite3.connect(fixture.directory / "private/plans.db") as db:
            db.execute("UPDATE grouping_proposals SET title='Later proposal'")
    else:
        (fixture.source / "linked").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ReplicaError):
        prepare(fixture)


@pytest.mark.parametrize("target", ["manifest", "object", "archive", "intent", "receipt"])
def test_changed_preparation_is_not_reported_ready(tmp_path, target):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    result = prepare(fixture)
    path = {
        "manifest": result.package / ".cairndex/manifest.json",
        "object": next(result.package.glob(".cairndex/replica/objects/*/*.json")),
        "archive": result.archive / "library.db",
        "intent": fixture.directory / "migration/intent.json",
        "receipt": fixture.directory / "migration/prepared.json",
    }[target]
    path.write_bytes(b"{}")
    with pytest.raises(ReplicaError):
        prepare(fixture)


def test_committed_wal_and_pending_work_survive_checkpoint(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("UPDATE asset_bundles SET title='Committed WAL title'")
        writer.commit()
        result = prepare(fixture)
        assert (
            json.loads(
                result.store.entity("asset_bundles", "bundle-000000")["fields"]["title"]["value"]
            )
            == "Committed WAL title"
        )
        assert prepare(fixture).package == result.package
        output = export_legacy(result)
        compare_checkpoints(fixture.source / ".cairndex/library.db", output / "library.db")
        compare_checkpoints(fixture.directory / "private/plans.db", output / "plans.db")


def test_rollback_after_edit_retains_drafts_jobs_and_retry_receipts(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    before = source_receipt(fixture)
    result = prepare(fixture)
    store = result.store
    unit = key("asset_bundles", "bundle-000000", "title")
    lifetime = key("asset_bundles", "bundle-000000", "$alive")
    changes = [
        UnitChange(unit=u, value=v, basis=[store.descriptor.genesis])
        for u, v in (
            (unit, '"Reviewed title"'),
            (lifetime, "true"),
        )
    ]
    parents = store.frontier()
    event = store.save(changes, "migration-edit", parents=parents)
    store.draft("migration-draft", "bundle-000000", 1, {"text": "Unsubmitted note"})
    jobs.enqueue(store, "pending-review", "preview", {"action": "invalid-retained-intent"})
    output = export_legacy(result)
    with sqlite3.connect(output / "library.db") as db:
        assert (
            db.execute("SELECT title FROM asset_bundles WHERE id='bundle-000000'").fetchone()[0]
            == "Reviewed title"
        )
        assert db.execute("SELECT relative_path FROM asset_files ORDER BY id").fetchall() == [
            ("Synthetic/雪.srt",),
            ("Synthetic/雪.mp4",),
        ]
        assert db.execute("SELECT count(*) FROM moments").fetchone()[0] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    with sqlite3.connect(output / "replica-recovery.db") as db:
        assert db.execute("SELECT count(*) FROM drafts").fetchone()[0] == 1
        assert (
            db.execute("SELECT state FROM catalog_jobs WHERE id='pending-review'").fetchone()[0]
            == "queued"
        )
        assert db.execute("SELECT count(*) FROM events WHERE id=?", (event,)).fetchone()[0] == 1
    assert source_receipt(fixture) == before
    assert prepare(fixture).store.save(changes, "migration-edit", parents=parents) == event


def test_private_additive_upgrade_is_not_library_conversion(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    result = prepare(fixture)
    descriptor_bytes = (result.package / ".cairndex/manifest.json").read_bytes()
    before = source_receipt(fixture)
    with result.store.connection() as db:
        existing = dict(db.execute("SELECT name,type FROM sqlite_master"))
        for name in sorted(SOURCE_TABLES, key=lambda n: existing[n] == "table"):
            db.execute(f'DROP {existing[name]} "{name}"')
    upgraded = CatalogStore(result.store.path.parent, result.store.descriptor)
    with upgraded.connection() as db:
        assert {row[0] for row in db.execute("SELECT name FROM sqlite_master")} >= SOURCE_TABLES
    assert upgraded.status()["ready"]
    assert (result.package / ".cairndex/manifest.json").read_bytes() == descriptor_bytes
    assert source_receipt(fixture) == before
    with upgraded.connection() as db:
        db.execute("CREATE TABLE unknown_private_state (id TEXT)")
    with pytest.raises(ReplicaError, match="Unknown"):
        CatalogStore(upgraded.path.parent, upgraded.descriptor)


@pytest.mark.parametrize("mutation", ["index", "version", "table_definition", "pending", "trash"])
def test_unqualified_schema_or_unresolved_source_work_blocks_preparation(tmp_path, mutation):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        if mutation == "index":
            db.execute("CREATE INDEX unknown_index ON asset_bundles(title)")
        elif mutation == "version":
            db.execute("PRAGMA user_version=99")
        elif mutation == "table_definition":
            db.execute("PRAGMA writable_schema=ON")
            before = db.execute(
                "SELECT sql FROM sqlite_master WHERE name='asset_bundles'"
            ).fetchone()[0]
            db.execute(
                "UPDATE sqlite_master SET sql=replace(sql,'title VARCHAR(1024)','title BLOB') "
                "WHERE type='table' AND name='asset_bundles'"
            )
            assert (
                db.execute("SELECT sql FROM sqlite_master WHERE name='asset_bundles'").fetchone()[0]
                != before
            )
        elif mutation == "pending":
            db.execute("UPDATE file_operations SET status='PENDING'")
        else:
            db.execute("UPDATE file_operations SET status='DONE',op='TRASH'")
    with pytest.raises(ReplicaError):
        prepare(fixture)
    assert not list(fixture.directory.glob("conversion-*/package/.cairndex/manifest.json"))


def test_format_three_preserves_shared_edit_bookkeeping(tmp_path):
    from sqlalchemy import create_engine, event

    from cairndex.metadata.schema import ensure_metadata_schema

    fixture = create_disposable(parent=tmp_path, bundles=3)
    source = fixture.source / ".cairndex/library.db"
    engine = create_engine(f"sqlite:///{source}")

    @event.listens_for(engine, "connect")
    def attach(db, _):
        db.execute("ATTACH DATABASE ? AS plans", (str(fixture.directory / "private/plans.db"),))

    ensure_metadata_schema(engine)
    engine.dispose()
    result = prepare(fixture)
    output = export_legacy(result)
    compare_checkpoints(source, output / "library.db")
    compare_checkpoints(fixture.directory / "private/plans.db", output / "plans.db")
