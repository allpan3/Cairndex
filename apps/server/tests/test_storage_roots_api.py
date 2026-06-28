from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.persistence.models import AssetBundle, AssetFile, StorageRoot


def _create(client: TestClient, name: str, path: str = "/mnt/media") -> dict[str, object]:
    resp = client.post(
        "/api/v1/storage-roots",
        json={"name": name, "canonical_path": path},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_and_get_roundtrip(client: TestClient) -> None:
    created = _create(client, "media")
    assert created["name"] == "media"
    assert created["read_only"] is True
    assert len(created["id"]) == 26

    got = client.get(f"/api/v1/storage-roots/{created['id']}")
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


def test_create_if_missing_via_api(client: TestClient, tmp_path: Path) -> None:
    target = tmp_path / "fresh-library"
    resp = client.post(
        "/api/v1/storage-roots",
        json={"name": "fresh", "canonical_path": str(target), "create_if_missing": True},
    )
    assert resp.status_code == 201, resp.text
    assert target.is_dir()
    assert resp.json()["status"] == "available"


def test_path_suggestions_endpoint(client: TestClient, tmp_path: Path) -> None:
    (tmp_path / "Movies").mkdir()
    (tmp_path / "Music").mkdir()
    resp = client.get("/api/v1/storage-roots/path-suggestions", params={"path": f"{tmp_path}/"})
    assert resp.status_code == 200
    names = {Path(p).name for p in resp.json()["suggestions"]}
    assert {"Movies", "Music"} <= names


def test_create_rejects_relative_path(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/storage-roots",
        json={"name": "rel", "canonical_path": "not/absolute"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"


def test_duplicate_name_conflicts(client: TestClient) -> None:
    _create(client, "dup")
    resp = client.post(
        "/api/v1/storage-roots",
        json={"name": "dup", "canonical_path": "/mnt/other"},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "conflict"


def test_get_unknown_returns_404(client: TestClient) -> None:
    resp = client.get("/api/v1/storage-roots/01000000000000000000000000")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


def test_list_is_keyset_paginated(client: TestClient) -> None:
    for i in range(3):
        _create(client, f"root-{i}", path=f"/mnt/r{i}")

    first = client.get("/api/v1/storage-roots", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None

    second = client.get(
        "/api/v1/storage-roots", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None

    ids = {r["id"] for r in first["items"]} | {r["id"] for r in second["items"]}
    assert len(ids) == 3  # no overlap, full coverage


def test_update_and_delete(client: TestClient) -> None:
    created = _create(client, "to-edit")
    patched = client.patch(
        f"/api/v1/storage-roots/{created['id']}",
        json={"name": "renamed", "read_only": False},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "renamed"
    assert patched.json()["read_only"] is False

    deleted = client.delete(f"/api/v1/storage-roots/{created['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/storage-roots/{created['id']}").status_code == 404


def test_delete_is_refused_when_files_are_linked(client: TestClient, session: Session) -> None:
    created = _create(client, "in-use")
    # Link a file directly via the ORM (bundle/file APIs arrive in the next slice).
    bundle = AssetBundle(title="b")
    session.add(bundle)
    session.flush()
    session.add(
        AssetFile(
            bundle_id=bundle.id,
            storage_root_id=str(created["id"]),
            relative_path="movie/a.mp4",
            original_filename="a.mp4",
            display_title="a.mp4",
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
    )
    session.commit()

    resp = client.delete(f"/api/v1/storage-roots/{created['id']}")
    assert resp.status_code == 409
    assert resp.json()["code"] == "conflict"
    # The root must still exist.
    assert session.get(StorageRoot, str(created["id"])) is not None
