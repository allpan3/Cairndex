"""Synthetic private backup and recovery exercises actual saves, jobs, failures and activation"""

import json
import shutil
import sqlite3
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.devtools.replica_fixture import create_fixture
from cairndex.replicas import recovery
from cairndex.replicas.binding import BindingLock, binding_file, location, read_json, write_json
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import Change, ReplicaError, canonical, checksum
from cairndex.replicas.recovery_cli import inspect, main, retry_job
from cairndex.replicas.recovery_validation import (
    file_hash,
    open_store,
    reader,
    settle,
    table_hash,
)
from cairndex.replicas.store import Store
from cairndex.replicas.transport import Transport


# Independent synthetic stores obtain seed bytes through the ordinary immutable importer
@pytest.fixture
def replica(tmp_path):
    conversion = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    root, base = conversion.package, tmp_path / "server"
    store = CatalogStore(
        base / "replicas" / conversion.store.descriptor.library_uuid, conversion.store.descriptor
    )
    deliver(conversion.store, store)
    return root, base, store


# Delivery is deliberately reversed and duplicate-safe, with no external provider or network
def deliver(source, target):
    with source.connection(readonly=True) as db:
        for (raw,) in db.execute("SELECT raw FROM events ORDER BY id DESC"):
            target.ingest(raw)
    settle(target)


# Build an actual editor intent with the opening lifetime basis and observed frontier
def intent(store, value, field="title"):
    entity = store.entity("asset_bundles", "bundle-000000")
    return {
        "changes": [
            {
                "unit": entity["fields"][name]["unit"],
                "value": canonical(cell).decode(),
                "basis": entity["fields"][name]["basis"],
                "cohort": None,
            }
            for name, cell in ((field, value), ("$alive", True))
        ],
        "parents": entity["parents"],
        "resolve": False,
        "recover": False,
    }


# Save with the exact retained client request rather than refreshing its bases during retry
def save(store, body, operation):
    return store.save(
        [UnitChange.model_validate(change) for change in body["changes"]],
        operation,
        parents=body["parents"],
        resolve=body["resolve"],
        recover=body["recover"],
    )


# Reopening uses the same binding lookup as production service activation
def restored(root, base, review):
    result = recovery.activate(root, base, review["id"], review["receipt"])
    assert result["state"] == "active"
    path, _ = location(base, recovery.descriptor_at(root))
    return open_store(path, recovery.descriptor_at(root))


# Author IDs are private, while immutable operations retain their archived authors forever
def author(store):
    with store.connection(readonly=True) as db:
        return db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]


