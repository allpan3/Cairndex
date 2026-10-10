"""Normal portable libraries isolate authored metadata and private SQLite."""

import json
from pathlib import Path
from uuid import uuid4

from cairndex.replicas import service
from cairndex.replicas.catalog import jobs


def create(client, root: Path):
    root.mkdir()
    response = client.post(
        "/api/v1/libraries/create", json={"root_path": str(root), "display_name": root.name}
    )
    assert response.status_code == 201, response.text
    identity = response.json()["id"]
    base = f"/api/v1/libraries/{identity}/replica/catalog"
    for _ in range(8):
        client.get(base + "/entities/collections")
        service.exchange(identity)
    return identity, base


def collection(client, identity, base, name):
    cells = client.get(base + "/creation/collections").json()["cells"]
    cells["name"] = json.dumps(name)
    store = service._handles[identity][0]
    preview = uuid4().hex
    response = client.post(
        base + "/jobs",
        json={
            "operation": preview,
            "action": "preview",
            "body": {"action": "create", "family": "collections", "cells": cells},
        },
    )
    assert response.status_code == 202, response.text
    jobs.run_one(store)
    result = client.get(base + "/jobs/" + preview).json()
    assert result["state"] == "succeeded", result
    operation = uuid4().hex
    response = client.post(
        base + "/jobs",
        json={
            "operation": operation,
            "action": "commit_preview",
            "body": {"job": preview, "receipt": result["receipt"]},
        },
    )
    assert response.status_code == 202
    jobs.run_one(store)
    assert client.get(base + "/jobs/" + operation).json()["state"] == "succeeded"
    return json.loads(cells["id"])


def test_collections_and_databases_are_library_scoped(isolated_client, tmp_path):
    client = isolated_client
    a, base_a = create(client, tmp_path / "A")
    b, base_b = create(client, tmp_path / "B")
    entity = collection(client, a, base_a, "Only A")
    collection(client, b, base_b, "Only B")
    for identity, base, name in ((a, base_a, "Only A"), (b, base_b, "Only B")):
        rows = client.get(base + "/entities/collections").json()["items"]
        assert len(rows) == 1
        assert rows[0]["fields"]["name"]["value"] == json.dumps(name)
        assert service._handles[identity][0].path.is_file()
    assert service._handles[a][0].path != service._handles[b][0].path
    assert not list((tmp_path / "A").rglob("*.db*"))
    assert not list((tmp_path / "B").rglob("*.db*"))
    assert client.get(base_a + "/entities/collections/" + entity).status_code == 200
    assert client.get(base_b + "/entities/collections/" + entity).status_code == 409


def test_unknown_library_is_refused(isolated_client):
    response = isolated_client.get("/api/v1/libraries/unknown/replica/catalog/entities/collections")
    assert response.status_code == 404


def test_missing_descriptor_is_refused(isolated_client, tmp_path):
    root = tmp_path / "A"
    _, base = create(isolated_client, root)
    (root / ".cairndex/manifest.json").unlink()
    assert isolated_client.get(base + "/entities/collections").status_code == 404
