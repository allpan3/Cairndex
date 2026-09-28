"""Source-operation tests admit real portable packages and disposable bytes."""

import json
import shutil
import subprocess
import sys

import pytest

from cairndex.devtools.replica_creation_fixture import prepare_disposable
from cairndex.replicas.catalog.creation import complete
from cairndex.replicas.source_execute import run_one
from cairndex.replicas.source_journal import SourceRequest, accept, enqueue, job
from tests.test_replica_creation import open_store


def fixture(tmp_path):
    package = prepare_disposable(parent=tmp_path)
    complete(package)
    store = open_store(package.root, tmp_path / "private-source-test")
    return package.root, store


def perform(
    store, root, operation, action, source="", destination="", collision="fail", prior=None
):
    enqueue(
        store,
        SourceRequest(
            operation=operation,
            action=action,
            source=source,
            destination=destination,
            collision=collision,
            prior=prior,
        ),
    )
    run_one(store, root, lambda: None)
    prepared = job(store, operation)
    assert prepared.state == "prepared", prepared.error
    accept(store, operation, prepared.receipt)
    run_one(store, root, lambda: None)
    result = job(store, operation)
    assert result.state == "succeeded", result.error
    return result


def test_internal_copy_rename_and_trash_keep_portable_identity(tmp_path):
    root, store = fixture(tmp_path)
    (root / "original.txt").write_bytes(b"synthetic original")
    copied = perform(store, root, "copy-one", "copy", "original.txt", "copy.txt")
    identity = copied.review["output_id"]
    assert (root / "original.txt").read_bytes() == (root / "copy.txt").read_bytes()
    entity = store.entity("asset_files", identity)
    assert json.loads(entity["fields"]["relative_path"]["value"]) == "copy.txt"
    moved = perform(store, root, "move-one", "move", "copy.txt", "moved.txt")
    assert moved.review["output_id"] == identity
    assert not (root / "copy.txt").exists()
    assert (root / "moved.txt").read_bytes() == b"synthetic original"
    perform(store, root, "trash-one", "trash", "moved.txt")
    assert not (root / "moved.txt").exists()
    assert (
        root / ".cairndex/source-operations/trash-one/source"
    ).read_bytes() == b"synthetic original"
    assert store.entity("asset_files", identity)["fields"]["$alive"]["value"] == "false"
    perform(store, root, "undo-trash", "undo", prior="trash-one")
    assert (root / "moved.txt").read_bytes() == b"synthetic original"
    assert store.entity("asset_files", identity)["fields"]["$alive"]["value"] == "true"
    perform(store, root, "undo-move", "undo", prior="move-one")
    assert (root / "copy.txt").read_bytes() == b"synthetic original"
    assert not (root / "moved.txt").exists()


def test_replace_keeps_destination_identity_and_undo_keeps_later_notes(tmp_path):
    from tests.test_replica_catalog import edit, save

    root, store = fixture(tmp_path)
    (root / "amber.txt").write_bytes(b"amber version")
    (root / "blue.txt").write_bytes(b"blue version")
    original = perform(store, root, "initial-copy", "copy", "amber.txt", "target.txt")
    identity = original.review["output_id"]
    changed = perform(store, root, "replace-copy", "copy", "blue.txt", "target.txt", "replace")
    assert changed.review["output_id"] == identity
    save(store, edit(store, "asset_files", identity, "note", "Later synthetic note"), "later-note")
    perform(store, root, "undo-replace", "undo", prior="replace-copy")
    assert (root / "target.txt").read_bytes() == b"amber version"
    assert (
        store.entity("asset_files", identity)["fields"]["note"]["value"] == '"Later synthetic note"'
    )


def test_move_replace_restores_both_identities(tmp_path):
    root, store = fixture(tmp_path)
    (root / "amber.txt").write_bytes(b"amber version")
    (root / "blue.txt").write_bytes(b"blue version")
    source = perform(store, root, "source-copy", "copy", "amber.txt", "source.txt")
    target = perform(store, root, "target-copy", "copy", "blue.txt", "target.txt")
    changed = perform(store, root, "replace-move", "move", "source.txt", "target.txt", "replace")
    assert changed.review["output_id"] == source.review["output_id"]
    assert (
        store.entity("asset_files", target.review["output_id"])["fields"]["$alive"]["value"]
        == "false"
    )
    perform(store, root, "undo-move-replace", "undo", prior="replace-move")
    assert (root / "source.txt").read_bytes() == b"amber version"
    assert (root / "target.txt").read_bytes() == b"blue version"
    assert (
        store.entity("asset_files", target.review["output_id"])["fields"]["$alive"]["value"]
        == "true"
    )