# A backup contains unexchanged work, exact drafts, conflict alternatives and job retry receipts
def test_backup_restore_unpublished_conflicts_drafts_jobs_and_two_authors(replica, tmp_path):
    root, base, original = replica
    peer = CatalogStore(tmp_path / "peer", original.descriptor)
    deliver(original, peer)
    old = intent(original, "Unpublished Amber")
    saved = save(original, old, "saved-before-backup")
    save(peer, intent(peer, "Delayed Blue"), "peer-blue")
    deliver(peer, original)
    original.draft("editor", "asset_bundles/bundle-000000", 3, old)
    original.dismiss_draft("dismissed", 7)
    queued = intent(original, 4.5, "rating")
    jobs.enqueue(original, "pending-rating", "save", queued)
    jobs.enqueue(original, "response-lost", "save", intent(original, '["Retained note"]', "notes"))
    jobs.run_one(original)
    jobs.run_one(original)
    # Simulate a process exit after the save committed but before its job receipt was recorded
    with original.connection() as db:
        db.execute("UPDATE catalog_jobs SET state='running',result=NULL WHERE id='response-lost'")
    jobs.enqueue(original, "unstarted", "save", intent(original, 3.5, "rating"))
    backup = tmp_path / "backup"
    report = recovery.backup(root, base, backup)
    assert report["inventory"]["outbox"] > 0
    assert report["inventory"]["tables"]["drafts"] == 1
    assert report["inventory"]["tables"]["catalog_holds"] > 0
    hashes = {item.name: file_hash(item) for item in backup.iterdir()}
    stores = []
    for name in ("restore-a", "restore-b"):
        destination = tmp_path / name
        review = recovery.prepare(root, destination, backup)
        assert review["backup_only_events"] > 0 and review["state"] == "prepared"
        store = restored(root, destination, review)
        stores.append(store)
        assert save(store, old, "saved-before-backup") == saved
        with pytest.raises(ReplicaError, match="different work"):
            save(store, old | {"recover": True}, "saved-before-backup")
        assert store.drafts("asset_bundles/bundle-000000")["items"][0]["body"] == old
        assert store.entity("asset_bundles", "bundle-000000")["has_conflicts"]
        assert jobs.job(store, "response-lost")["state"] == "failed"
        entry = next(
            item
            for item in inspect(destination, review["id"], "jobs", "", 50)["items"]
            if item["id"] == "response-lost"
        )
        retry_job(root, destination, "response-lost", entry["intent_receipt"])
        with store.connection() as db:
            before = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        jobs.run_one(store)
        assert jobs.job(store, "response-lost")["state"] == "succeeded"
        with store.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == before
        assert jobs.job(store, "unstarted")["state"] == "failed"
    assert len({author(original), *(author(store) for store in stores)}) == 3
    # The original returns later with another independent edit and does not lose either restore
    save(original, intent(original, '["Original returns"]', "notes"), "original-later")
    for index, store in enumerate(stores):
        save(store, intent(store, f"Restored {index}"), f"restored-{index}")
    for source in (original, *stores):
        for target in (original, *stores):
            if target is not source:
                deliver(source, target)
    for store in (original, *stores):
        entity = store.entity("asset_bundles", "bundle-000000")
        assert len(entity["fields"]["title"]["candidates"]) == 2
        assert json.loads(entity["fields"]["notes"]["value"]) == '["Original returns"]'
    assert hashes == {item.name: file_hash(item) for item in backup.iterdir()}


# The snapshot observes one committed state while edits, drafts and private media updates continue
def test_coherent_backup_during_writes(replica, tmp_path):
    root, base, store = replica
    started = threading.Event()
    stop = threading.Event()

    # Each synthetic generation commits related private records together
    def writer():
        for revision in range(1, 500):
            if stop.is_set():
                return
            with store.connection() as db:
                db.execute(
                    "INSERT OR REPLACE INTO drafts VALUES ('live','owner',?,?)",
                    (revision, canonical({"revision": revision}).decode()),
                )
                db.execute(
                    "INSERT OR REPLACE INTO local_progress VALUES ('file-video','token',?,NULL,0)",
                    (revision,),
                )
            started.set()

    with ThreadPoolExecutor() as pool:
        future = pool.submit(writer)
        assert started.wait(5)
        output = tmp_path / "hot-backup"
        recovery.backup(root, base, output)
        stop.set()
        future.result()
    with closing(reader(output / "replica.db")) as db:
        revision, body = db.execute("SELECT revision,body FROM drafts WHERE id='live'").fetchone()
        assert json.loads(body)["revision"] == revision
        assert db.execute("SELECT position FROM local_progress").fetchone()[0] == revision


