"""Upload batching and progress retain exact bytes and independent outputs."""

import asyncio

import pytest

from cairndex.replicas import source_uploads
from cairndex.replicas.source_execute import run_one
from cairndex.replicas.source_journal import SourceRequest, accept, enqueue, job
from tests.test_portable_source_operations import fixture


def test_fragmented_upload_reports_received_bytes_and_bounds_writes(tmp_path):
    root, store = fixture(tmp_path)
    data = b"synthetic" * (1024 * 1024)
    observations = []
    checks = []

    async def chunks():
        for offset in range(0, len(data), 8192):
            yield data[offset : offset + 8192]
            observations.append(source_uploads.progress(store, "upload").received)

    asyncio.run(
        source_uploads.receive(
            store, root, "upload", len(data), chunks(), lambda: checks.append(True)
        )
    )
    assert any(0 < count < len(data) for count in observations)
    assert len(checks) == 1 + 3
    assert source_uploads.progress(store, "upload").received == len(data)
    assert (store.path, "upload") not in source_uploads._active
    assert (root / ".cairndex/source-operations/upload/source").read_bytes() == data


def test_mutated_retained_upload_is_refused_before_publication(tmp_path):
    root, store = fixture(tmp_path)

    async def chunks():
        yield b"synthetic original"

    asyncio.run(source_uploads.receive(store, root, "upload", 18, chunks(), lambda: None))
    enqueue(
        store,
        SourceRequest(operation="copy", action="copy", upload="upload", destination="copy.txt"),
    )
    run_one(store, root, lambda: None)
    prepared = job(store, "copy")
    assert prepared.state == "prepared"
    (root / ".cairndex/source-operations/upload/source").write_bytes(b"synthetic replaced")
    accept(store, "copy", prepared.receipt)
    run_one(store, root, lambda: None)
    assert job(store, "copy").state == "interrupted"
    assert not (root / "copy.txt").exists()


def test_upload_failure_clears_live_progress(tmp_path):
    root, store = fixture(tmp_path)

    async def chunks():
        yield b"partial"
        raise OSError("synthetic disconnect")

    with pytest.raises(OSError):
        asyncio.run(source_uploads.receive(store, root, "upload", 12, chunks(), lambda: None))
    assert (store.path, "upload") not in source_uploads._active
    assert source_uploads.progress(store, "upload").state == "interrupted"


