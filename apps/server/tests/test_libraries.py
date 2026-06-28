"""Tests for the library registry API and package handling (ADR-0008)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect

from cairndex.registry import library_package as pkg


def _make_root(tmp_path: Path, name: str = "Movies") -> Path:
    root = tmp_path / name
    root.mkdir()
    return root


def test_create_library_builds_package_and_registers(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path)
    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Movies"
    assert body["status"] == "available"
    assert len(body["library_uuid"]) == 26

    # On-disk package was created.
    assert pkg.manifest_path(root).is_file()
    assert pkg.db_path(root).is_file()
    for sub in pkg.CACHE_SUBDIRS:
        assert (pkg.cache_dir(root) / sub).is_dir()

    # The library.db carries the content schema (e.g. asset_bundles).
    eng = create_engine(f"sqlite:///{pkg.db_path(root).as_posix()}")
    try:
        assert "asset_bundles" in inspect(eng).get_table_names()
    finally:
        eng.dispose()


def test_create_library_listed_and_fetchable(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()

    listed = client.get("/api/v1/libraries")
    assert listed.status_code == 200
    assert [lib["id"] for lib in listed.json()] == [created["id"]]

    fetched = client.get(f"/api/v1/libraries/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == created["id"]


def test_create_missing_root_requires_create_if_missing(client: TestClient, tmp_path: Path) -> None:
    missing = tmp_path / "not-there"
    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(missing), "display_name": "X"},
    )
    assert resp.status_code == 422

    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(missing), "display_name": "X", "create_if_missing": True},
    )
    assert resp.status_code == 201
    assert missing.is_dir()


def test_create_rejects_relative_path(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": "relative/dir", "display_name": "X"},
    )
    assert resp.status_code == 422


def test_create_on_existing_library_conflicts(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path)
    first = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    )
    assert first.status_code == 201
    second = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Again"},
    )
    assert second.status_code == 409


def test_register_existing_library(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path, "Images")
    manifest = pkg.create_package(root, "Images")  # build a package without registering

    resp = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert resp.status_code == 201, resp.text
    assert resp.json()["library_uuid"] == manifest.library_uuid


def test_register_rejects_missing_marker(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path, "Plain")
    resp = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert resp.status_code == 422
    assert "not a Cairndex library" in resp.json()["message"]


def test_register_rejects_invalid_manifest(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path, "Broken")
    pkg.marker_dir(root).mkdir()
    pkg.manifest_path(root).write_text("{ not json", encoding="utf-8")
    resp = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert resp.status_code == 422


def test_get_reflects_unavailable_when_db_missing(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()

    pkg.db_path(root).unlink()  # simulate an offline/moved library
    fetched = client.get(f"/api/v1/libraries/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "unavailable"


def test_get_unknown_library_404(client: TestClient) -> None:
    assert client.get("/api/v1/libraries/01JZZZZZZZZZZZZZZZZZZZZZZZ").status_code == 404


def test_registry_is_separate_database(client: TestClient, tmp_path: Path) -> None:
    """Creating a library writes to registry.db, not the content DB."""
    root = _make_root(tmp_path)
    client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    )
    # The content DB has no registry tables (kept fully separate, ADR-0008).
    from cairndex.persistence.base import Base

    assert "registered_libraries" not in Base.metadata.tables


@pytest.mark.parametrize("display_name", ["", "   "])
def test_create_rejects_blank_name(client: TestClient, tmp_path: Path, display_name: str) -> None:
    root = _make_root(tmp_path)
    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": display_name},
    )
    assert resp.status_code == 422