# Byte corruption, unknown layouts and semantically incomplete receipts cannot activate
@pytest.mark.parametrize(
    "damage",
    [
        "truncate",
        "checksum",
        "wrong-authority",
        "future-version",
        "unknown-table",
        "unknown-column",
        "trigger",
        "missing-media",
        "missing-event",
        "bad-reference",
        "bad-retry",
        "bad-parent",
    ],
)
def test_reject_invalid_backups(replica, tmp_path, damage):
    root, base, store = replica
    save(store, intent(store, "Saved"), "saved")
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    database = output / "replica.db"
    if damage == "truncate":
        database.write_bytes(database.read_bytes()[:100])
    elif damage == "checksum":
        database.write_bytes(database.read_bytes() + b"changed")
    else:
        statements = {
            "wrong-authority": "UPDATE config SET value='[]' WHERE key='identity'",
            "future-version": "PRAGMA user_version=999",
            "unknown-table": "CREATE TABLE future_private_data (id TEXT)",
            "unknown-column": "ALTER TABLE drafts ADD COLUMN future TEXT",
            "trigger": "CREATE TRIGGER unexpected AFTER INSERT ON drafts "
            "BEGIN DELETE FROM events; END",
            "missing-media": "DROP TABLE local_progress",
            "missing-event": "DELETE FROM events WHERE operation='saved'",
            "bad-reference": "UPDATE catalog_references SET target='asset_files/unknown' "
            "WHERE rowid=(SELECT MIN(rowid) FROM catalog_references)",
            "bad-retry": "UPDATE events SET intent='{}' WHERE operation='saved'",
            "bad-parent": "DELETE FROM catalog_parents",
        }
        with sqlite3.connect(database) as db:
            db.execute(statements[damage])
        receipt = read_json(output / "receipt.json")
        receipt["database"] = {"sha256": file_hash(database), "bytes": database.stat().st_size}
        write_json(output / "receipt.json", receipt, replace=True)
    original = file_hash(store.path)
    with pytest.raises(ReplicaError):
        recovery.prepare(root, tmp_path / "destination", output)
    assert file_hash(store.path) == original
    assert not (tmp_path / "destination/replica-bindings").exists()


# Same library ID with different pinned ancestry is still a different authority
def test_reject_foreign_library_backup(replica, tmp_path):
    root, base, _ = replica
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    foreign = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    with pytest.raises(ReplicaError, match="authority"):
        recovery.prepare(foreign.package, tmp_path / "foreign", output)


# Missing or damaged private DB recovery keeps original files and all source media untouched
@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_missing_or_damaged_store_restores_separately(replica, tmp_path, damage):
    root, base, store = replica
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    media = {
        str(item.relative_to(root)): file_hash(item) for item in root.rglob("*") if item.is_file()
    }
    if damage == "missing":
        store.path.unlink()
    else:
        store.path.write_bytes(b"broken synthetic sqlite")
    old = store.path.read_bytes() if store.path.exists() else None
    review = recovery.prepare(root, base, output)
    result = restored(root, base, review)
    assert result.status()["ready"]
    assert (store.path.read_bytes() if store.path.exists() else None) == old
    assert media == {
        str(item.relative_to(root)): file_hash(item) for item in root.rglob("*") if item.is_file()
    }
    assert result.path != store.path


# Prepare can remain blocked with intact last-good metadata until artifacts are delivered completely
def test_package_only_recovery_missing_out_of_order_and_corrupt_artifacts(replica, tmp_path):
    root, base, store = replica
    objects = root / ".cairndex/replica/objects"
    chunk = next(path for path in objects.rglob("*.json") if path.stem != store.descriptor.genesis)
    raw = chunk.read_bytes()
    chunk.unlink()
    review = recovery.prepare(root, tmp_path / "waiting")
    assert review["state"] == "blocked"
    with pytest.raises(ReplicaError, match="blocked"):
        recovery.activate(root, tmp_path / "waiting", review["id"], review["receipt"])
    chunk.write_bytes(raw)
    complete = recovery.prepare(root, tmp_path / "complete")
    assert restored(root, tmp_path / "complete", complete).status()["ready"]
    chunk.write_bytes(b"truncated")
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    intact = recovery.prepare(root, tmp_path / "intact", output)
    assert intact["inventory"]["tables"]["catalog_rows"] > 0
    assert intact["state"] == "blocked" and intact["status"]["waiting"] > 0


# An explicit review is invalidated by later original work and by a live server's lock
def test_activation_excludes_active_work_and_stale_reviews(replica, tmp_path):
    root, base, store = replica
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    review = recovery.prepare(root, base, output)
    guard = BindingLock(base, store.descriptor)
    try:
        with pytest.raises(ReplicaError, match="active"):
            recovery.activate(root, base, review["id"], review["receipt"])
    finally:
        guard.close()
    save(store, intent(store, "New work after review"), "later")
    with pytest.raises(ReplicaError, match="changed after review"):
        recovery.activate(root, base, review["id"], review["receipt"])
    assert (
        store.entity("asset_bundles", "bundle-000000")["fields"]["title"]["value"]
        == '"New work after review"'
    )


