"""The normal API retains format, access, write and Release gates for source work."""

from urllib.parse import quote

import pytest

from cairndex.file_ops.gate import ensure_portable_write_mode
from cairndex.replicas import service
from cairndex.replicas.source_execute import run_one
from tests.test_library_scoped import create


@pytest.fixture(autouse=True)
def _manual_source_execution(monkeypatch):
    # These tests drive run_one against their isolated registry. The lifespan
    # worker uses the default registry and can claim their intents first on slow I/O.
    monkeypatch.setattr(service.ReplicaWorker, "run", lambda self: None)


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
    assert not (root / ".cairndex/source-operations/copy-upload/source").exists()
    assert prepared["review"]["versions_after"]["uploaded.txt"]["operation"] == "upload-one"
    progress = isolated_client.get(path + "/uploads/upload-one").json()
    assert progress == {
        "state": "ready",
        "received": len(content),
        "size": len(content),
        "error": None,
    }
    from cairndex.replicas.source_receipts import validate_private

    with store.connection(readonly=True) as db:
        validate_private(db, store)
    # The upload itself became the output (ADR-0042); no second copy is kept
    assert not (root / ".cairndex/source-operations/upload-one/source").exists()
    assert isolated_client.get(path + "/kept-copies").json() == {"count": 0, "size_bytes": 0}


@pytest.mark.parametrize("upload", ["bad.name", "bad space", "x" * 65])
def test_upload_rejects_invalid_identity_before_staging(isolated_client, tmp_path, upload):
    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}"
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 200
    before = set(root.rglob("*"))
    response = isolated_client.put(
        base + f"/source-operations/uploads/{quote(upload, safe='')}?size=9",
        content=b"Synthetic",
    )
    assert response.status_code == 422, response.text
    assert set(root.rglob("*")) == before
    with service._handles[identity][0].connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM source_uploads").fetchone()[0] == 0


def test_new_folder_requires_write_permission_through_application(
    isolated_client, registry_session, tmp_path
):
    identity, _ = create(isolated_client, tmp_path / "library")
    base = f"/api/v1/libraries/{identity}"
    intent = {"operation": "new-folder", "action": "mkdir", "destination": "Nested"}
    assert isolated_client.get(base + "/replica/status").json()["source_mkdir"] is True
    assert isolated_client.post(base + "/source-operations", json=intent).status_code == 403
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 200
    assert isolated_client.post(base + "/source-operations", json=intent).status_code == 202
    store = service._handles[identity][0]

    def authorize():
        ensure_portable_write_mode(registry_session, identity)

    run_one(store, tmp_path / "library", authorize)
    planned = isolated_client.get(base + "/source-operations/new-folder").json()
    assert planned["state"] == "prepared"
    assert isolated_client.put(base + "/write-mode", json={"enabled": False}).status_code == 200
    assert (
        isolated_client.post(
            base + "/source-operations/new-folder/accept", json={"receipt": planned["receipt"]}
        ).status_code
        == 403
    )
    assert not (tmp_path / "library/Nested").exists()
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 200
    assert (
        isolated_client.post(
            base + "/source-operations/new-folder/accept", json={"receipt": planned["receipt"]}
        ).status_code
        == 202
    )
    assert isolated_client.put(base + "/write-mode", json={"enabled": False}).status_code == 200
    registry_session.expire_all()
    run_one(store, tmp_path / "library", authorize)
    assert not (tmp_path / "library/Nested").exists()


