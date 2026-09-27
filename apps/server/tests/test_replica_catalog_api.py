"""Real HTTP capability fences and durable catalog jobs use isolated synthetic packages"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from cairndex.api.deps import get_registry_db
from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.devtools.replica_fixture import create_fixture
from cairndex.main import create_app
from cairndex.registry.engine import create_registry_engine
from cairndex.replicas import service
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.store import CatalogStore


# API initialization uses actual format parsing, dependency admission and private SQLite
@pytest.fixture
def api(tmp_path):
    conversion = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    engine = create_registry_engine(f"sqlite:///{tmp_path / 'registry.db'}")
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    app = create_app()

    # Registry scope commits only the synthetic registration created by this test
    def registry():
        with factory() as session:
            yield session
            session.commit()

    app.dependency_overrides[get_registry_db] = registry
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/libraries/register", json={"root_path": str(conversion.package)}
        )
        assert response.status_code == 201
        library = response.json()["id"]
        base = f"/api/v1/libraries/{library}"
        client.get(base + "/replica/status")
        store = service._handles[library][0]
        assert isinstance(store, CatalogStore)
        for _ in range(8):
            service.exchange(library)
        yield client, base, store
    service.close(library)
    engine.dispose()


# Protocol-two packages cannot enter protocol-one mutations or ordinary source/SQL routes
def test_catalog_api_capability_fences(api, tmp_path):
    client, base, store = api
    assert client.get(base + "/replica/catalog/entities/asset_bundles").status_code == 200
    for suffix in ("/replica/bundles", "/bundles/browse"):
        assert client.get(base + suffix).status_code == 409
    assert client.put(base + "/write-mode", json={"enabled": True}).status_code == 409
    assert client.post(base + "/ownership/takeover").status_code == 409
    for directory in ("/tmp", "../outside", "C:/outside", "one/../../two"):
        assert (
            client.get(base + "/replica/catalog/files", params={"directory": directory}).status_code
            == 409
        )
    assert client.get(base + "/replica/catalog/entities/future").status_code == 422
    assert client.get(base + "/replica/catalog/jobs", params={"limit": 51}).status_code == 422
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.get(base + "/replica/catalog/jobs").status_code == 409
    assert client.post(base + "/ownership/reopen").status_code == 200
    root = tmp_path / "protocol-one"
    create_fixture(root)
    old = client.post("/api/v1/libraries/register", json={"root_path": str(root)}).json()["id"]
    try:
        assert client.get(f"/api/v1/libraries/{old}/replica/catalog/jobs").status_code == 409
    finally:
        service.close(old)


# HTTP queues bounded intent and exposes completion without importing or executing it in the handler
def test_catalog_http_job_receipts_drafts_and_missing_basis(api):
    client, base, store = api
    path = base + "/replica/catalog"
    draft = {
        "revision": 1,
        "body": {"cells": {"name": '"Synthetic creation"'}, "operation": "creation"},
    }
    assert client.put(path + "/drafts/create/tags/editor", json=draft).status_code == 204
    assert (
        client.get(path + "/drafts", params={"owner": "create/tags"}).json()["items"][0]["body"]
        == draft["body"]
    )
    assert client.delete(path + "/drafts/editor?revision=1").status_code == 204
    assert client.put(path + "/drafts/create/tags/editor", json=draft).status_code == 204
    assert client.get(path + "/drafts?owner=create/tags").json()["items"] == []
    body = {
        "operation": "preview",
        "action": "preview",
        "body": {"action": "delete", "family": "moments", "entity": "moment-one"},
    }
    response = client.post(path + "/jobs", json=body)
    assert response.status_code == 202
    assert response.json()["state"] == "queued"
    assert store.entity("moments", "moment-one")["fields"]["$alive"]["value"] == "true"
    jobs.run_one(store)
    prepared = client.get(path + "/jobs/preview").json()
    assert prepared["state"] == "succeeded"
    assert client.get(path + "/jobs").json()["items"][0]["result"] is None
    intent = {
        "changes": [{"unit": "moments/moment-one/comment", "value": '"Missing basis"'}],
        "parents": store.frontier(),
        "resolve": False,
        "recover": False,
    }
    assert (
        client.post(
            path + "/jobs", json={"operation": "invalid", "action": "save", "body": intent}
        ).status_code
        == 202
    )
    jobs.run_one(store)
    assert client.get(path + "/jobs/invalid").json()["state"] == "failed"
    assert client.post(path + "/jobs", json=body | {"body": {}}).status_code == 409
    commit = {
        "operation": "commit",
        "action": "commit_preview",
        "body": {"job": "preview", "receipt": prepared["receipt"]},
    }
    assert client.post(path + "/jobs", json=commit).status_code == 202
    jobs.run_one(store)
    assert client.get(path + "/jobs/commit").json()["state"] == "succeeded"
    assert store.entity("moments", "moment-one")["fields"]["$alive"]["value"] == "false"