# A rewritten review cannot advertise eligibility that the candidate's own bytes do not have
@pytest.mark.parametrize("change", ["state", "inventory", "readiness", "unknown", "missing"])
def test_activation_validates_candidate_independently_of_review(replica, tmp_path, change):
    root, _, store = replica
    objects = root / ".cairndex/replica/objects"
    next(path for path in objects.rglob("*.json") if path.stem != store.descriptor.genesis).unlink()
    base = tmp_path / "destination"
    prepared = recovery.prepare(root, base)
    directory, review = recovery.review_at(base, prepared["id"])
    assert review["state"] == "blocked"
    review["state"] = "prepared"
    if change == "inventory":
        review["inventory"].update(ready=True, waiting=0, invalid=0, blocked=False)
    elif change == "readiness":
        with sqlite3.connect(directory / "prepared.db") as db:
            db.execute("INSERT OR REPLACE INTO config VALUES ('catalog_ready','1')")
        review["database"] = file_hash(directory / "prepared.db")
    elif change == "unknown":
        review["future_override"] = True
    elif change == "missing":
        del review["previous_private_gaps"]
    write_json(directory / "review.json", review, replace=True)
    with pytest.raises(ReplicaError):
        recovery.activate(root, base, prepared["id"], checksum(canonical(review)))
    assert not binding_file(base, store.descriptor).exists()


# Activation recomputes private gaps even when a damaged review claims none remain
def test_activation_rechecks_surviving_private_work(replica, tmp_path):
    root, base, store = replica
    recovery.backup(root, base, tmp_path / "backup")
    store.draft("later-draft", "bundle", 1, {"text": "Retained private text"})
    prepared = recovery.prepare(root, base, tmp_path / "backup")
    directory, review = recovery.review_at(base, prepared["id"])
    assert review["previous_private_gaps"]["drafts"] == 1
    review.update(state="prepared", previous_private_gaps={})
    write_json(directory / "review.json", review, replace=True)
    with pytest.raises(ReplicaError, match="surviving original private work"):
        recovery.activate(root, base, prepared["id"], checksum(canonical(review)))


# New private transport and retry evidence cannot disappear behind an older snapshot
@pytest.mark.parametrize("table", ["inbox", "sources", "recovery_receipts", "recovery_authors"])
def test_prepare_preserves_newer_private_receipts(replica, tmp_path, table):
    root, base, store = replica
    peer = CatalogStore(tmp_path / "previous-author", store.descriptor)
    deliver(store, peer)
    body = intent(peer, "Saved before receipt")
    event = save(peer, body, "saved-operation")
    deliver(peer, store)
    recovery.backup(root, base, tmp_path / "backup")
    if table == "inbox":
        store.ingest(b"incomplete retained transport bytes")
    elif table == "sources":
        with store.connection(readonly=True) as db:
            raw = db.execute("SELECT raw FROM events WHERE id=?", (event,)).fetchone()[0]
        store.ingest(raw, "late-source-receipt")
    else:
        with store.connection() as db:
            if table == "recovery_receipts":
                db.execute(
                    "INSERT INTO recovery_receipts VALUES (?, ?, ?)",
                    ("saved-operation", canonical(body).decode(), event),
                )
            else:
                db.execute("INSERT INTO recovery_authors VALUES ('retained-prior-author')")
    review = recovery.prepare(root, base, tmp_path / "backup")
    assert review["state"] == "blocked" and review["previous_private_gaps"][table] == 1
    with pytest.raises(ReplicaError, match="blocked"):
        recovery.activate(root, base, review["id"], review["receipt"])


