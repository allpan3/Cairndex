"""Per-library engine + routing isolation tests (ADR-0008, phase 3/4 slice)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cairndex.registry import library_package as pkg


@pytest.fixture
def client(isolated_client: TestClient) -> TestClient:
    """Use real per-library resolution (not the shared-session client) so these
    isolation tests open each library's own DB."""
    return isolated_client


def _create_library(client: TestClient, root: Path, name: str) -> str:
    root.mkdir()
    resp = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": name},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_collection_isolated_between_libraries(client: TestClient, tmp_path: Path) -> None:
    lib_a = _create_library(client, tmp_path / "A", "A")
    lib_b = _create_library(client, tmp_path / "B", "B")

    created = client.post(
        f"/api/v1/libraries/{lib_a}/collections",
        json={"name": "Holidays"},
    )
    assert created.status_code == 201, created.text

    # Library A sees it.
    in_a = client.get(f"/api/v1/libraries/{lib_a}/collections").json()["items"]
    assert [c["name"] for c in in_a] == ["Holidays"]

    # Library B does not — separate library.db (ADR-0008).
    in_b = client.get(f"/api/v1/libraries/{lib_b}/collections").json()["items"]
    assert in_b == []


def test_library_routes_hit_separate_db_files(client: TestClient, tmp_path: Path) -> None:
    lib_a = _create_library(client, tmp_path / "A", "A")
    lib_b = _create_library(client, tmp_path / "B", "B")

    client.post(f"/api/v1/libraries/{lib_a}/collections", json={"name": "OnlyA"})
    client.post(f"/api/v1/libraries/{lib_b}/collections", json={"name": "OnlyB"})

    # The names live in each library's own library.db, read directly off disk.
    from sqlalchemy import create_engine, text

    for root_name, expected in (("A", "OnlyA"), ("B", "OnlyB")):
        db = pkg.db_path(tmp_path / root_name)
        eng = create_engine(f"sqlite:///{db.as_posix()}")
        try:
            with eng.connect() as conn:
                names = [r[0] for r in conn.execute(text("SELECT name FROM collections"))]
        finally:
            eng.dispose()
        assert names == [expected]


def test_get_collection_scoped_to_its_library(client: TestClient, tmp_path: Path) -> None:
    lib_a = _create_library(client, tmp_path / "A", "A")
    lib_b = _create_library(client, tmp_path / "B", "B")

    coll_id = client.post(f"/api/v1/libraries/{lib_a}/collections", json={"name": "X"}).json()["id"]

    # Fetchable in its own library, 404 in the other.
    assert client.get(f"/api/v1/libraries/{lib_a}/collections/{coll_id}").status_code == 200
    assert client.get(f"/api/v1/libraries/{lib_b}/collections/{coll_id}").status_code == 404


def test_unknown_library_404(client: TestClient) -> None:
    resp = client.get("/api/v1/libraries/01JZZZZZZZZZZZZZZZZZZZZZZZ/collections")
    assert resp.status_code == 404


def test_unavailable_library_404(client: TestClient, tmp_path: Path) -> None:
    root = tmp_path / "A"
    lib = _create_library(client, root, "A")
    pkg.db_path(root).unlink()  # library.db missing -> unavailable

    resp = client.get(f"/api/v1/libraries/{lib}/collections")
    assert resp.status_code == 404
    assert "unavailable" in resp.json()["message"]


def test_collection_persists_across_requests(client: TestClient, tmp_path: Path) -> None:
    """A second request re-opens the same cached engine and sees prior writes."""
    lib = _create_library(client, tmp_path / "A", "A")
    client.post(f"/api/v1/libraries/{lib}/collections", json={"name": "Persisted"})
    items = client.get(f"/api/v1/libraries/{lib}/collections").json()["items"]
    assert [c["name"] for c in items] == ["Persisted"]
