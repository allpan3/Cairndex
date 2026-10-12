"""Public conversion steps use exact receipts and survive a stopped worker."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from cairndex.api.deps import get_registry_db
from cairndex.domain.enums import LibraryStatus
from cairndex.main import create_app
from cairndex.registry import library_package as pkg
from cairndex.registry import services
from cairndex.registry.models import ConversionTask, RegisteredLibrary
from cairndex.replicas import conversion_tasks, service
from cairndex.replicas.catalog import legacy_conversion
from tests.test_legacy_conversion import _legacy, _tree

TASKS = "/api/v1/libraries/conversions/tasks"


@pytest.fixture
def conversion_api(tmp_path, registry_session_factory):
    root = _legacy(tmp_path)
    factory = registry_session_factory
    app = create_app()

    def registry():
        with factory() as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    app.dependency_overrides[get_registry_db] = registry
    with TestClient(app) as client:
        yield client, root, factory, conversion_tasks.ConversionWorker(factory)
    with factory() as session:
        for row in session.query(RegisteredLibrary):
            service.close(row.id)


def _step(api, action, **fields):
    client, root, _, worker = api
    operation = uuid4().hex
    response = client.post(
        TASKS, json={"operation": operation, "action": action, "root_path": str(root), **fields}
    )
    assert response.status_code == 202, response.text
    assert response.json()["state"] == "queued"
    assert worker.run_one()
    return client.get(TASKS + "/" + operation).json()


@pytest.mark.parametrize("registered", [False, True])
def test_review_activate_release_and_undo(conversion_api, registered):
    client, root, factory, _ = conversion_api
    legacy, media = _tree(root / ".cairndex"), _tree(root / "Synthetic")
    prior_id = None
    if registered:
        with factory.begin() as session:
            row = services._insert(session, manifest=pkg.read_manifest(root), root=root)
            row.write_mode_enabled = True
            prior_id = row.id
    assert client.get("/api/v1/libraries/probe-path", params={"path": str(root)}).json()[
        "needs_conversion"
    ]
    inspection = _step(conversion_api, "inspect")
    assert inspection["result"]["inspection"]["converts"]["bundles"] == 3
    review = _step(conversion_api, "prepare")
    assert review["state"] == "succeeded"
    assert _tree(root / ".cairndex") == legacy
    assert "objects" not in review["result"] and "root" not in review["result"]
    fields = {"attempt": review["id"], "receipt": review["result"]["receipt"]}
    activated = _step(conversion_api, "activate", **fields)
    assert activated["state"] == "succeeded", activated
    library = activated["result"]["library_id"]
    if registered:
        assert library == prior_id
    with factory() as session:
        row = session.get(RegisteredLibrary, library)
        assert row.serving_released and not row.write_mode_enabled
        assert row.schema_version == 3 and row.status == LibraryStatus.AVAILABLE
    base = f"/api/v1/libraries/{library}"
    assert client.post(base + "/ownership/reopen").status_code == 200
    client.get(base + "/replica/status")
    for _ in range(8):
        service.exchange(library)
    assert client.get(base + "/replica/status").json()["ready"]
    refused = _step(conversion_api, "undo", **fields)
    assert refused["state"] == "failed" and "Release" in refused["error"]
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.post(TASKS + "/" + refused["id"] + "/retry").status_code == 200
    assert conversion_api[3].run_one()
    restored = client.get(TASKS + "/" + refused["id"]).json()
    assert restored["state"] == "succeeded", restored
    assert _tree(root / ".cairndex") == legacy and _tree(root / "Synthetic") == media
    with factory() as session:
        row = session.get(RegisteredLibrary, library)
        assert row.package_format == pkg.FORMAT and row.status == LibraryStatus.UNAVAILABLE
    assert client.get(base + "/replica/status").status_code == 409


def test_operation_identity_prerequisites_and_one_step_per_root(conversion_api):
    client, root, _, worker = conversion_api
    body = {"operation": uuid4().hex, "action": "inspect", "root_path": str(root)}
    first = client.post(TASKS, json=body)
    assert first.status_code == 202
    assert client.post(TASKS, json=body).json() == first.json()
    assert client.post(TASKS, json=body | {"action": "prepare"}).status_code == 409
    assert client.post(TASKS, json=body | {"operation": uuid4().hex}).status_code == 409
    assert client.get("/api/v1/libraries/probe-path", params={"path": str(root)}).status_code == 409
    assert (
        client.post("/api/v1/libraries/register", json={"root_path": str(root)}).status_code == 409
    )
    assert worker.run_one()
    assert client.post(TASKS + "/" + body["operation"] + "/retry").status_code == 409
    assert client.post(TASKS, json=body | {"operation": "../outside"}).status_code == 422
    assert client.post(TASKS, json=body | {"action": "activate"}).status_code == 422
    activate = body | {
        "operation": uuid4().hex,
        "action": "activate",
        "attempt": uuid4().hex,
        "receipt": "0" * 64,
    }
    assert client.post(TASKS, json=activate).status_code == 409
    review = _step(conversion_api, "prepare")
    assert client.post(TASKS, json=activate | {"attempt": review["id"]}).status_code == 409
    assert client.get(TASKS + "/" + uuid4().hex).status_code == 409


@pytest.mark.parametrize("point", ["legacy_moved", "published"])
def test_activation_restart_and_missing_metadata_admission(conversion_api, monkeypatch, point):
    client, root, factory, worker = conversion_api
    review = _step(conversion_api, "prepare")
    activate = legacy_conversion.activate

    def stop(step):
        if step == point:
            raise RuntimeError("synthetic private path must not appear in the API")

    monkeypatch.setattr(
        legacy_conversion, "activate", lambda *args, **kwargs: activate(*args, **kwargs, fault=stop)
    )
    failed = _step(
        conversion_api, "activate", attempt=review["id"], receipt=review["result"]["receipt"]
    )
    assert failed["state"] == "failed"
    assert "synthetic private" not in failed["error"]
    if point == "legacy_moved":
        assert not (root / ".cairndex").exists()
        response = client.post(
            "/api/v1/libraries/create",
            json={"root_path": str(root), "display_name": "Synthetic replacement"},
        )
        assert response.status_code == 409
    monkeypatch.setattr(legacy_conversion, "activate", activate)
    with factory.begin() as session:
        session.get(ConversionTask, failed["id"]).state = "running"
    worker.recover_interrupted()
    assert worker.run_one()
    final = client.get(TASKS + "/" + failed["id"]).json()
    assert final["state"] == "succeeded", final
    assert pkg.read_manifest(root).replica is not None


def test_restart_does_not_abandon_queued_preparation(conversion_api):
    client, root, factory, worker = conversion_api
    operation = uuid4().hex
    assert (
        client.post(
            TASKS, json={"operation": operation, "action": "prepare", "root_path": str(root)}
        ).status_code
        == 202
    )
    worker.recover_interrupted()
    assert client.get(TASKS + "/" + operation).json()["state"] == "queued"
    with factory.begin() as session:
        session.get(ConversionTask, operation).state = "running"
    worker.recover_interrupted()
    assert client.get(TASKS + "/" + operation).json()["state"] == "interrupted"
    assert pkg.read_manifest(root).replica is None