# A repeated activation checks the live generation without rewinding legitimate later work
@pytest.mark.parametrize("change", ["missing", "corrupt", "new-work"])
def test_repeated_activation_validates_current_database(replica, tmp_path, change):
    root, base, _ = replica
    recovery.backup(root, base, tmp_path / "backup")
    destination = tmp_path / "restored"
    review = recovery.prepare(root, destination, tmp_path / "backup")
    store = restored(root, destination, review)
    if change == "missing":
        store.path.unlink()
    elif change == "corrupt":
        store.path.write_bytes(b"damaged private database")
    else:
        store.draft("new-draft", "bundle", 1, {"text": "Post-recovery work"})
        result = recovery.activate(root, destination, review["id"], review["receipt"])
        assert result["inventory"]["tables"]["drafts"] == 1
        return
    with pytest.raises(ReplicaError):
        recovery.activate(root, destination, review["id"], review["receipt"])


# Losing a restored generation's binding cannot silently reopen the older original store
def test_missing_binding_requires_separate_recovery(replica, tmp_path):
    root, base, original = replica
    recovery.backup(root, base, tmp_path / "backup")
    review = recovery.prepare(root, base, tmp_path / "backup")
    active = restored(root, base, review)
    binding_file(base, original.descriptor).unlink()
    with pytest.raises(ReplicaError, match="binding is missing"):
        location(base, original.descriptor)
    assert original.path.is_file() and active.path.is_file()
    destination = tmp_path / "separate-server"
    other = recovery.prepare(root, destination, tmp_path / "backup")
    assert restored(root, destination, other).status()["ready"]


# A fault before receipt publication leaves a recoverable partial set, never an activatable backup
@pytest.mark.parametrize(
    "point",
    [
        "backup_after_snapshot",
        "backup_before_receipt",
        "prepare_after_copy",
        "prepare_before_receipt",
        "activate_before_binding",
        "activate_after_binding",
    ],
)
def test_interrupted_steps_preserve_inputs_and_retry(replica, tmp_path, point):
    root, base, store = replica
    before = file_hash(store.path)

    # Synthetic interruption never executes an alternate production recovery path
    def fault(current):
        if current == point:
            raise RuntimeError("synthetic interruption")

    if point.startswith("backup"):
        with pytest.raises(RuntimeError):
            recovery.backup(root, base, tmp_path / "partial", fault=fault)
        assert not (tmp_path / "partial/receipt.json").exists()
    else:
        recovery.backup(root, base, tmp_path / "backup")
        destination = tmp_path / "destination"
        if point.startswith("prepare"):
            with pytest.raises(RuntimeError):
                recovery.prepare(root, destination, tmp_path / "backup", fault=fault)
            assert not list(destination.glob("replica-recoveries/*/review.json"))
        else:
            review = recovery.prepare(root, destination, tmp_path / "backup")
            with pytest.raises(RuntimeError):
                recovery.activate(root, destination, review["id"], review["receipt"], fault=fault)
            assert restored(root, destination, review).status()["ready"]
    assert file_hash(store.path) == before


# Device observations are revalidated while source-bound resume survives only matching bytes
def test_restored_private_resume_and_new_device_media(replica, tmp_path):
    root, base, store = replica
    media = ReplicaMedia(store, root, "synthetic")
    source = root / media.row("asset_files", "file-video")["relative_path"]
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"synthetic generation specimen, not a playback fixture")
    asset = media.file("file-video", inspect=True)
    media.save_progress("file-video", asset.quick_fingerprint, 12, 100)
    with store.connection() as db:
        db.execute("INSERT INTO local_cursors VALUES ('bundle-000000','file-video')")
    output = tmp_path / "backup"
    recovery.backup(root, base, output)
    review = recovery.prepare(root, tmp_path / "restored", output)
    other = restored(root, tmp_path / "restored", review)
    with other.connection() as db:
        assert db.execute("SELECT state FROM local_media").fetchone()[0] == "unknown"
        assert db.execute("SELECT file_id FROM local_cursors").fetchone()[0] == "file-video"
    same = ReplicaMedia(other, root, "restored")
    current = same.file("file-video", inspect=True)
    assert same.progress("file-video", current.quick_fingerprint)["position_s"] == 12
    new_root = tmp_path / "another-device"
    shutil.copytree(root, new_root)
    moved = ReplicaMedia(other, new_root, "restored")
    changed = moved.file("file-video", inspect=True)
    assert moved.progress("file-video", changed.quick_fingerprint) is None
    with other.connection() as db:
        assert db.execute("SELECT position FROM local_progress").fetchone()[0] == 12


