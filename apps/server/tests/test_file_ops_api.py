"""The file-operation endpoints end to end, through the write-mode gate.

The service-level behaviour lives in ``test_file_ops.py``; this file is about
the HTTP contract — that the gate is on every write route, that a collision
reaches the client as something it can act on, and that the history stays
readable after write mode is turned back off.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.file_ops import gate


@pytest.fixture
def writable(registry_session: Session, library_id: str) -> str:
    """The test library, with write mode turned on."""
    gate.set_write_mode(registry_session, library_id, enabled=True)
    registry_session.commit()
    return library_id


def _rename(client: TestClient, library_id: str, **payload: object) -> object:
    return client.post(f"/api/v1/libraries/{library_id}/file-ops/rename", json=payload)


def test_write_routes_are_gated(client: TestClient, library_id: str, library_root: Path) -> None:
    (library_root / "a.mkv").write_bytes(b"x")

    refused = _rename(client, library_id, path="a.mkv", new_name="b.mkv")

    assert refused.status_code == 403
    assert refused.json()["code"] == "write_mode_disabled"
    assert (library_root / "a.mkv").is_file()

    created = client.post(f"/api/v1/libraries/{library_id}/file-ops/mkdir", json={"path": "Folder"})
    assert created.status_code == 403
    assert not (library_root / "Folder").exists()


def test_rename_and_undo_round_trip(client: TestClient, writable: str, library_root: Path) -> None:
    (library_root / "a.mkv").write_bytes(b"x")

    renamed = _rename(client, writable, path="a.mkv", new_name="b.mkv")

    assert renamed.status_code == 200, renamed.text
    body = renamed.json()
    assert body["path"] == "b.mkv"
    assert body["skipped"] is False
    assert body["operation"]["status"] == "done"
    assert (library_root / "b.mkv").is_file()

    undone = client.post(f"/api/v1/libraries/{writable}/file-ops/{body['operation']['id']}/undo")

    assert undone.status_code == 200
    assert undone.json()["path"] == "a.mkv"
    assert (library_root / "a.mkv").is_file()


def test_mkdir_creates_and_reports_the_new_folder(
    client: TestClient, writable: str, library_root: Path
) -> None:
    created = client.post(
        f"/api/v1/libraries/{writable}/file-ops/mkdir", json={"path": "New Folder"}
    )

    assert created.status_code == 201, created.text
    assert created.json()["path"] == "New Folder"
    assert (library_root / "New Folder").is_dir()


def test_a_collision_reaches_the_client_as_a_choice(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "a.mkv").write_bytes(b"first")
    (library_root / "b.mkv").write_bytes(b"second")

    refused = _rename(client, writable, path="a.mkv", new_name="b.mkv")

    assert refused.status_code == 409
    # Enough for the dialog to name the thing in the way, and to re-issue.
    assert refused.json()["details"]["code"] == "path_conflict"
    assert refused.json()["details"]["name"] == "b.mkv"

    kept_both = _rename(client, writable, path="a.mkv", new_name="b.mkv", on_conflict="suffix")

    assert kept_both.status_code == 200
    assert kept_both.json()["path"] == "b (2).mkv"
    assert (library_root / "b (2).mkv").read_bytes() == b"first"
    assert (library_root / "b.mkv").read_bytes() == b"second"


@pytest.mark.parametrize(
    "payload",
    [
        {"path": "/etc/passwd", "new_name": "x"},
        {"path": "../escape.mkv", "new_name": "x"},
        {"path": ".cairndex/manifest.json", "new_name": "x.json"},
        {"path": "a.mkv", "new_name": "../x"},
        {"path": "a.mkv", "new_name": ".hidden"},
    ],
)
def test_unsafe_requests_are_rejected(
    client: TestClient, writable: str, library_root: Path, payload: dict[str, str]
) -> None:
    (library_root / "a.mkv").write_bytes(b"x")

    refused = _rename(client, writable, **payload)

    assert refused.status_code == 422
    assert (library_root / ".cairndex" / "manifest.json").is_file()


def test_history_survives_write_mode_being_turned_off(
    client: TestClient, registry_session: Session, writable: str, library_root: Path
) -> None:
    """Turning the capability off must not hide what it did while it was on."""
    (library_root / "a.mkv").write_bytes(b"x")
    _rename(client, writable, path="a.mkv", new_name="b.mkv")
    gate.set_write_mode(registry_session, writable, enabled=False)
    registry_session.commit()

    history = client.get(f"/api/v1/libraries/{writable}/file-ops")

    assert history.status_code == 200
    entries = history.json()["operations"]
    assert [entry["op"] for entry in entries] == ["rename"]
    assert entries[0]["payload"] == {"source": "a.mkv", "destination": "b.mkv", "files_updated": 0}
    # …but nothing new can be done.
    assert _rename(client, writable, path="b.mkv", new_name="c.mkv").status_code == 403


def test_history_pages_newest_first(client: TestClient, writable: str, library_root: Path) -> None:
    for index in range(3):
        client.post(
            f"/api/v1/libraries/{writable}/file-ops/mkdir", json={"path": f"folder-{index}"}
        )

    first = client.get(f"/api/v1/libraries/{writable}/file-ops?limit=2").json()

    assert [entry["payload"]["destination"] for entry in first["operations"]] == [
        "folder-2",
        "folder-1",
    ]
    assert first["next_cursor"] is not None

    second = client.get(
        f"/api/v1/libraries/{writable}/file-ops?limit=2&before={first['next_cursor']}"
    ).json()

    assert [entry["payload"]["destination"] for entry in second["operations"]] == ["folder-0"]
    assert second["next_cursor"] is None
