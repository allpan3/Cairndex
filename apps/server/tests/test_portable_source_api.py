"""The normal API retains format, access, write and Release gates for source work."""

from cairndex.file_ops.gate import ensure_portable_write_mode
from cairndex.replicas import service
from cairndex.replicas.source_execute import run_one
from tests.test_library_scoped import create


def test_normal_portable_source_review_and_gates(isolated_client, registry_session, tmp_path):
    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    (root / "source.txt").write_bytes(b"Synthetic source")
    base = f"/api/v1/libraries/{identity}"
    path = base + "/source-operations"
    intent = {
        "operation": "source-copy",
        "action": "copy",
        "source": "source.txt",
        "destination": "copy.txt",
    }
    assert isolated_client.post(path, json=intent).status_code == 403
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 200
    queued = isolated_client.post(path, json=intent)
    assert queued.status_code == 202, queued.text
    assert queued.json()["state"] == "queued"
    assert not (root / "copy.txt").exists()
    store = service._handles[identity][0]

    def authorize():
        ensure_portable_write_mode(registry_session, identity)

    run_one(store, root, authorize)
    prepared = isolated_client.get(path + "/source-copy").json()
    assert prepared["state"] == "prepared", prepared
    assert not (root / "copy.txt").exists()
    assert (
        isolated_client.post(path + "/source-copy/accept", json={"receipt": "0" * 64}).status_code
        == 409
    )
    assert (
        isolated_client.post(
            path + "/source-copy/accept", json={"receipt": prepared["receipt"]}
        ).status_code
        == 202
    )
    run_one(store, root, authorize)
    assert (root / "copy.txt").read_bytes() == b"Synthetic source"
    assert isolated_client.post(path, json=intent).json()["state"] == "succeeded"
    assert (
        isolated_client.post(path, json=intent | {"destination": "changed.txt"}).status_code == 409
    )
    assert isolated_client.get(path + "/receipts").json()["items"][0]["id"] == "source-copy"
    assert isolated_client.post(base + "/ownership/release").status_code == 200
    assert (
        isolated_client.post(path, json=intent | {"operation": "released-copy"}).status_code == 409
    )
    assert not (root / "changed.txt").exists()


def test_picker_upload_copies_with_exact_retry(isolated_client, registry_session, tmp_path):
    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}"
    path = base + "/source-operations"
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 200
    content = b"Synthetic uploaded bytes"
    for _ in range(2):
        response = isolated_client.put(
            path + f"/uploads/upload-one?size={len(content)}", content=content
        )
        assert response.status_code == 201, response.text
    intent = {
        "operation": "copy-upload",
        "action": "copy",
        "upload": "upload-one",
        "destination": "uploaded.txt",
    }
    assert isolated_client.post(path, json=intent).status_code == 202
    store = service._handles[identity][0]
    run_one(store, root, lambda: ensure_portable_write_mode(registry_session, identity))
    prepared = isolated_client.get(path + "/copy-upload").json()
    assert prepared["state"] == "prepared", prepared
    assert (
        isolated_client.post(
            path + "/copy-upload/accept", json={"receipt": prepared["receipt"]}
        ).status_code
        == 202
    )
    run_one(store, root, lambda: ensure_portable_write_mode(registry_session, identity))
    assert isolated_client.get(path + "/copy-upload").json()["state"] == "succeeded"
    assert (root / "uploaded.txt").read_bytes() == content
    assert (root / ".cairndex/source-operations/upload-one/source").read_bytes() == content