# Known pre-media schemas migrate only in a separate candidate and preserve archived bytes
def test_known_older_private_schema_and_protocol_one(replica, tmp_path):
    root, base, store = replica
    with store.connection() as db:
        for table in ("local_media", "local_progress", "local_cursors", "recovery_receipts"):
            db.execute(f"DROP TABLE {table}")
    output = tmp_path / "old-backup"
    recovery.backup(root, base, output)
    review = recovery.prepare(root, tmp_path / "older", output)
    assert restored(root, tmp_path / "older", review).status()["ready"]
    bounded = tmp_path / "bounded-package"
    create_fixture(bounded)
    descriptor = recovery.descriptor_at(bounded)
    bounded_base = tmp_path / "bounded-server"
    first = Store(bounded_base / "replicas" / descriptor.library_uuid, descriptor)
    transport = Transport(bounded, first)
    for _ in range(3):
        transport.tick()
    row = first.bundles()["items"][0]
    changes = {"title": Change(value="Unsent bounded", basis=row["fields"]["title"]["basis"])}
    event = first.save(row["id"], changes, "bounded-save")
    first.draft("bounded-draft", row["id"], 1, changes)
    recovery.backup(bounded, bounded_base, tmp_path / "bounded-backup")
    prepared = recovery.prepare(bounded, tmp_path / "bounded-restore", tmp_path / "bounded-backup")
    result = restored(bounded, tmp_path / "bounded-restore", prepared)
    assert result.save(row["id"], changes, "bounded-save") == event
    assert author(result) != author(first)


# Local commands expose coverage, bounded inspection, cancellation and explicit receipt entry
def test_cli_review_cancel_paths_and_receipt_requirement(replica, tmp_path, capsys):
    root, base, _ = replica
    common = ["--library", str(root), "--data-dir", str(base)]
    assert main(common + ["backup", "--output", str(tmp_path / "cli-backup")]) == 0
    capsys.readouterr()
    assert main(common + ["prepare", "--backup", str(tmp_path / "cli-backup")]) == 0
    prepared = json.loads(capsys.readouterr().out)
    assert main(common + ["review", "--recovery", prepared["id"]]) == 0
    assert "browser-only" in capsys.readouterr().out
    assert main(common + ["activate", "--recovery", prepared["id"], "--receipt", "wrong"]) == 2
    assert "blocked" in capsys.readouterr().err
    assert (
        main(common + ["cancel", "--recovery", prepared["id"], "--receipt", prepared["receipt"]])
        == 0
    )
    assert (
        main(common + ["activate", "--recovery", prepared["id"], "--receipt", prepared["receipt"]])
        == 2
    )
    assert main(common + ["review", "--recovery", "../outside"]) == 2


# Unsupported root artifacts and storage inside the package are never silently omitted
def test_private_paths_and_unknown_artifacts_fail_closed(replica, tmp_path):
    root, base, store = replica
    (store.path.parent / "unknown-private-state").write_text("synthetic")
    with pytest.raises(ReplicaError, match="Unknown private artifact"):
        recovery.backup(root, base, tmp_path / "backup")
    with pytest.raises(ReplicaError, match="outside"):
        recovery.prepare(root, root / "private")
    linked = tmp_path / "linked"
    linked.symlink_to(base)
    with pytest.raises(ReplicaError, match="unlinked"):
        recovery.prepare(root, linked)