def test_received_receipt_waits_for_metadata_and_never_moves_peer_bytes(tmp_path):
    from cairndex.replicas.source_transport import SourceTransport, ingest
    from tests.test_replica_catalog import exchange

    root, store = fixture(tmp_path)
    (root / "original.txt").write_bytes(b"synthetic original")
    perform(store, root, "copy-one", "copy", "original.txt", "copy.txt")
    peer_root = tmp_path / "peer"
    shutil.copytree(root, peer_root)
    peer = open_store(peer_root, tmp_path / "peer-private")
    exchange(store, peer)
    perform(store, root, "move-one", "move", "copy.txt", "moved.txt")
    with store.connection(readonly=True) as db:
        raw = db.execute("SELECT raw FROM source_receipts WHERE id='move-one'").fetchone()[0]
    ingest(peer, raw)
    incoming = SourceTransport(peer_root, peer)
    incoming.tick()
    with peer.connection(readonly=True) as db:
        assert (
            db.execute("SELECT state FROM source_receipts WHERE id='move-one'").fetchone()[0]
            == "pending"
        )
    exchange(store, peer)
    incoming.tick()
    incoming.close()
    ingest(peer, raw)
    assert (peer_root / "copy.txt").read_bytes() == b"synthetic original"
    assert not (peer_root / "moved.txt").exists()
    with peer.connection(readonly=True) as db:
        assert (
            db.execute("SELECT state FROM source_receipts WHERE id='move-one'").fetchone()[0]
            == "accepted"
        )


def test_offline_replacement_and_file_edit_retain_a_conflict(tmp_path):
    from tests.test_replica_catalog import edit, exchange, save

    root, store = fixture(tmp_path)
    (root / "amber.txt").write_bytes(b"amber version")
    (root / "blue.txt").write_bytes(b"blue version")
    original = perform(store, root, "initial-copy", "copy", "amber.txt", "target.txt")
    identity = original.review["output_id"]
    peer_root = tmp_path / "peer"
    shutil.copytree(root, peer_root)
    peer = open_store(peer_root, tmp_path / "peer-private")
    exchange(store, peer)
    save(peer, edit(peer, "asset_files", identity, "note", "Offline note"), "offline-note")
    perform(store, root, "replace-copy", "copy", "blue.txt", "target.txt", "replace")
    exchange(store, peer)
    assert store.entity("asset_files", identity)["has_conflicts"]
    assert peer.entity("asset_files", identity)["has_conflicts"]
    assert (peer_root / "target.txt").read_bytes() == b"amber version"