def test_reused_upload_survives_bad_retry_and_restores_independent_outputs(tmp_path):
    from cairndex.replicas.source_journal import cancel
    from cairndex.replicas.source_receipts import validate_private
    from tests.test_portable_source_operations import perform

    root, store = fixture(tmp_path)
    data = b"synthetic original"

    async def chunks(value=data):
        yield value

    asyncio.run(source_uploads.receive(store, root, "upload", len(data), chunks(), lambda: None))
    for operation in ("first", "second"):
        enqueue(
            store,
            SourceRequest(
                operation=operation,
                action="copy",
                upload="upload",
                destination=operation + ".txt",
                byte_limit=len(data) * 2,
            ),
        )
        run_one(store, root, lambda: None)
        prepared = job(store, operation)
        assert prepared.state == "prepared"
        accept(store, operation, prepared.receipt)
        run_one(store, root, lambda: None)
        assert job(store, operation).state == "succeeded"
    from cairndex.replicas.protocol import ReplicaError

    with pytest.raises(ReplicaError, match="different bytes"):
        asyncio.run(
            source_uploads.receive(
                store, root, "upload", len(data), chunks(b"X" * len(data)), lambda: None
            )
        )
    assert source_uploads.progress(store, "upload").state == "ready"
    with store.connection(readonly=True) as db:
        validate_private(db, store)
    (root / "first.txt").write_bytes(b"changed independently")
    assert (root / "second.txt").read_bytes() == data
    enqueue(
        store,
        SourceRequest(
            operation="restore",
            action="restore",
            prior="first",
            version="output",
            destination="restored.txt",
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "restore", job(store, "restore").receipt)
    run_one(store, root, lambda: None)
    assert job(store, "restore").state == "succeeded"
    assert (root / "restored.txt").read_bytes() == data
    perform(store, root, "undo-second", "undo", prior="second")
    assert not (root / "second.txt").exists()
    assert (root / ".cairndex/source-operations/upload/source").read_bytes() == data
    cancel(store, "first")  # Completed operations are idempotently left complete.
    assert job(store, "first").state == "succeeded"


@pytest.mark.parametrize("state", ["interrupted", "accepted", "applying"])
def test_started_interruption_cannot_be_cancelled(tmp_path, state):
    from cairndex.replicas.protocol import ReplicaError
    from cairndex.replicas.source_journal import cancel

    _, store = fixture(tmp_path)
    enqueue(store, SourceRequest(operation="started", action="mkdir", destination="Folder"))
    with store.connection() as db:
        db.execute(
            "UPDATE source_operations SET state=?,result=? WHERE id='started'",
            (state, '{"started":true}'),
        )
    with pytest.raises(ReplicaError, match="finish recovery"):
        cancel(store, "started")
    assert job(store, "started").state == state


def test_throttled_progress_still_checks_cancellation_between_blocks(tmp_path, monkeypatch):
    from cairndex.replicas import source_execute
    from cairndex.replicas.source_journal import cancel

    root, store = fixture(tmp_path)
    enqueue(store, SourceRequest(operation="cancel", action="mkdir", destination="Folder"))
    monkeypatch.setattr(source_execute.time, "monotonic", lambda: 1.0)

    def prepare(store, root, request, progress):
        progress(1)
        progress(2)
        cancel(store, request.operation)
        progress(3)
        pytest.fail("Cancellation was not checked between progress reports")

    monkeypatch.setattr(source_execute, "prepare", prepare)
    run_one(store, root, lambda: None)
    assert job(store, "cancel").state == "cancelled"
    assert not (root / "Folder").exists()


def test_interrupted_old_upload_snapshot_keeps_its_version_on_retry(tmp_path):
    import shutil

    from cairndex.replicas.source_files import operation_directory
    from cairndex.replicas.source_journal import retain_version

    root, store = fixture(tmp_path)

    async def chunks():
        yield b"synthetic"

    asyncio.run(source_uploads.receive(store, root, "upload", 9, chunks(), lambda: None))
    enqueue(
        store,
        SourceRequest(operation="old-copy", action="copy", upload="upload", destination="copy.txt"),
    )
    with operation_directory(root, "old-copy", create=True):
        pass
    shutil.copyfile(
        root / ".cairndex/source-operations/upload/source",
        root / ".cairndex/source-operations/old-copy/source",
    )
    evidence = source_uploads.uploaded_version(store, root, "upload", 100)
    retain_version(store, "old-copy", "", "source", evidence)
    run_one(store, root, lambda: None)
    prepared = job(store, "old-copy")
    assert prepared.state == "prepared"
    assert prepared.review["versions_after"]["copy.txt"]["operation"] == "old-copy"
    accept(store, "old-copy", prepared.receipt)
    run_one(store, root, lambda: None)
    assert job(store, "old-copy").state == "succeeded"
    assert (root / "copy.txt").read_bytes() == b"synthetic"


def test_completed_upload_cannot_adopt_changed_bytes_on_retry(tmp_path):
    from cairndex.replicas.protocol import ReplicaError

    root, store = fixture(tmp_path)

    async def chunks(data):
        yield data

    asyncio.run(source_uploads.receive(store, root, "upload", 3, chunks(b"old"), lambda: None))
    expected = source_uploads.uploaded_version(store, root, "upload", 3)
    (root / ".cairndex/source-operations/upload/source").write_bytes(b"new")
    with pytest.raises(ReplicaError, match="original evidence"):
        asyncio.run(source_uploads.receive(store, root, "upload", 3, chunks(b"new"), lambda: None))
    assert source_uploads.uploaded_version(store, root, "upload", 3) == expected