# Later original commits satisfy restored pending operations without duplication
def test_pending_job_recognizes_delayed_original_commit(replica, tmp_path):
    root, base, original = replica
    body = intent(original, "Delayed exact intent")
    jobs.enqueue(original, "late-original", "save", body)
    recovery.backup(root, base, tmp_path / "backup")
    destination = tmp_path / "restored"
    review = recovery.prepare(root, destination, tmp_path / "backup")
    restored_store = restored(root, destination, review)
    jobs.run_one(original)
    committed = jobs.job(original, "late-original")["result"]["event"]
    deliver(original, restored_store)
    entry = inspect(destination, review["id"], "jobs", "", 20)["items"][0]
    retry_job(root, destination, "late-original", entry["intent_receipt"])
    jobs.run_one(restored_store)
    assert jobs.job(restored_store, "late-original")["result"]["event"] == committed
    with restored_store.connection() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM events WHERE operation='late-original'").fetchone()[0]
            == 1
        )
    assert author(original) != author(restored_store)
    # The inherited receipt remains verifiable in a subsequent backup/restore generation
    recovery.backup(root, destination, tmp_path / "second-backup")


# Existing unsent edits and drafts cannot disappear merely because the selected backup is older
def test_prepare_reports_and_blocks_surviving_private_gaps(replica, tmp_path):
    root, base, store = replica
    recovery.backup(root, base, tmp_path / "older-backup")
    save(store, intent(store, "Surviving unpublished edit"), "newer")
    store.draft("newer-draft", "bundle", 1, {"text": "Surviving unsent draft"})
    review = recovery.prepare(root, base, tmp_path / "older-backup")
    assert review["state"] == "blocked"
    assert review["previous_private_gaps"]["events"] > 0
    assert review["previous_private_gaps"]["drafts"] == 1
    prior = inspect(base, review["id"], "drafts", "", 20, "previous")
    assert prior["items"][0]["body"] == '{"text":"Surviving unsent draft"}'
    assert inspect(base, review["id"], "catalog", "", 20)["items"]
    with pytest.raises(ReplicaError, match="blocked"):
        recovery.activate(root, base, review["id"], review["receipt"])


