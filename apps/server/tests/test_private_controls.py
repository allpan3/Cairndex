"""Normal private controls use disposable catalogs and exact recovery receipts."""

from uuid import uuid4

from sqlalchemy.orm import sessionmaker

from cairndex.api.deps import RegistryAccess, get_registry_access, get_registry_db
from cairndex.auth import session_store
from cairndex.replicas.recovery_tasks import RecoveryWorker
from tests.test_replica_catalog_api import api as api


def worker(client):
    generator = client.app.dependency_overrides[get_registry_db]()
    session = next(generator)
    factory = sessionmaker(bind=session.bind, expire_on_commit=False)
    generator.close()
    client.app.dependency_overrides[get_registry_access] = lambda: RegistryAccess(factory.begin)
    return RecoveryWorker(factory)


def run(client, base, runner, action, **body):
    response = client.post(
        base + "/private-recovery/tasks", json={"operation": uuid4().hex, "action": action, **body}
    )
    assert response.status_code == 202, response.text
    task_id = response.json()["id"]
    assert runner.run_one()
    result = client.get(base + "/private-recovery/tasks/" + task_id)
    assert result.status_code == 200, result.text
    return result.json()


def test_private_guard_reads_writes_media_and_backup(api):
    client, base, store = api
    worker(client)
    assert client.get(base + "/auth/status").json()["access_settings_version"] == 1
    configured = client.put(base + "/auth/settings", json={"passphrase": "synthetic secret"})
    assert configured.status_code == 200, configured.text
    assert configured.json()["protected"]
    assert client.post(base + "/auth/lock").status_code == 200
    for suffix in (
        "/replica/catalog/entities/asset_bundles",
        "/replica/media/directory",
        "/private-recovery/tasks",
    ):
        assert client.get(base + suffix).status_code == 401
    assert (
        client.post(
            base + "/private-recovery/tasks", json={"operation": uuid4().hex, "action": "backup"}
        ).status_code
        == 401
    )
    assert client.post(base + "/auth/unlock", json={"passphrase": "wrong"}).status_code == 401
    assert (
        client.post(base + "/auth/unlock", json={"passphrase": "synthetic secret"}).status_code
        == 200
    )
    assert (
        client.put(
            base + "/auth/settings", json={"passphrase": "changed", "current_passphrase": "wrong"}
        ).status_code
        == 401
    )
    assert (
        client.put(
            base + "/auth/settings",
            json={"passphrase": "changed", "current_passphrase": "synthetic secret"},
        ).status_code
        == 200
    )
    session_store.clear()
    assert client.get(base + "/auth/status").json()["unlocked"] is False
    assert (
        client.post(base + "/auth/unlock", json={"passphrase": "synthetic secret"}).status_code
        == 401
    )
    assert client.post(base + "/auth/unlock", json={"passphrase": "changed"}).status_code == 200
    assert (
        client.put(
            base + "/auth/settings", json={"passphrase": None, "current_passphrase": "changed"}
        ).status_code
        == 200
    )


def test_live_snapshot_review_activation_and_reopen(api):
    client, base, store = api
    runner = worker(client)
    store.draft("received", "asset_bundles/bundle-000000", 2, {"text": "Synthetic unsaved text"})
    snapshot = run(client, base, runner, "backup")
    assert snapshot["state"] == "succeeded", snapshot
    assert snapshot["result"]["inventory"]["tables"]["drafts"] == 1
    assert run(client, base, runner, "verify", backup=snapshot["id"])["state"] == "succeeded"
    assert run(client, base, runner, "prepare", backup=snapshot["id"])["state"] == "failed"
    assert client.post(base + "/ownership/release").status_code == 200
    prepared = run(client, base, runner, "prepare", backup=snapshot["id"])
    assert prepared["state"] == "succeeded", prepared
    assert prepared["result"]["state"] == "prepared", prepared
    reviewed = run(client, base, runner, "review", recovery=prepared["id"])
    records = run(client, base, runner, "inspect", recovery=prepared["id"], kind="drafts")
    assert records["result"]["items"][0]["id"] == "received"
    assert records["result"]["kind"] == "drafts"
    assert records["result"]["source"] == "prepared"
    wrong = run(client, base, runner, "activate", recovery=prepared["id"], receipt="0" * 64)
    assert wrong["state"] == "failed"
    activated = run(
        client,
        base,
        runner,
        "activate",
        recovery=prepared["id"],
        receipt=reviewed["result"]["receipt"],
    )
    assert activated["state"] == "succeeded", activated
    assert store.path.exists()
    assert client.post(base + "/ownership/reopen").status_code == 200
    assert client.get(base + "/replica/catalog/entities/asset_bundles").status_code == 200


