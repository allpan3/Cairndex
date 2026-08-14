"""Tests for the library registry API and package handling (ADR-0008)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect

from cairndex.ownership import get_lease_manager, read_lease
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


# --- probe-path ---------------------------------------------------------------
# Drives the unified add-library step: one path in, one classification out, so
# the client can confirm the right action instead of guessing between create and
# register.


def _probe(client: TestClient, path: Path | str) -> dict[str, object]:
    resp = client.get("/api/v1/libraries/probe-path", params={"path": str(path)})
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


def test_probe_reports_a_plain_folder_with_its_basename(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path, "Holiday Videos")

    body = _probe(client, root)

    assert body == {
        "exists": True,
        "is_library": False,
        "already_registered_id": None,
        "manifest_display_name": None,
        # The name field prefills from this, so a plain folder becomes a library
        # named after itself without the owner typing anything.
        "folder_name": "Holiday Videos",
    }


def test_probe_reports_a_missing_folder_as_creatable(client: TestClient, tmp_path: Path) -> None:
    body = _probe(client, tmp_path / "not-there-yet")

    assert body["exists"] is False
    assert body["is_library"] is False
    assert body["folder_name"] == "not-there-yet"


def test_probe_reports_an_unregistered_library_with_its_own_name(
    client: TestClient, tmp_path: Path
) -> None:
    root = _make_root(tmp_path, "Images")
    pkg.create_package(root, "Family Photos")  # a library on disk, not registered here

    body = _probe(client, root)

    assert body["is_library"] is True
    assert body["already_registered_id"] is None
    # Registering adopts the name the library travels with, not the folder name.
    assert body["manifest_display_name"] == "Family Photos"


def test_probe_reports_an_already_registered_library(client: TestClient, tmp_path: Path) -> None:
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()

    body = _probe(client, root)

    assert body["already_registered_id"] == created["id"]
    assert body["is_library"] is True


def test_probe_matches_a_moved_library_by_portable_uuid(client: TestClient, tmp_path: Path) -> None:
    # A moved library keeps its uuid, so the registry row is under the *old*
    # path. Registering it again would fail the unique-uuid constraint; the
    # useful answer is "you already have this one".
    root = _make_root(tmp_path, "Before")
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()
    moved = tmp_path / "After"
    root.rename(moved)

    body = _probe(client, moved)

    assert body["already_registered_id"] == created["id"]


def test_probe_rejects_a_relative_path(client: TestClient) -> None:
    resp = client.get("/api/v1/libraries/probe-path", params={"path": "relative/dir"})
    assert resp.status_code == 422


def test_probe_requires_a_path(client: TestClient) -> None:
    assert client.get("/api/v1/libraries/probe-path").status_code == 422


def test_probe_surfaces_a_broken_marker_rather_than_offering_to_create(
    client: TestClient, tmp_path: Path
) -> None:
    # Reporting "not a library" here would invite creating a second library over
    # a broken one. The parse error is the honest answer.
    root = _make_root(tmp_path, "Broken")
    pkg.marker_dir(root).mkdir()
    pkg.manifest_path(root).write_text("{ not json", encoding="utf-8")

    resp = client.get("/api/v1/libraries/probe-path", params={"path": str(root)})

    assert resp.status_code == 422


# --- deregistration (metadata-only) -------------------------------------------


def test_delete_removes_the_row_and_leaves_the_library_on_disk(
    client: TestClient, tmp_path: Path
) -> None:
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()
    (root / "movie.mp4").write_bytes(b"media")

    resp = client.delete(f"/api/v1/libraries/{created['id']}")

    assert resp.status_code == 204
    assert client.get("/api/v1/libraries").json() == []
    assert client.get(f"/api/v1/libraries/{created['id']}").status_code == 404
    # Nothing on disk was touched: the package and the media are still there.
    assert pkg.manifest_path(root).is_file()
    assert pkg.db_path(root).is_file()
    assert (root / "movie.mp4").read_bytes() == b"media"
    for sub in pkg.CACHE_SUBDIRS:
        assert (pkg.cache_dir(root) / sub).is_dir()


def test_delete_then_re_register_restores_the_same_library(
    client: TestClient, tmp_path: Path
) -> None:
    """The point of metadata-only removal: adding the folder back gets it all.

    Nothing authoritative lives in the registry (ADR-0018 §1), so the portable
    identity and name survive a removal untouched.
    """
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()

    assert client.delete(f"/api/v1/libraries/{created['id']}").status_code == 204
    again = client.post("/api/v1/libraries/register", json={"root_path": str(root)})

    assert again.status_code == 201, again.text
    assert again.json()["library_uuid"] == created["library_uuid"]
    assert again.json()["name"] == "Movies"


def test_delete_releases_the_ownership_lease(client: TestClient, tmp_path: Path) -> None:
    # ADR-0018 §3 lists unregistration alongside clean shutdown as a release
    # trigger: a server that no longer serves a library must not keep holding
    # it, or the next machine to open the folder meets a takeover prompt for a
    # library nobody is serving.
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()
    manager = get_lease_manager()
    manager.acquire(library_id=created["id"], root=root)
    assert manager.holds(created["id"], root)

    assert client.delete(f"/api/v1/libraries/{created['id']}").status_code == 204

    assert not manager.holds(created["id"], root)
    record = read_lease(root).record
    assert record is not None and record.released_at is not None


def test_delete_takes_the_librarys_plans_database_with_it(
    client: TestClient, tmp_path: Path
) -> None:
    """ADR-0022 put grouping plans in *this server's* data directory.

    Deregistration is metadata-only about the *library* — the folder and every
    byte in it are left alone. The plans file is not in the library, though: it is
    server-runtime state next to the registry, like the ownership lease, and
    nothing else would ever remove it. A forgotten library would leak it forever.
    """
    from cairndex.persistence.engine import plans_database_path

    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()
    # Opening the library is what creates the file, so read something from it.
    assert client.get(f"/api/v1/libraries/{created['id']}/grouping/plans").status_code == 200
    plans_file = plans_database_path(pkg.db_path(root))
    assert plans_file.is_file()

    assert client.delete(f"/api/v1/libraries/{created['id']}").status_code == 204

    assert not plans_file.exists()
    # ...and the library itself is untouched, which is the rule that still holds.
    assert pkg.db_path(root).is_file()


def test_delete_unknown_library_404(client: TestClient) -> None:
    assert client.delete("/api/v1/libraries/01JZZZZZZZZZZZZZZZZZZZZZZZ").status_code == 404


# --- path suggestions ---------------------------------------------------------


def test_suggestions_mark_directories_that_are_libraries(
    client: TestClient, tmp_path: Path
) -> None:
    base = tmp_path / "media"
    base.mkdir()
    plain = base / "aaa-plain"
    plain.mkdir()
    library = base / "bbb-library"
    library.mkdir()
    pkg.create_package(library, "Marked")
    (base / "ccc-file.txt").write_text("not a directory", encoding="utf-8")

    resp = client.get("/api/v1/libraries/path-suggestions", params={"path": f"{base}/"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["suggestions"] == [
        {"path": plain.as_posix(), "is_library": False},
        {"path": library.as_posix(), "is_library": True},
    ]


def test_suggestions_filter_by_the_typed_partial_name(client: TestClient, tmp_path: Path) -> None:
    base = tmp_path / "media"
    base.mkdir()
    (base / "Movies").mkdir()
    (base / "Music").mkdir()
    (base / "Photos").mkdir()

    resp = client.get("/api/v1/libraries/path-suggestions", params={"path": f"{base}/mo"})

    assert [item["path"] for item in resp.json()["suggestions"]] == [(base / "Movies").as_posix()]


def test_suggestions_for_an_unreadable_base_are_empty(client: TestClient, tmp_path: Path) -> None:
    resp = client.get("/api/v1/libraries/path-suggestions", params={"path": f"{tmp_path}/nowhere/"})
    assert resp.json()["suggestions"] == []


def test_suggestions_reject_a_null_byte(client: TestClient) -> None:
    resp = client.get("/api/v1/libraries/path-suggestions", params={"path": "/tmp/\x00"})
    assert resp.status_code == 422


def test_manifest_display_name_survives_deregistration(client: TestClient, tmp_path: Path) -> None:
    """Deregistration writes nothing into the package, not even a marker."""
    root = _make_root(tmp_path)
    created = client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Movies"},
    ).json()
    before = json.loads(pkg.manifest_path(root).read_text(encoding="utf-8"))

    client.delete(f"/api/v1/libraries/{created['id']}")

    assert json.loads(pkg.manifest_path(root).read_text(encoding="utf-8")) == before