@pytest.mark.parametrize("status,access", [(-25308, "authorization"), (-25300, "login")])
def test_source_login_failure_survives_exchange_and_authorization_preserves_intent(
    isolated_client, registry_session, tmp_path, monkeypatch, status, access
):
    import errno

    from cairndex.file_ops import smb_transport
    from cairndex.replicas import source_claims

    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}"
    intent = {"operation": "new-folder", "action": "mkdir", "destination": "Nested"}
    isolated_client.put(base + "/write-mode", json={"enabled": True})
    assert isolated_client.post(base + "/source-operations", json=intent).status_code == 202
    store = service._handles[identity][0]
    claim = source_claims.claim

    def refuse(*args):
        error = smb_transport.KeychainError(errno.EACCES, "synthetic private login detail")
        error.keychain_status = status
        raise error

    monkeypatch.setattr(source_claims, "claim", refuse)
    run_one(store, root, lambda: ensure_portable_write_mode(registry_session, identity))
    target = base + "/source-operations/new-folder"
    failed = isolated_client.get(target).json()
    assert failed["state"] == "interrupted"
    assert failed["result"]["storage_failure"]["access"] == access
    assert "synthetic private" not in str(failed)
    service.exchange(identity)
    assert isolated_client.get(base + "/replica/status").json()["storage_access"] == access
    asked = []
    monkeypatch.setattr(smb_transport, "authorize", asked.append)
    authorized = isolated_client.post(base + "/replica/storage-authorization")
    assert authorized.status_code == 200
    assert authorized.json()["storage_access"] is None
    assert asked == [root]
    stopped = isolated_client.get(target).json()
    assert stopped["state"] == "interrupted"
    assert stopped["request"] == failed["request"]
    assert stopped["result"]["storage_failure"]["step"] == "claim"
    assert not (root / "Nested").exists()
    monkeypatch.setattr(source_claims, "claim", claim)
    assert isolated_client.post(target + "/retry").status_code == 202
    run_one(store, root, lambda: ensure_portable_write_mode(registry_session, identity))
    ready = isolated_client.get(target).json()
    assert ready["state"] == "prepared"
    assert (
        isolated_client.post(target + "/accept", json={"receipt": ready["receipt"]}).status_code
        == 202
    )
    run_one(store, root, lambda: ensure_portable_write_mode(registry_session, identity))
    assert isolated_client.get(target).json()["state"] == "succeeded"
    assert (root / "Nested").is_dir()


def test_file_task_prepares_share_access_before_its_first_step(
    isolated_client, tmp_path, monkeypatch
):
    import errno

    from cairndex.file_ops import smb_transport

    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}"
    access = base + "/source-operations/access"
    assert isolated_client.post(access).status_code == 403
    isolated_client.put(base + "/write-mode", json={"enabled": True})
    # A library outside a network share needs nothing from macOS
    assert isolated_client.post(access).status_code == 204
    asked = []
    monkeypatch.setattr(smb_transport, "ensure_access", asked.append)
    assert isolated_client.post(access).status_code == 204
    assert asked == [root]

    def refuse(path):
        error = smb_transport.KeychainError(errno.EACCES, "synthetic private login detail")
        error.keychain_status = -25308
        raise error

    monkeypatch.setattr(smb_transport, "ensure_access", refuse)
    refused = isolated_client.post(access)
    assert refused.status_code == 409
    assert "needs your permission" in refused.text
    assert "synthetic private" not in refused.text


def test_refused_upload_says_why_after_the_connection_closes(
    isolated_client, tmp_path, monkeypatch
):
    from cairndex.replicas import source_claims
    from cairndex.replicas.protocol import ReplicaError

    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}/source-operations/uploads/refused"
    isolated_client.put(f"/api/v1/libraries/{identity}/write-mode", json={"enabled": True})
    claim = source_claims.claim

    def refuse(*args):
        raise ReplicaError("Synthetic storage refusal")

    monkeypatch.setattr(source_claims, "claim", refuse)
    assert isolated_client.put(base + "?size=9", content=b"synthetic").status_code == 409
    stopped = isolated_client.get(base).json()
    assert stopped["state"] == "interrupted"
    assert stopped["error"] == "Synthetic storage refusal"
    # A later attempt starts clean and a finished upload reports no failure
    monkeypatch.setattr(source_claims, "claim", claim)
    assert isolated_client.put(base + "?size=9", content=b"synthetic").status_code == 201
    assert isolated_client.get(base).json() == {
        "state": "ready",
        "received": 9,
        "size": 9,
        "error": None,
    }


def test_interrupted_folder_collision_can_be_cancelled(isolated_client, tmp_path):
    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    base = f"/api/v1/libraries/{identity}"
    isolated_client.put(base + "/write-mode", json={"enabled": True})
    (root / "Taken").mkdir()
    path = base + "/source-operations"
    isolated_client.post(
        path, json={"operation": "folder", "action": "mkdir", "destination": "Taken"}
    )
    store = service._handles[identity][0]
    run_one(store, root, lambda: None)
    assert isolated_client.get(path + "/folder").json()["state"] == "interrupted"
    assert isolated_client.delete(path + "/folder").status_code == 204
    assert isolated_client.get(path + "/folder").json()["state"] == "cancelled"
    assert (root / "Taken").is_dir()