@pytest.mark.parametrize(
    "point",
    [
        "source_before_capture",
        "source_after_captured_destination",
        "source_after_captured_source",
        "source_after_publication",
        "source_before_catalog_commit",
        "source_after_catalog_commit",
    ],
)
@pytest.mark.parametrize("directory", [False, True])
def test_process_exit_recovers_exact_move_replace(tmp_path, point, directory):
    from cairndex.replicas.source_journal import retry

    root, store = fixture(tmp_path)

    def source_file(path):
        return path / "entry.txt" if directory else path

    if directory:
        (root / "amber.txt").mkdir()
        (root / "blue.txt").mkdir()
    source_file(root / "amber.txt").write_bytes(b"amber version")
    source_file(root / "blue.txt").write_bytes(b"blue version")
    perform(store, root, "source-copy", "copy", "amber.txt", "source.txt")
    perform(store, root, "target-copy", "copy", "blue.txt", "target.txt")
    enqueue(
        store,
        SourceRequest(
            operation="replace",
            action="move",
            source="source.txt",
            destination="target.txt",
            collision="replace",
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "replace", job(store, "replace").receipt)
    script = """
import os, sys
from pathlib import Path
from cairndex.registry.library_package import read_manifest
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.source_execute import run_one
def fault(point):
    if point == sys.argv[3]:
        os._exit(73)
root = Path(sys.argv[1])
store = CatalogStore(Path(sys.argv[2]), read_manifest(root).replica, fault=fault)
run_one(store, root, lambda: None)
"""
    exited = subprocess.run(
        [sys.executable, "-c", script, str(root), str(store.path.parent), point],
        capture_output=True,
        timeout=30,
    )
    assert exited.returncode == 73, exited.stderr.decode()
    restored = open_store(root, store.path.parent)
    retry(restored, "replace")
    run_one(restored, root, lambda: None)
    assert job(restored, "replace").state == "succeeded", job(restored, "replace").error
    assert source_file(root / "target.txt").read_bytes() == b"amber version"
    assert (
        source_file(root / ".cairndex/source-operations/replace/destination").read_bytes()
        == b"blue version"
    )
    perform(restored, root, "undo-replace", "undo", prior="replace")
    assert source_file(root / "source.txt").read_bytes() == b"amber version"
    assert source_file(root / "target.txt").read_bytes() == b"blue version"


def test_shared_operation_namespace_refuses_an_independent_author(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"synthetic")
    request = SourceRequest(
        operation="same-id", action="copy", source="source.txt", destination="copy.txt"
    )
    enqueue(store, request)
    run_one(store, root, lambda: None)
    assert job(store, request.operation).state == "prepared"
    peer = open_store(root, tmp_path / "independent-private")
    enqueue(peer, request)
    run_one(peer, root, lambda: None)
    assert job(peer, request.operation).state == "interrupted"
    assert "different intent or author" in job(peer, request.operation).error
    assert not (root / "copy.txt").exists()


def test_undo_rechecks_completed_inverse_before_first_capture(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"synthetic")
    perform(store, root, "unlinked-move", "move", "source.txt", "moved.txt")
    for operation in ("undo-first", "undo-second"):
        enqueue(store, SourceRequest(operation=operation, action="undo", prior="unlinked-move"))
        run_one(store, root, lambda: None)
        assert job(store, operation).state == "prepared"
    for operation in ("undo-first", "undo-second"):
        accept(store, operation, job(store, operation).receipt)
        run_one(store, root, lambda: None)
    assert job(store, "undo-first").state == "succeeded"
    assert job(store, "undo-second").state == "interrupted"
    assert "completed Undo" in job(store, "undo-second").error
    assert (root / "source.txt").read_bytes() == b"synthetic"


@pytest.mark.parametrize("action,budget", [("copy", 9), ("move", 14), ("rename", 14), ("trash", 9)])
def test_retained_storage_budget_precedes_snapshot_and_capture(tmp_path, action, budget):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"12345")
    enqueue(
        store,
        SourceRequest(
            operation="small-budget",
            action=action,
            source="source.txt",
            destination="moved.txt",
            byte_limit=budget,
        ),
    )
    run_one(store, root, lambda: None)
    assert job(store, "small-budget").state == "interrupted"
    assert (root / "source.txt").read_bytes() == b"12345"
    assert not (root / ".cairndex/source-operations/small-budget/source").exists()


def test_trash_undo_restores_complete_references_and_preserves_later_bundle_note(tmp_path):
    from cairndex.devtools.discovery_fixture import create_discovery
    from tests.test_replica_catalog import edit, save

    root = create_discovery(parent=tmp_path)
    store = open_store(root, tmp_path / "complete-private")
    with store.connection(readonly=True) as db:
        before = dict(db.execute("SELECT unit,value FROM catalog_units"))
    perform(store, root, "trash-complete", "trash", "Synthetic/雪.mp4")
    assert store.entity("moments", "moment-one")["fields"]["$alive"]["value"] == "false"
    assert store.entity("subtitle_tracks", "track-one")["fields"]["$alive"]["value"] == "false"
    save(
        store,
        edit(store, "asset_bundles", "bundle-000000", "notes", '["Later bundle note"]'),
        "later-bundle-note",
    )
    perform(store, root, "undo-complete", "undo", prior="trash-complete")
    with store.connection(readonly=True) as db:
        after = dict(db.execute("SELECT unit,value FROM catalog_units"))
    before["asset_bundles/bundle-000000/notes"] = json.dumps('["Later bundle note"]')
    assert after == before
    assert (root / "Synthetic/雪.mp4").exists()


