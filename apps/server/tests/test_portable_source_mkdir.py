"""New Folder uses exact source intent, vacant publication and conditional Undo."""

import json

import pytest

from cairndex.replicas.source_execute import run_one
from cairndex.replicas.source_journal import SourceRequest, accept, enqueue, job, retry
from tests.test_portable_source_operations import fixture, perform


def prepared(store, root, destination="Nested", **kwargs):
    request = SourceRequest(
        operation="new-folder", action="mkdir", destination=destination, **kwargs
    )
    enqueue(store, request)
    run_one(store, root, lambda: None)
    return job(store, request.operation)


def test_mkdir_is_reviewed_idempotent_and_undoable(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Parent").mkdir()
    planned = prepared(store, root, "Parent/Nested")
    assert planned.state == "prepared", planned.error
    assert not (root / "Parent/Nested").exists()
    accept(store, planned.id, planned.receipt)
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "succeeded"
    assert (root / "Parent/Nested").is_dir()
    assert enqueue(store, planned.request).state == "succeeded"
    with store.connection(readonly=True) as db:
        receipt = json.loads(db.execute("SELECT raw FROM source_receipts").fetchone()[0])
        assert receipt["action"] == "mkdir" and receipt["event"] is None
        assert db.execute("SELECT COUNT(*) FROM catalog_paths").fetchone()[0] == 0
    perform(store, root, "undo-folder", "undo", prior=planned.id)
    assert not (root / "Parent/Nested").exists()


@pytest.mark.parametrize(
    "path", ["../escape", "/outside", ".cairndex/new", "a/../b", "a/.hidden", "a\\b", "a/", ""]
)
def test_mkdir_rejects_unsafe_destinations(tmp_path, path):
    root, store = fixture(tmp_path)
    planned = prepared(store, root, path)
    assert planned.state == "interrupted"
    assert not (root / "escape").exists()


@pytest.mark.parametrize("kind", ["file", "folder", "symlink"])
def test_mkdir_never_replaces_an_occupied_name(tmp_path, kind):
    root, store = fixture(tmp_path)
    path = root / "Nested"
    if kind == "file":
        path.write_bytes(b"synthetic retained file")
    elif kind == "folder":
        path.mkdir()
        (path / "keep.txt").write_bytes(b"synthetic retained child")
    else:
        path.symlink_to(tmp_path, target_is_directory=True)
    planned = prepared(store, root)
    assert planned.state == "interrupted"
    assert path.exists()
    assert path.is_symlink() if kind == "symlink" else not path.is_symlink()


def test_mkdir_refuses_symlink_parent_and_replaced_parent(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Linked").symlink_to(tmp_path, target_is_directory=True)
    assert prepared(store, root, "Linked/Nested").state == "interrupted"
    assert not (tmp_path / "Nested").exists()
    (root / "Parent").mkdir()
    request = SourceRequest(operation="parent-folder", action="mkdir", destination="Parent/Nested")
    enqueue(store, request)
    run_one(store, root, lambda: None)
    planned = job(store, request.operation)
    assert planned.state == "prepared"
    (root / "Parent").rename(root / "Original")
    (root / "Parent").mkdir()
    accept(store, planned.id, planned.receipt)
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "interrupted"
    assert not (root / "Parent/Nested").exists()
    assert not (root / "Original/Nested").exists()


def test_mkdir_preserves_new_arrival_after_review(tmp_path):
    root, store = fixture(tmp_path)
    planned = prepared(store, root)
    (root / "Nested").write_bytes(b"synthetic new arrival")
    accept(store, planned.id, planned.receipt)
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "interrupted"
    assert (root / "Nested").read_bytes() == b"synthetic new arrival"


def test_mkdir_undo_refuses_later_children(tmp_path):
    root, store = fixture(tmp_path)
    perform(store, root, "folder", "mkdir", destination="Nested")
    (root / "Nested/keep.txt").write_bytes(b"synthetic later work")
    enqueue(store, SourceRequest(operation="undo-folder", action="undo", prior="folder"))
    run_one(store, root, lambda: None)
    assert job(store, "undo-folder").state == "interrupted"
    assert (root / "Nested/keep.txt").read_bytes() == b"synthetic later work"


def test_mkdir_retry_after_publication_keeps_exact_output(tmp_path):
    root, store = fixture(tmp_path)
    planned = prepared(store, root)
    accept(store, planned.id, planned.receipt)

    def stop(point):
        if point == "source_after_publication":
            raise OSError("synthetic interrupted publication")

    store.fault = stop
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "interrupted"
    inode = (root / "Nested").stat().st_ino
    store.fault = lambda _: None
    retry(store, planned.id)
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "succeeded"
    assert (root / "Nested").stat().st_ino == inode


@pytest.mark.parametrize(
    "extra",
    [{"source": "file"}, {"upload": "upload"}, {"prior": "prior"}, {"collision": "replace"}],
)
def test_mkdir_rejects_unrelated_intent(tmp_path, extra):
    root, store = fixture(tmp_path)
    assert prepared(store, root, **extra).state == "interrupted"
    assert not (root / "Nested").exists()


def test_mkdir_rechecks_parent_at_publication(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Parent").mkdir()
    planned = prepared(store, root, "Parent/Nested")
    accept(store, planned.id, planned.receipt)

    def change(point):
        if point == "source_before_capture":
            (root / "Parent").rename(root / "Original")
            (root / "Parent").mkdir()

    store.fault = change
    run_one(store, root, lambda: None)
    assert job(store, planned.id).state == "interrupted"
    assert not (root / "Parent/Nested").exists()
    assert not (root / "Original/Nested").exists()


def test_received_mkdir_receipt_never_creates_a_peer_directory(tmp_path):
    import shutil

    from cairndex.replicas.source_transport import SourceTransport, ingest
    from tests.test_replica_creation import open_store

    root, store = fixture(tmp_path)
    peer_root = tmp_path / "peer"
    shutil.copytree(root, peer_root)
    peer = open_store(peer_root, tmp_path / "peer-private")
    perform(store, root, "folder", "mkdir", destination="Nested")
    with store.connection(readonly=True) as db:
        raw = db.execute("SELECT raw FROM source_receipts WHERE id='folder'").fetchone()[0]
    ingest(peer, raw)
    transport = SourceTransport(peer_root, peer)
    transport.tick()
    transport.close()
    assert not (peer_root / "Nested").exists()
    with peer.connection(readonly=True) as db:
        assert (
            db.execute("SELECT state FROM source_receipts WHERE id='folder'").fetchone()[0]
            == "accepted"
        )


@pytest.mark.parametrize("code", [5, 13, 28, 30])
def test_storage_failures_keep_safe_diagnostics_and_retry(tmp_path, monkeypatch, code):
    from cairndex.replicas import source_claims

    root, store = fixture(tmp_path)
    claim = source_claims.claim

    def unavailable(*args):
        raise OSError(code, "synthetic private path must never enter diagnostics")

    monkeypatch.setattr(source_claims, "claim", unavailable)
    failed = prepared(store, root)
    assert failed.state == "interrupted"
    assert failed.result["storage_failure"] == {
        "step": "claim",
        "errno": code,
        "ntstatus": None,
        "access": None,
    }
    assert "synthetic private" not in failed.model_dump_json()
    monkeypatch.setattr(source_claims, "claim", claim)
    retry(store, failed.id)
    run_one(store, root, lambda: None)
    ready = job(store, failed.id)
    assert ready.state == "prepared"
    assert "storage_failure" not in (ready.result or {})
    assert not (root / "Nested").exists()
