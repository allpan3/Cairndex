"""Relocation preserves original objects and never reads their content."""

import os

import pytest

from cairndex.replicas import source_files
from cairndex.replicas.source_execute import run_one
from cairndex.replicas.source_journal import SourceRequest, accept, enqueue, job, retry
from tests.test_portable_source_operations import fixture, perform


def original(store, root, operation, action, source="", destination="", prior=None):
    return perform(store, root, operation, action, source, destination, prior=prior)


def no_copy(*args, **kwargs):
    raise AssertionError("Original relocation must not copy content")


def test_relocation_trash_and_return_preserve_identity_attributes_and_content(
    tmp_path, monkeypatch
):
    root, store = fixture(tmp_path)
    path = root / "sample.txt"
    path.write_bytes(b"Synthetic content")
    path.chmod(0o640)
    os.utime(path, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    before = path.stat()
    monkeypatch.setattr(source_files, "copy_stream", no_copy)
    original(store, root, "rename", "relocate", "sample.txt", "renamed.txt")
    moved = root / "renamed.txt"
    assert moved.stat().st_ino == before.st_ino
    assert moved.stat().st_mtime_ns == before.st_mtime_ns
    assert moved.stat().st_mode == before.st_mode
    original(store, root, "trash", "retain", "renamed.txt")
    assert not moved.exists()
    retained = root / ".cairndex/source-operations/trash/original"
    assert retained.stat().st_ino == before.st_ino
    original(store, root, "put-back", "return", prior="trash")
    assert moved.stat().st_ino == before.st_ino
    original(store, root, "undo-rename", "return", prior="rename")
    assert path.stat().st_ino == before.st_ino
    assert path.read_bytes() == b"Synthetic content"
    assert not list((root / ".cairndex/source-operations").glob("*/source"))


def test_relocation_preserves_catalog_content_and_file_identity(tmp_path, monkeypatch):
    root, store = fixture(tmp_path)
    (root / "input.txt").write_bytes(b"Synthetic source")
    copied = perform(store, root, "copy", "copy", "input.txt", "source.txt")
    identity = copied.review["output_id"]
    old = store.entity("asset_files", identity)["fields"]["$content"]
    monkeypatch.setattr(source_files, "copy_stream", no_copy)
    moved = original(store, root, "rename", "relocate", "source.txt", "target.txt")
    assert moved.review["output_id"] == identity
    assert store.entity("asset_files", identity)["fields"]["$content"] == old
    original(store, root, "trash", "retain", "target.txt")
    original(store, root, "restore", "return", prior="trash")
    assert (
        store.entity("asset_files", identity)["fields"]["relative_path"]["value"] == '"target.txt"'
    )


@pytest.mark.parametrize(
    "boundary",
    [
        "source_before_capture",
        "source_after_publication",
        "source_before_catalog_commit",
        "source_after_catalog_commit",
    ],
)
def test_relocation_restart_at_each_boundary(tmp_path, boundary):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic restart")
    inode = (root / "source.txt").stat().st_ino
    enqueue(
        store,
        SourceRequest(
            operation="move", action="relocate", source="source.txt", destination="target.txt"
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "move", job(store, "move").receipt)

    fired = []

    def fault(point):
        if point == boundary:
            fired.append(point)
            raise OSError("Synthetic interruption")

    store.fault = fault
    run_one(store, root, lambda: None)
    store.fault = lambda point: None
    assert fired == [boundary]
    if job(store, "move").state != "succeeded":
        retry(store, "move")
        run_one(store, root, lambda: None)
    assert job(store, "move").state == "succeeded", job(store, "move").error
    assert (root / "target.txt").stat().st_ino == inode
    assert not (root / "source.txt").exists()


def test_rename_undo_and_put_back_each_move_once_without_an_operation_directory(
    tmp_path, monkeypatch
):
    from cairndex.replicas import source_original_files

    root, store = fixture(tmp_path)
    (root / "sample.txt").write_bytes(b"Synthetic content")
    moves = []
    relocate = source_original_files.relocate

    def counted(*args):
        moves.append(args[1:4:2])
        relocate(*args)

    monkeypatch.setattr(source_original_files, "relocate", counted)
    operations = root / ".cairndex/source-operations"
    original(store, root, "rename", "relocate", "sample.txt", "renamed.txt")
    original(store, root, "undo-rename", "return", prior="rename")
    assert moves == [("sample.txt", "renamed.txt"), ("renamed.txt", "sample.txt")]
    assert not (operations / "rename").exists()
    assert not (operations / "undo-rename").exists()
    moves.clear()
    original(store, root, "trash", "retain", "sample.txt")
    original(store, root, "put-back", "return", prior="trash")
    # Trash keeps the original in its own claimed directory; Put Back is one move out
    assert moves == [("sample.txt", "original"), ("original", "sample.txt")]
    assert (operations / "trash/claim").is_file()
    assert not (operations / "put-back").exists()
    assert (root / "sample.txt").read_bytes() == b"Synthetic content"


def test_return_refuses_changed_original_and_new_arrival(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic original")
    original(store, root, "move", "relocate", "source.txt", "target.txt")
    (root / "source.txt").write_bytes(b"New arrival")
    enqueue(store, SourceRequest(operation="return", action="return", prior="move"))
    run_one(store, root, lambda: None)
    assert job(store, "return").state == "interrupted"
    assert (root / "source.txt").read_bytes() == b"New arrival"


def test_directory_move_includes_hidden_and_large_untracked_subtrees(tmp_path, monkeypatch):
    root, store = fixture(tmp_path)
    folder = root / "Folder"
    folder.mkdir()
    for index in range(500):
        (folder / f"sample-{index}.txt").write_bytes(b"Synthetic")
    (folder / ".hidden").write_bytes(b"Hidden synthetic data")
    inode = folder.stat().st_ino
    monkeypatch.setattr(source_files, "copy_stream", no_copy)
    original(store, root, "folder-move", "relocate", "Folder", "Moved")
    assert (root / "Moved").stat().st_ino == inode
    assert len(list((root / "Moved").iterdir())) == 501
    original(store, root, "folder-return", "return", prior="folder-move")
    assert folder.stat().st_ino == inode


@pytest.mark.parametrize(
    "boundary",
    [None, "source_after_capture", "source_after_deletion", "source_before_catalog_commit"],
)
def test_permanent_delete_is_explicit_resumable_and_preserves_old_copies(tmp_path, boundary):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic source")
    perform(store, root, "old-copy", "copy", "source.txt", "copied.txt")
    original(store, root, "trash", "retain", "copied.txt")
    old_bytes = root / ".cairndex/source-operations/old-copy/source"
    enqueue(store, SourceRequest(operation="delete", action="purge", prior="trash"))
    run_one(store, root, lambda: None)
    assert job(store, "delete").state == "prepared", job(store, "delete").error
    assert (root / ".cairndex/source-operations/trash/original").exists()
    accept(store, "delete", job(store, "delete").receipt)

    def fault(point):
        if point == boundary:
            raise OSError("Synthetic deletion interruption")

    store.fault = fault
    run_one(store, root, lambda: None)
    store.fault = lambda point: None
    if job(store, "delete").state != "succeeded":
        retry(store, "delete")
        run_one(store, root, lambda: None)
    assert job(store, "delete").state == "succeeded", job(store, "delete").error
    assert old_bytes.read_bytes() == b"Synthetic source"
    assert not (root / ".cairndex/source-operations/delete/original").exists()
    assert not (root / ".cairndex/source-operations/trash/original").exists()
    enqueue(store, SourceRequest(operation="too-late", action="return", prior="trash"))
    run_one(store, root, lambda: None)
    assert job(store, "too-late").state == "interrupted"
    assert "permanently deleted" in job(store, "too-late").error


def test_original_receipts_reject_old_readers_and_never_verify_invented_hashes(tmp_path):
    import json

    from pydantic import ValidationError

    from cairndex.replicas.source_receipts import SourceReceipt, validate_private
    from cairndex.replicas.source_transport import SourceTransport, ingest

    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic original")
    original(store, root, "rename", "relocate", "source.txt", "moved.txt")
    with store.connection(readonly=True) as db:
        raw = db.execute("SELECT raw FROM source_receipts WHERE id='rename'").fetchone()[0]
        validate_private(db, store)
    assert "identity" not in raw and "generation" not in raw
    assert "digest" not in json.dumps(json.loads(raw)["versions_after"])
    with pytest.raises(ValidationError):
        SourceReceipt.model_validate_json(raw)
    ingest(store, raw)
    assert list(SourceTransport(root, store).verify_sources()) == []


def test_same_volume_rename_preserves_extended_attributes(tmp_path):
    root, store = fixture(tmp_path)
    path = root / "source.txt"
    path.write_bytes(b"Synthetic attributes")
    name = "user.cairndex.synthetic"
    import subprocess
    import sys

    if sys.platform == "darwin":
        subprocess.run(["/usr/bin/xattr", "-w", name, "Synthetic attribute", str(path)], check=True)
    else:
        os.setxattr(path, name, b"Synthetic attribute")
    original(store, root, "move", "relocate", "source.txt", "target.txt")
    if sys.platform == "darwin":
        value = subprocess.check_output(
            ["/usr/bin/xattr", "-p", name, str(root / "target.txt")]
        ).rstrip(b"\n")
    else:
        value = os.getxattr(root / "target.txt", name)
    assert value == b"Synthetic attribute"


def test_case_only_rename_and_return(tmp_path):
    root, store = fixture(tmp_path)
    (root / "Sample.txt").write_bytes(b"Synthetic case")
    original(store, root, "case", "relocate", "Sample.txt", "sample.txt")
    assert "sample.txt" in os.listdir(root)
    assert "Sample.txt" not in os.listdir(root)
    original(store, root, "case-return", "return", prior="case")
    assert "Sample.txt" in os.listdir(root)
    assert "sample.txt" not in os.listdir(root)


def test_directory_purge_is_bounded_and_resumes_after_partial_deletion(tmp_path, monkeypatch):
    from cairndex.replicas import source_original_files

    root, store = fixture(tmp_path)
    folder = root / "Folder"
    (folder / "Nested").mkdir(parents=True)
    (folder / "Nested/first.txt").write_bytes(b"Synthetic first")
    (folder / "Nested/second.txt").write_bytes(b"Synthetic second")
    (folder / ".hidden").write_bytes(b"Synthetic hidden")
    original(store, root, "trash-folder", "retain", "Folder")
    enqueue(store, SourceRequest(operation="empty-folder", action="purge", prior="trash-folder"))
    run_one(store, root, lambda: None)
    accept(store, "empty-folder", job(store, "empty-folder").receipt)
    real_remove = source_original_files.remove_entry
    removed = 0

    def interrupt(*args, **kwargs):
        nonlocal removed
        real_remove(*args, **kwargs)
        removed += 1
        if removed == 1:
            raise OSError("Synthetic lost deletion reply")

    monkeypatch.setattr(source_original_files, "remove_entry", interrupt)
    run_one(store, root, lambda: None)
    assert job(store, "empty-folder").state == "interrupted"
    monkeypatch.setattr(source_original_files, "remove_entry", real_remove)
    retry(store, "empty-folder")
    run_one(store, root, lambda: None)
    assert job(store, "empty-folder").state == "succeeded", job(store, "empty-folder").error
    assert not (root / ".cairndex/source-operations/empty-folder/original").exists()


def test_purge_refuses_changed_original_and_does_not_accept_legacy_copies(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic original")
    original(store, root, "trash", "retain", "source.txt")
    artifact = root / ".cairndex/source-operations/trash/original"
    artifact.write_bytes(b"Later edit")
    enqueue(store, SourceRequest(operation="empty", action="purge", prior="trash"))
    run_one(store, root, lambda: None)
    assert job(store, "empty").state == "interrupted"
    assert artifact.read_bytes() == b"Later edit"


def test_return_refuses_changed_descendant_before_moving_directory(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic source")
    (root / "Folder").mkdir()
    perform(store, root, "copy", "copy", "source.txt", "Folder/child.txt")
    original(store, root, "trash", "retain", "Folder")
    child = root / ".cairndex/source-operations/trash/original/child.txt"
    child.write_bytes(b"Changed synthetic child")
    enqueue(store, SourceRequest(operation="return", action="return", prior="trash"))
    run_one(store, root, lambda: None)
    assert job(store, "return").state == "interrupted"
    assert not (root / "Folder").exists()
    assert child.read_bytes() == b"Changed synthetic child"


def test_large_original_relocation_reads_zero_content_bytes(tmp_path, monkeypatch):
    import builtins
    import io

    root, store = fixture(tmp_path)
    path = root / "large.bin"
    with path.open("wb") as file:
        file.truncate(512 * 1024**2)
    identity = (path.stat().st_dev, path.stat().st_ino)
    read = os.read
    content_bytes = 0

    def counted_read(fd, size):
        nonlocal content_bytes
        info = os.fstat(fd)
        data = read(fd, size)
        if (info.st_dev, info.st_ino) == identity:
            content_bytes += len(data)
        return data

    def guarded_open(open_file):
        def checked(*args, **kwargs):
            result = open_file(*args, **kwargs)
            info = os.fstat(result.fileno())
            if (info.st_dev, info.st_ino) == identity:
                result.close()
                raise AssertionError("Source content stream opened during relocation")
            return result

        return checked

    monkeypatch.setattr(os, "read", counted_read)
    monkeypatch.setattr(io, "open", guarded_open(io.open))
    monkeypatch.setattr(builtins, "open", guarded_open(builtins.open))
    monkeypatch.setattr(source_files, "copy_stream", no_copy)
    original(store, root, "rename-large", "relocate", "large.bin", "renamed.bin")
    original(store, root, "trash-large", "retain", "renamed.bin")
    original(store, root, "return-large", "return", prior="trash-large")
    original(store, root, "undo-large", "return", prior="rename-large")
    assert (path.stat().st_dev, path.stat().st_ino) == identity
    assert path.stat().st_size == 512 * 1024**2
    assert content_bytes == 0


def test_empty_trash_refuses_historical_copy_contract(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic historical source")
    perform(store, root, "old-trash", "trash", "source.txt")
    enqueue(store, SourceRequest(operation="purge-old", action="purge", prior="old-trash"))
    run_one(store, root, lambda: None)
    assert job(store, "purge-old").state == "interrupted"
    assert "independent-copy" in job(store, "purge-old").error
    assert (
        root / ".cairndex/source-operations/old-trash/source"
    ).read_bytes() == b"Synthetic historical source"


def test_new_source_arrival_before_commit_preserves_both_objects(tmp_path):
    root, store = fixture(tmp_path)
    (root / "source.txt").write_bytes(b"Synthetic original")
    enqueue(
        store,
        SourceRequest(
            operation="move", action="relocate", source="source.txt", destination="target.txt"
        ),
    )
    run_one(store, root, lambda: None)
    accept(store, "move", job(store, "move").receipt)

    def fault(point):
        if point == "source_after_publication":
            (root / "source.txt").write_bytes(b"Synthetic new arrival")

    store.fault = fault
    run_one(store, root, lambda: None)
    assert job(store, "move").state == "interrupted"
    assert "new source arrived" in job(store, "move").error
    assert (root / "source.txt").read_bytes() == b"Synthetic new arrival"
    assert (root / "target.txt").read_bytes() == b"Synthetic original"