def test_source_events_have_an_explicit_reader_boundary(tmp_path):
    from typing import Literal

    from pydantic import ValidationError

    from cairndex.replicas.catalog.protocol import Root, decode

    class PreviousRoot(Root):
        kind: Literal["catalog_seed", "catalog_edit"]

    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"synthetic")
    result = perform(store, root, "new-source-root", "copy", "source.txt", "copy.txt")
    with store.connection(readonly=True) as db:
        raw = db.execute("SELECT raw FROM events WHERE id=?", (result.result["event"],)).fetchone()[
            0
        ]
    _, body = decode(raw, store.descriptor)
    assert body.kind == "catalog_source_edit"
    with pytest.raises(ValidationError):
        PreviousRoot.model_validate(body.model_dump())


def test_directory_copy_move_trash_and_undo_keep_nested_files(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Folder/Nested/Empty").mkdir(parents=True)
    (root / "Folder/one.txt").write_bytes(b"one")
    (root / "Folder/Nested/two.txt").write_bytes(b"two")
    copied = perform(store, root, "copy-folder", "copy", "Folder", "Copy")
    assert copied.review["source_evidence"]["algorithm"] == "tree-sha256-v1"
    assert (root / "Copy/Nested/Empty").is_dir()
    with store.connection(readonly=True) as db:
        identities = dict(
            db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'")
        )
    perform(store, root, "move-folder", "move", "Copy", "Moved")
    with store.connection(readonly=True) as db:
        moved = dict(db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'"))
    assert moved == {
        path.replace("Copy/", "Moved/", 1): identity for path, identity in identities.items()
    }
    perform(store, root, "trash-folder", "trash", "Moved")
    assert not (root / "Moved").exists()
    perform(store, root, "undo-folder-trash", "undo", prior="trash-folder")
    perform(store, root, "undo-folder-move", "undo", prior="move-folder")
    assert (root / "Copy/one.txt").read_bytes() == b"one"
    assert (root / "Copy/Nested/two.txt").read_bytes() == b"two"
    assert (root / "Copy/Nested/Empty").is_dir()


def test_directory_replace_restores_displaced_tree(tmp_path):
    root, store = fixture(tmp_path)
    for folder, content in (("Amber", b"amber"), ("Blue", b"blue")):
        (root / folder).mkdir()
        (root / folder / "same.txt").write_bytes(content)
        perform(store, root, folder + "-copy", "copy", folder, folder + "Copy")
    (root / "BlueCopy/extra.txt").write_bytes(b"extra")
    with store.connection(readonly=True) as db:
        original = dict(
            db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'")
        )
    perform(store, root, "replace-folder", "copy", "AmberCopy", "BlueCopy", "replace")
    with store.connection(readonly=True) as db:
        after = dict(db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'"))
    assert after == original
    assert not (root / "BlueCopy/extra.txt").exists()
    perform(store, root, "undo-folder-replace", "undo", prior="replace-folder")
    assert (root / "BlueCopy/same.txt").read_bytes() == b"blue"
    assert (root / "BlueCopy/extra.txt").read_bytes() == b"extra"


@pytest.mark.parametrize("entry", ["hidden", "symlink", "oversized"])
def test_directory_unsupported_entries_stop_before_capture(tmp_path, entry):
    root, store = fixture(tmp_path)
    folder = root / "Folder"
    folder.mkdir()
    if entry == "hidden":
        (folder / ".hidden").write_bytes(b"retain")
    elif entry == "symlink":
        (folder / "link").symlink_to(root / "other")
    else:
        for index in range(129):
            (folder / f"file-{index}").write_bytes(b"retain")
    enqueue(store, SourceRequest(operation="refuse-folder", action="trash", source="Folder"))
    run_one(store, root, lambda: None)
    assert job(store, "refuse-folder").state == "interrupted"
    assert folder.is_dir()
    assert not (root / ".cairndex/source-operations/refuse-folder/captured-source").exists()


def test_restore_copy_of_a_directory_and_its_undo(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Folder/Empty").mkdir(parents=True)
    (root / "Folder/file.txt").write_bytes(b"synthetic folder version")
    perform(store, root, "trash-original-folder", "trash", "Folder")
    restored = perform(
        store,
        root,
        "restore-folder-copy",
        "restore",
        destination="Recovered",
        prior="trash-original-folder",
    )
    assert (
        restored.review["versions_after"]["Recovered"]["evidence"]["algorithm"] == "tree-sha256-v1"
    )
    assert (root / "Recovered/file.txt").read_bytes() == b"synthetic folder version"
    assert (root / "Recovered/Empty").is_dir()
    perform(store, root, "undo-recovered-copy", "undo", prior="restore-folder-copy")
    assert not (root / "Recovered").exists()
    assert (
        root / ".cairndex/source-operations/trash-original-folder/source/file.txt"
    ).read_bytes() == b"synthetic folder version"


def test_directory_move_preserves_local_resume_and_validates_private_snapshot(tmp_path):
    from cairndex.replicas.recovery_validation import snapshot, validate_snapshot
    from cairndex.replicas.source_files import observation

    root, store = fixture(tmp_path)
    (root / "Folder").mkdir()
    (root / "Folder/file.txt").write_bytes(b"synthetic")
    perform(store, root, "copy-resume-folder", "copy", "Folder", "Copy")
    with store.connection() as db:
        identity = db.execute(
            "SELECT entity FROM catalog_paths WHERE path='Copy/file.txt'"
        ).fetchone()[0]
        generation = observation(root, "Copy/file.txt")["generation"]
        db.execute("INSERT INTO local_progress VALUES (?,?,4.0,20.0,0)", (identity, generation))
    perform(store, root, "move-resume-folder", "move", "Copy", "Moved")
    with store.connection(readonly=True) as db:
        saved = db.execute(
            "SELECT generation,position FROM local_progress WHERE file_id=?", (identity,)
        ).fetchone()
        assert tuple(saved) == (observation(root, "Moved/file.txt")["generation"], 4.0)
    backup = tmp_path / "source-snapshot.db"
    snapshot(store.path, backup)
    validate_snapshot(backup, store.descriptor)


def test_interrupted_application_offers_separate_recovery_without_overwrite(tmp_path):
    root, store = fixture(tmp_path)
    (root / "original.txt").write_bytes(b"original bytes")
    (root / "target.txt").write_bytes(b"displaced bytes")
    enqueue(
        store,
        SourceRequest(
            operation="interrupted-move",
            action="move",
            source="original.txt",
            destination="target.txt",
            collision="replace",
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "interrupted-move", job(store, "interrupted-move").receipt)

    def fault(point):
        if point == "source_before_capture":
            (root / "target.txt").write_bytes(b"new external bytes")

    store.fault = fault
    run_one(store, root, lambda: None)
    assert job(store, "interrupted-move").state == "interrupted"
    assert job(store, "interrupted-move").result["retained_versions"]["target.txt"]["evidence"][
        "size"
    ] == len(b"displaced bytes")
    store.fault = lambda _: None
    enqueue(
        store,
        SourceRequest(
            operation="recover-displaced",
            action="restore",
            prior="interrupted-move",
            version="destination",
            destination="recovered.txt",
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "recover-displaced", job(store, "recover-displaced").receipt)
    run_one(store, root, lambda: None)
    assert job(store, "recover-displaced").state == "succeeded"
    assert (root / "target.txt").read_bytes() == b"new external bytes"
    assert (root / "recovered.txt").read_bytes() == b"displaced bytes"


def test_byte_boundary_permission_revocation_keeps_original_and_exact_retry(tmp_path):
    from cairndex.replicas.protocol import ReplicaError
    from cairndex.replicas.source_journal import retry

    root, store = fixture(tmp_path)
    content = b"synthetic large content" * 100000
    (root / "source.bin").write_bytes(content)
    enqueue(
        store,
        SourceRequest(
            operation="revoked-copy", action="copy", source="source.bin", destination="copy.bin"
        ),
    )
    calls = 0

    def authorize():
        nonlocal calls
        calls += 1
        if calls >= 3:
            raise ReplicaError("Synthetic permission revoked")

    run_one(store, root, authorize)
    assert job(store, "revoked-copy").state == "interrupted"
    assert (root / "source.bin").read_bytes() == content
    assert not (root / "copy.bin").exists()
    retry(store, "revoked-copy")
    run_one(store, root, lambda: None)
    assert job(store, "revoked-copy").state == "prepared"
    accept(store, "revoked-copy", job(store, "revoked-copy").receipt)
    run_one(store, root, lambda: None)
    assert job(store, "revoked-copy").state == "succeeded"
    assert (root / "copy.bin").read_bytes() == content


def test_peer_large_bytes_wait_then_receive_verified_baseline(tmp_path):
    from cairndex.replicas.source_transport import SourceTransport, ingest
    from tests.test_replica_catalog import exchange

    root, store = fixture(tmp_path)
    peer_root = tmp_path / "peer-source"
    shutil.copytree(root, peer_root)
    peer = open_store(peer_root, tmp_path / "peer-source-private")
    content = b"synthetic large content" * 100000
    (root / "original.bin").write_bytes(content)
    result = perform(store, root, "large-copy", "copy", "original.bin", "copied.bin")
    exchange(store, peer)
    with store.connection(readonly=True) as db:
        raw = db.execute("SELECT raw FROM source_receipts WHERE id='large-copy'").fetchone()[0]
    ingest(peer, raw)
    transport = SourceTransport(peer_root, peer)
    try:
        (peer_root / "copied.bin").write_bytes(content[:100])
        for _ in range(4):
            transport.tick()
        with peer.connection(readonly=True) as db:
            assert (
                db.execute(
                    "SELECT 1 FROM discovery_baselines WHERE file_id=?",
                    (result.review["output_id"],),
                ).fetchone()
                is None
            )
        (peer_root / "copied.bin").write_bytes(content)
        for _ in range(8):
            transport.tick()
        with peer.connection(readonly=True) as db:
            body = db.execute(
                "SELECT body FROM discovery_baselines WHERE file_id=?",
                (result.review["output_id"],),
            ).fetchone()[0]
            assert json.loads(body)["evidence"] == result.review["source_evidence"]
    finally:
        transport.close()


@pytest.mark.parametrize("action", ["move", "trash"])
def test_new_arrival_after_capture_stops_catalog_commit(tmp_path, action):
    root, store = fixture(tmp_path)
    (root / "original.txt").write_bytes(b"original")
    copied = perform(store, root, "initial", "copy", "original.txt", "source.txt")
    identity = copied.review["output_id"]
    request = SourceRequest(
        operation="arrival-test",
        action=action,
        source="source.txt",
        destination="moved.txt" if action == "move" else "",
    )
    enqueue(store, request)
    run_one(store, root, lambda: None)
    accept(store, request.operation, job(store, request.operation).receipt)

    def fault(point):
        if point == "source_after_captured_source":
            (root / "source.txt").write_bytes(b"new arrival")

    store.fault = fault
    run_one(store, root, lambda: None)
    assert job(store, request.operation).state == "interrupted"
    assert "New source bytes" in job(store, request.operation).error
    assert (root / "source.txt").read_bytes() == b"new arrival"
    assert (root / ".cairndex/source-operations/arrival-test/source").read_bytes() == b"original"
    fields = store.entity("asset_files", identity)["fields"]
    assert fields["relative_path"]["value"] == '"source.txt"'
    assert fields["$alive"]["value"] == "true"
    with store.connection(readonly=True) as db:
        assert not db.execute("SELECT 1 FROM source_receipts WHERE id='arrival-test'").fetchone()


@pytest.mark.parametrize("action", ["move", "copy"])
def test_directory_undo_uses_file_evidence_when_previous_content_is_absent(tmp_path, action):
    from cairndex.replicas.catalog.commands import Preview
    from cairndex.replicas.catalog.protocol import UnitChange
    from cairndex.replicas.source_plan import new_copy

    root, store = fixture(tmp_path)
    for folder, content in (("Source", b"new bytes"), ("Target", b"old bytes")):
        (root / folder).mkdir()
        (root / folder / "entry.txt").write_bytes(content)
    path = "Source/entry.txt" if action == "move" else "Target/entry.txt"
    with store.connection() as db:
        builder = Preview(store, db)
        identity = new_copy(builder, SourceRequest(operation="seed", action="copy"), path)
        receipt = builder.receipt()
        store.save_in(
            db,
            [UnitChange.model_validate(item) for item in receipt["changes"]],
            "seed",
            parents=receipt["parents"],
            resolve=receipt["resolve"],
            recover=receipt["recover"],
        )
    perform(store, root, "change-tree", action, "Source", "Target", "replace")
    perform(store, root, "undo-tree", "undo", prior="change-tree")
    fields = store.entity("asset_files", identity)["fields"]
    evidence = json.loads(fields["$content"]["value"])
    import hashlib

    expected = b"new bytes" if action == "move" else b"old bytes"
    assert evidence == {
        "algorithm": "sha256",
        "digest": hashlib.sha256(expected).hexdigest(),
        "size": len(expected),
    }
    assert json.loads(fields["relative_path"]["value"]) == path
    assert (root / path).read_bytes() == expected


@pytest.mark.parametrize("error_number", [28, 30])
def test_storage_failure_retains_originals_and_exact_retry(tmp_path, monkeypatch, error_number):
    import cairndex.replicas.source_execute as execute
    from cairndex.replicas.source_journal import retry

    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"original")
    request = SourceRequest(
        operation="storage-failure", action="move", source="source.txt", destination="target.txt"
    )
    enqueue(store, request)
    run_one(store, root, lambda: None)
    accept(store, request.operation, job(store, request.operation).receipt)
    original = execute.stage_output

    def fail(*args, **kwargs):
        raise OSError(error_number, "synthetic storage refusal")

    monkeypatch.setattr(execute, "stage_output", fail)
    run_one(store, root, lambda: None)
    assert job(store, request.operation).state == "interrupted"
    assert (root / "source.txt").read_bytes() == b"original"
    assert (root / ".cairndex/source-operations/storage-failure/source").read_bytes() == b"original"
    monkeypatch.setattr(execute, "stage_output", original)
    retry(store, request.operation)
    run_one(store, root, lambda: None)
    assert job(store, request.operation).state == "succeeded"
    assert (root / "target.txt").read_bytes() == b"original"


@pytest.mark.parametrize("scenario", ["different_moves", "trash_edit", "same_destination"])
def test_independent_source_changes_keep_concurrent_alternatives(tmp_path, scenario):
    from tests.test_replica_catalog import edit, exchange, save

    root, store = fixture(tmp_path)
    (root / "original.txt").write_bytes(b"original")
    copied = perform(store, root, "initial", "copy", "original.txt", "source.txt")
    identity = copied.review["output_id"]
    peer_root = tmp_path / "peer-library"
    shutil.copytree(root, peer_root)
    peer = open_store(peer_root, tmp_path / "peer-private")
    exchange(store, peer)
    if scenario == "different_moves":
        perform(store, root, "first-move", "move", "source.txt", "first.txt")
        perform(peer, peer_root, "second-move", "move", "source.txt", "second.txt")
    elif scenario == "trash_edit":
        perform(store, root, "first-trash", "trash", "source.txt")
        save(peer, edit(peer, "asset_files", identity, "note", "Retained peer note"), "peer-note")
    else:
        first = perform(store, root, "first-copy", "copy", "source.txt", "shared.txt")
        second = perform(peer, peer_root, "second-copy", "copy", "source.txt", "shared.txt")
        assert first.review["output_id"] != second.review["output_id"]
    exchange(store, peer)
    if scenario == "same_destination":
        from cairndex.replicas.protocol import ReplicaError
        from cairndex.replicas.source_plan import path_identity

        for target in (store, peer):
            with (
                target.connection(readonly=True) as db,
                pytest.raises(ReplicaError, match="unresolved catalog alternatives"),
            ):
                path_identity(db, "shared.txt")
            assert target.entity("asset_files", first.review["output_id"])["has_conflicts"]
            assert target.entity("asset_files", second.review["output_id"])["has_conflicts"]
        assert (root / "shared.txt").read_bytes() == b"original"
        assert (peer_root / "shared.txt").read_bytes() == b"original"
    else:
        assert store.entity("asset_files", identity)["has_conflicts"]
        assert peer.entity("asset_files", identity)["has_conflicts"]
        if scenario == "different_moves":
            assert (root / "first.txt").read_bytes() == b"original"
            assert (peer_root / "second.txt").read_bytes() == b"original"
        else:
            assert not (root / "source.txt").exists()
            assert (peer_root / "source.txt").read_bytes() == b"original"