# Abrupt exits exercise OS lock release and durable publication rather than Python exception cleanup
@pytest.mark.parametrize(
    "point",
    [
        "backup_before_receipt",
        "prepare_before_receipt",
        "activate_before_binding",
        "activate_after_binding",
    ],
)
def test_subprocess_exit_at_recovery_boundary(replica, tmp_path, point):
    root, base, store = replica
    backup_path = tmp_path / "backup"
    destination = tmp_path / "destination"
    recovery.backup(root, base, backup_path)
    review = recovery.prepare(root, destination, backup_path)
    script = """
import os,sys
from pathlib import Path
from cairndex.replicas import recovery
root,base,dest,backup=map(Path,sys.argv[1:5])
point,identity,receipt=sys.argv[5:]
def fault(current):
    if current == point:
        os._exit(87)
if point.startswith('backup'):
    recovery.backup(root,base,backup.parent/'interrupted-backup',fault=fault)
elif point.startswith('prepare'):
    recovery.prepare(root,dest,backup,fault=fault)
else:
    recovery.activate(root,dest,identity,receipt,fault=fault)
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(root),
            str(base),
            str(destination),
            str(backup_path),
            point,
            review["id"],
            review["receipt"],
        ],
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 87, result.stderr.decode()
    if point.startswith("activate"):
        assert restored(root, destination, review).status()["ready"]
    assert (
        recovery.verify_backup(backup_path, store.descriptor)["inventory"]["tables"]["catalog_rows"]
        > 0
    )


# Replayed conflicted choices still consume exactly the reviewed alternatives after restoration
def test_restored_stale_resolution_is_not_silently_authorized(replica, tmp_path):
    root, base, source = replica
    peer = CatalogStore(tmp_path / "peer", source.descriptor)
    deliver(source, peer)
    save(source, intent(source, "Amber"), "amber")
    save(peer, intent(peer, "Blue"), "blue")
    deliver(peer, source)
    choice = intent(source, "Chosen") | {"resolve": True}
    jobs.enqueue(source, "old-choice", "save", choice)
    recovery.backup(root, base, tmp_path / "backup")
    review = recovery.prepare(root, tmp_path / "restored", tmp_path / "backup")
    target = restored(root, tmp_path / "restored", review)
    save(peer, intent(peer, "New Blue"), "new-blue")
    deliver(peer, target)
    item = inspect(tmp_path / "restored", review["id"], "jobs", "", 20)["items"][0]
    retry_job(root, tmp_path / "restored", "old-choice", item["intent_receipt"])
    jobs.run_one(target)
    job = jobs.job(target, "old-choice")
    assert job["state"] == "failed" and "stale" in job["error"]


# Full structural conflict arrangements retain their valid display and rejected causal branches
@pytest.mark.parametrize("scenario", ["transfer", "delete-edit", "forest", "branch-recovery"])
def test_structural_history_and_review_survive_private_recovery(replica, tmp_path, scenario):
    from cairndex.replicas.catalog.recovery import recover_preview
    from tests.test_replica_catalog import edit, preview, submit, value

    root, base, source = replica
    peer = CatalogStore(tmp_path / "peer", source.descriptor)
    deliver(source, peer)
    if scenario == "transfer":
        submit(
            source,
            preview(
                source,
                {
                    "action": "transfer",
                    "source": "bundle-000000",
                    "target": "bundle-000001",
                    "members": ["bundle_directory_members/directory-one"],
                },
            ),
            "transfer",
        )
        members = value(peer, "asset_bundles", "bundle-000000", "$members")
        members[0]["sequence"] = 99
        submit(
            peer,
            preview(
                peer,
                {
                    "action": "arrange",
                    "unit": "asset_bundles/bundle-000000/$members",
                    "value": members,
                },
            ),
            "order",
        )
    elif scenario == "delete-edit":
        submit(
            source,
            preview(source, {"action": "delete", "family": "moments", "entity": "moment-one"}),
            "delete",
        )
        peer.save(
            edit(peer, "moments", "moment-one", "comment", "Retained edit"),
            "edit",
            parents=peer.frontier(),
        )
    elif scenario == "forest":
        for index, store in enumerate((source, peer)):
            forest = value(store, "tags", "_", "$forest")
            forest[0]["sort_order"] = index + 3
            submit(
                store,
                preview(store, {"action": "arrange", "unit": "tags/_/$forest", "value": forest}),
                f"forest-{index}",
            )
    else:
        submit(
            source,
            preview(source, {"action": "delete", "family": "asset_files", "entity": "file-video"}),
            "delete",
        )
        submit(
            source,
            recover_preview(source, source.descriptor.genesis, "asset_files", "file-video"),
            "recover",
        )
    deliver(peer, source)
    with source.connection() as db:
        expected = {
            table: table_hash(db, table)
            for table in ("events", "catalog_units", "catalog_rows", "catalog_holds")
        }
    recovery.backup(root, base, tmp_path / "backup")
    review = recovery.prepare(root, tmp_path / "destination", tmp_path / "backup")
    target = restored(root, tmp_path / "destination", review)
    with target.connection() as db:
        assert expected == {table: table_hash(db, table) for table in expected}


# Actual historical cohort columns are accepted explicitly, without weakening unknown-table fences
def test_historical_cohort_schema_with_retained_structural_operation(replica, tmp_path):
    from tests.test_replica_catalog import preview, submit

    root, base, source = replica
    submit(
        source,
        preview(
            source,
            {
                "action": "transfer",
                "source": "bundle-000000",
                "target": "bundle-000001",
                "members": ["bundle_directory_members/directory-one"],
            },
        ),
        "transfer",
    )
    with source.connection() as db:
        rows = list(db.execute("SELECT event,unit FROM catalog_cohorts"))
        assert rows
        db.execute("DROP TABLE catalog_cohorts")
        db.execute(
            "CREATE TABLE catalog_cohorts (event TEXT NOT NULL,unit TEXT NOT NULL, "
            "PRIMARY KEY(unit,event))"
        )
        db.execute("CREATE INDEX catalog_cohort_event ON catalog_cohorts(event,unit)")
        db.executemany("INSERT INTO catalog_cohorts VALUES (?, ?)", rows)
    recovery.backup(root, base, tmp_path / "old-backup")
    review = recovery.prepare(root, tmp_path / "older", tmp_path / "old-backup")
    assert restored(root, tmp_path / "older", review).status()["ready"]