def test_recovery_references_paths_and_exact_retries(api):
    client, base, store = api
    runner = worker(client)
    request = {"operation": uuid4().hex, "action": "backup"}
    first = client.post(base + "/private-recovery/tasks", json=request)
    assert first.status_code == 202
    assert (
        client.post(base + "/private-recovery/tasks", json=request).json()["id"]
        == request["operation"]
    )
    assert (
        client.post(
            base + "/private-recovery/tasks", json=request | {"action": "prepare"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            base + "/private-recovery/tasks", json=request | {"output": "/outside"}
        ).status_code
        == 422
    )
    runner.recover_interrupted()
    assert (
        client.get(base + "/private-recovery/tasks/" + request["operation"]).json()["state"]
        == "interrupted"
    )
    assert (
        client.post(base + "/private-recovery/tasks/" + request["operation"] + "/retry").status_code
        == 200
    )
    runner.run_one()
    assert (
        client.get(base + "/private-recovery/tasks/" + request["operation"]).json()["state"]
        == "succeeded"
    )


def test_local_sidecar_grant_requires_passphrase_and_restart(api, monkeypatch):
    from cairndex.core.config import get_settings

    client, base, store = api
    worker(client)
    monkeypatch.setattr(get_settings(), "local_token", "synthetic-owner-token")
    headers = {"Authorization": "Bearer synthetic-owner-token"}
    assert (
        client.put(
            base + "/auth/settings", headers=headers, json={"passphrase": "local guard"}
        ).status_code
        == 200
    )
    client.cookies.clear()
    assert (
        client.get(base + "/replica/catalog/entities/asset_bundles", headers=headers).status_code
        == 200
    )
    assert client.post(base + "/auth/lock", headers=headers).status_code == 200
    assert client.get(base + "/auth/status", headers=headers).json()["unlocked"] is False
    assert client.get(base + "/replica/media/directory", headers=headers).status_code == 401
    assert (
        client.post(
            base + "/auth/unlock", headers=headers, json={"passphrase": "local guard"}
        ).status_code
        == 200
    )
    assert client.get(base + "/replica/media/directory", headers=headers).status_code == 200
    session_store.clear()
    assert (
        client.get(base + "/replica/catalog/entities/asset_bundles", headers=headers).status_code
        == 401
    )


def test_credentials_stay_private_and_tokens_are_revoked(api, tmp_path, monkeypatch):
    from pathlib import Path

    from cairndex.auth import is_protected, private_auth
    from cairndex.core.config import get_settings
    from cairndex.registry import device_tokens
    from cairndex.registry.models import RegisteredLibrary

    client, base, store = api
    runner = worker(client)
    with runner.factory() as session:
        library = session.get(RegisteredLibrary, base.split("/")[-1])
        root = Path(library.root_path)
        token = device_tokens.issue_device_token(
            session, name="Synthetic client", library_ids=[library.id]
        )
        session.commit()
    before = {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    assert (
        client.put(base + "/auth/settings", json={"passphrase": "not portable"}).status_code == 200
    )
    assert (
        client.get(
            base + "/replica/status", headers={"Authorization": "Bearer " + token}
        ).status_code
        == 401
    )
    assert before == {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    assert b"not portable" not in private_auth.path_for(root).read_bytes()
    assert run(client, base, runner, "backup")["state"] == "succeeded"
    monkeypatch.setattr(get_settings(), "data_dir", tmp_path / "other-server")
    assert not is_protected(root)


def test_changed_original_blocks_reviewed_activation(api):
    from cairndex.replicas.recovery_validation import open_store

    client, base, store = api
    runner = worker(client)
    snapshot = run(client, base, runner, "backup")
    client.post(base + "/ownership/release")
    prepared = run(client, base, runner, "prepare", backup=snapshot["id"])
    original = open_store(
        store.directory if hasattr(store, "directory") else store.path.parent, store.descriptor
    )
    original.draft("newer-draft", "asset_bundles/bundle-000000", 1, {"text": "Keep newer work"})
    result = run(
        client,
        base,
        runner,
        "activate",
        recovery=prepared["id"],
        receipt=prepared["result"]["receipt"],
    )
    assert result["state"] == "failed"
    assert "changed after review" in result["error"]
    assert original.drafts("asset_bundles/bundle-000000", "", 20)["items"]


def test_snapshot_corruption_and_linked_backup_storage(api, tmp_path, monkeypatch):
    from pathlib import Path

    from cairndex.core.config import get_settings
    from cairndex.registry.models import RegisteredLibrary
    from cairndex.replicas.recovery_tasks import backup_directory

    client, base, store = api
    runner = worker(client)
    snapshot = run(client, base, runner, "backup")
    with runner.factory() as session:
        root = Path(session.get(RegisteredLibrary, base.split("/")[-1]).root_path)
    database = backup_directory(root, snapshot["id"]) / "replica.db"
    with database.open("ab") as stream:
        stream.write(b"synthetic damage")
    assert run(client, base, runner, "verify", backup=snapshot["id"])["state"] == "failed"
    linked = tmp_path / "linked"
    linked.symlink_to(root, target_is_directory=True)
    monkeypatch.setattr(get_settings(), "private_backup_dir", linked)
    result = run(client, base, runner, "backup")
    assert result["state"] == "failed"
    assert not (root / result["id"]).exists()


def test_corrupt_private_guard_blocks_an_existing_grant(api):
    from pathlib import Path

    from cairndex.auth import private_auth
    from cairndex.registry.models import RegisteredLibrary

    client, base, _ = api
    runner = worker(client)
    assert (
        client.put(base + "/auth/settings", json={"passphrase": "Synthetic guard"}).status_code
        == 200
    )
    with runner.factory() as session:
        root = Path(session.get(RegisteredLibrary, base.split("/")[-1]).root_path)
    private_auth.path_for(root).write_bytes(b"invalid")
    assert client.get(base + "/replica/status").status_code == 401
    assert (
        client.post(base + "/auth/unlock", json={"passphrase": "Synthetic guard"}).status_code
        == 401
    )


def test_recovery_reference_cannot_cross_libraries(api, tmp_path):
    client, base, _ = api
    runner = worker(client)
    snapshot = run(client, base, runner, "backup")
    root = tmp_path / "other"
    root.mkdir()
    response = client.post(
        "/api/v1/libraries/create", json={"root_path": str(root), "display_name": "Other"}
    )
    assert response.status_code == 201
    other = "/api/v1/libraries/" + response.json()["id"] + "/private-recovery/tasks"
    assert client.get(other + "/" + snapshot["id"]).status_code == 409
    assert (
        client.post(
            other, json={"operation": uuid4().hex, "action": "verify", "backup": snapshot["id"]}
        ).status_code
        == 409
    )


def test_active_recovery_uniqueness_is_enforced_in_storage(api):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from cairndex.registry.models import RecoveryTask

    client, base, _ = api
    runner = worker(client)
    identity = uuid4().hex
    response = client.post(
        base + "/private-recovery/tasks", json={"operation": identity, "action": "backup"}
    )
    assert response.status_code == 202
    with runner.factory() as session:
        first = session.get(RecoveryTask, identity)
        session.add(
            RecoveryTask(
                id=uuid4().hex,
                library_id=first.library_id,
                action="backup",
                state="queued",
                body=first.body,
                descriptor=first.descriptor,
            )
        )
        with pytest.raises(IntegrityError):
            session.commit()


def test_preparation_refuses_released_flag_while_store_is_active(api):
    from cairndex.registry.models import RegisteredLibrary

    client, base, _ = api
    runner = worker(client)
    assert client.get(base + "/replica/status").status_code == 200
    with runner.factory.begin() as session:
        library = session.get(RegisteredLibrary, base.split("/")[-1])
        library.serving_released = True
    result = run(client, base, runner, "prepare")
    assert result["state"] == "failed"
    assert "finish Release" in result["error"]
    assert client.post(base + "/ownership/release").status_code == 200
    assert run(client, base, runner, "prepare")["state"] == "succeeded"


def test_local_clear_revokes_paired_access(api):
    from pathlib import Path

    from cairndex.auth import clear_passphrase
    from cairndex.registry import device_tokens
    from cairndex.registry.models import RegisteredLibrary

    client, base, _ = api
    runner = worker(client)
    assert client.put(base + "/auth/settings", json={"passphrase": "Synthetic"}).status_code == 200
    with runner.factory.begin() as session:
        library = session.get(RegisteredLibrary, base.split("/")[-1])
        token = device_tokens.issue_device_token(session, name="Fixture", library_ids=[library.id])
    with runner.factory.begin() as session:
        assert clear_passphrase(Path(library.root_path), registry=session) == 1
    assert client.get(base + "/auth/status").json()["protected"] is False
    assert (
        client.get(
            base + "/replica/status", headers={"Authorization": "Bearer " + token}
        ).status_code
        == 401
    )


def test_stop_does_not_cancel_a_task_claimed_after_the_read(api):
    import pytest
    from sqlalchemy import update

    from cairndex.api.v1.private_recovery import stop
    from cairndex.registry.models import RecoveryTask, RegisteredLibrary
    from cairndex.replicas.protocol import ReplicaError

    client, base, _ = api
    runner = worker(client)
    identity = uuid4().hex
    assert (
        client.post(
            base + "/private-recovery/tasks", json={"operation": identity, "action": "backup"}
        ).status_code
        == 202
    )
    with runner.factory() as stale_session:
        stale = stale_session.get(RecoveryTask, identity)
        library = stale_session.get(RegisteredLibrary, base.split("/")[-1])
        stale_session.commit()
        with runner.factory.begin() as current:
            current.execute(
                update(RecoveryTask).where(RecoveryTask.id == identity).values(state="running")
            )
        assert stale.state == "queued"
        with pytest.raises(ReplicaError, match="operation is running"):
            stop(identity, library, stale_session)
        assert stale.state == "running"
