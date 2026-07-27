"""The file-operation endpoints end to end, through the write-mode gate.

The service-level behaviour lives in ``test_file_ops.py``; this file is about
the HTTP contract — that the gate is on every write route, that a collision
reaches the client as something it can act on, and that the history stays
readable after write mode is turned back off.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, GroupingState, MediaKind
from cairndex.file_ops import gate
from cairndex.persistence.models import AssetBundle, AssetFile


@pytest.fixture
def writable(registry_session: Session, library_id: str) -> str:
    """The test library, with write mode turned on."""
    gate.set_write_mode(registry_session, library_id, enabled=True)
    registry_session.commit()
    return library_id


def _rename(client: TestClient, library_id: str, **payload: object) -> Response:
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


# --- trash (ADR-0013 §3.2) ---------------------------------------------------
def _trash(client: TestClient, library_id: str, *paths: str) -> Response:
    return client.post(
        f"/api/v1/libraries/{library_id}/file-ops/trash", json={"paths": list(paths)}
    )


def test_delete_moves_to_the_trash_and_restores(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "a.mkv").write_bytes(b"payload")

    deleted = _trash(client, writable, "a.mkv")

    assert deleted.status_code == 200, deleted.text
    assert not (library_root / "a.mkv").exists()

    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    assert [entry["name"] for op in listing["operations"] for entry in op["entries"]] == ["a.mkv"]
    assert listing["size_bytes"] == len(b"payload")

    operation_id = listing["operations"][0]["operation_id"]
    restored = client.post(f"/api/v1/libraries/{writable}/file-ops/trash/restore/{operation_id}")

    assert restored.status_code == 200
    assert (library_root / "a.mkv").read_bytes() == b"payload"
    assert client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()["operations"] == []


def test_trash_routes_are_gated_but_reading_the_trash_is_not(
    client: TestClient, registry_session: Session, writable: str, library_root: Path
) -> None:
    (library_root / "a.mkv").write_bytes(b"x")
    _trash(client, writable, "a.mkv")
    gate.set_write_mode(registry_session, writable, enabled=False)
    registry_session.commit()

    # Still visible: files in the trash are not gone, and saying otherwise
    # because a switch was flipped would be a lie about the library's contents.
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash")
    assert listing.status_code == 200
    assert len(listing.json()["operations"]) == 1

    operation_id = listing.json()["operations"][0]["operation_id"]
    assert _trash(client, writable, "b.mkv").status_code == 403
    assert (
        client.post(
            f"/api/v1/libraries/{writable}/file-ops/trash/restore/{operation_id}"
        ).status_code
        == 403
    )
    assert (
        client.post(f"/api/v1/libraries/{writable}/file-ops/trash/empty", json={}).status_code
        == 403
    )


def test_empty_trash_reports_what_it_removed(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "a.mkv").write_bytes(b"x")
    (library_root / "b.mkv").write_bytes(b"y")
    _trash(client, writable, "a.mkv")
    _trash(client, writable, "b.mkv")

    emptied = client.post(f"/api/v1/libraries/{writable}/file-ops/trash/empty", json={})

    assert emptied.status_code == 200
    assert emptied.json() == {"operations_emptied": 2}
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    assert listing == {"operations": [], "size_bytes": 0}


def test_replace_is_offered_as_a_collision_policy(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "new.mkv").write_bytes(b"better")
    (library_root / "old.mkv").write_bytes(b"original")

    replaced = _rename(client, writable, path="new.mkv", new_name="old.mkv", on_conflict="replace")

    assert replaced.status_code == 200, replaced.text
    assert (library_root / "old.mkv").read_bytes() == b"better"
    # Recoverable: the displaced file is in the trash, filed under this operation.
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    assert [entry["original_path"] for op in listing["operations"] for entry in op["entries"]] == [
        "old.mkv"
    ]


# --- import (ADR-0013 §7, plan 4 W5) -----------------------------------------
def _import(
    client: TestClient, library_id: str, body: bytes, filename: str, **params: object
) -> Response:
    query = {"filename": filename, **params}
    return client.post(
        f"/api/v1/libraries/{library_id}/file-ops/import",
        params=query,
        content=body,
        headers={"Content-Type": "application/octet-stream"},
    )


def test_import_writes_the_body_into_the_library(
    client: TestClient, writable: str, library_root: Path
) -> None:
    imported = _import(client, writable, b"movie bytes", "clip.mkv")

    assert imported.status_code == 201, imported.text
    body = imported.json()
    assert body["path"] == "clip.mkv"
    assert body["size_bytes"] == len(b"movie bytes")
    assert (library_root / "clip.mkv").read_bytes() == b"movie bytes"
    # Nothing left behind in staging.
    assert list((library_root / ".cairndex" / "tmp").iterdir()) == []


def test_import_targets_a_subfolder(client: TestClient, writable: str, library_root: Path) -> None:
    (library_root / "Show").mkdir()

    imported = _import(client, writable, b"x", "ep1.mkv", dest_dir="Show")

    assert imported.json()["path"] == "Show/ep1.mkv"
    assert (library_root / "Show/ep1.mkv").is_file()


def test_import_is_gated(client: TestClient, library_id: str, library_root: Path) -> None:
    refused = _import(client, library_id, b"x", "clip.mkv")

    assert refused.status_code == 403
    assert refused.json()["code"] == "write_mode_disabled"
    assert not (library_root / "clip.mkv").exists()


@pytest.mark.parametrize(
    "params",
    [
        {"filename": "../escape.mkv"},
        {"filename": ".hidden"},
        {"filename": "sub/nested.mkv"},
        {"filename": "ok.mkv", "dest_dir": ".cairndex"},
        {"filename": "ok.mkv", "dest_dir": "../outside"},
    ],
)
def test_import_rejects_unsafe_destinations(
    client: TestClient, writable: str, library_root: Path, params: dict[str, str]
) -> None:
    filename = params.pop("filename")

    refused = _import(client, writable, b"x", filename, **params)

    assert refused.status_code == 422
    assert (library_root / ".cairndex" / "manifest.json").is_file()


def test_import_collision_asks_before_reading_the_body(
    client: TestClient, writable: str, library_root: Path
) -> None:
    """The check is up front so a 60 GB upload is not spent discovering the
    name was taken."""
    (library_root / "clip.mkv").write_bytes(b"original")

    refused = _import(client, writable, b"new bytes", "clip.mkv")

    assert refused.status_code == 409
    assert refused.json()["details"]["code"] == "path_conflict"
    assert (library_root / "clip.mkv").read_bytes() == b"original"

    kept_both = _import(client, writable, b"new bytes", "clip.mkv", on_conflict="suffix")
    assert kept_both.json()["path"] == "clip (2).mkv"
    assert (library_root / "clip (2).mkv").read_bytes() == b"new bytes"


def test_import_replace_trashes_the_file_it_displaces(
    client: TestClient, writable: str, library_root: Path
) -> None:
    """The reason W4 moved ahead of W5: import can offer a real Replace."""
    (library_root / "clip.mkv").write_bytes(b"original")

    replaced = _import(client, writable, b"better", "clip.mkv", on_conflict="replace")

    assert replaced.status_code == 201
    assert (library_root / "clip.mkv").read_bytes() == b"better"
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    assert [e["original_path"] for op in listing["operations"] for e in op["entries"]] == [
        "clip.mkv"
    ]


def test_import_skip_leaves_the_existing_file_alone(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "clip.mkv").write_bytes(b"original")

    skipped = _import(client, writable, b"new", "clip.mkv", on_conflict="skip")

    assert skipped.json()["skipped"] is True
    assert (library_root / "clip.mkv").read_bytes() == b"original"


def test_import_can_link_what_it_added(
    client: TestClient, writable: str, library_root: Path
) -> None:
    imported = _import(client, writable, b"movie", "clip.mkv", link=True)

    assert imported.json()["files_updated"] == 1
    listed = client.get(f"/api/v1/libraries/{writable}/file-browser/entries").json()
    entry = next(e for e in listed["entries"] if e["name"] == "clip.mkv")
    assert entry["linked"] is True


def test_undoing_an_import_deletes_it_to_the_trash(
    client: TestClient, writable: str, library_root: Path
) -> None:
    """Undo must never be the one action in the app that destroys something."""
    imported = _import(client, writable, b"movie", "clip.mkv").json()

    undone = client.post(
        f"/api/v1/libraries/{writable}/file-ops/{imported['operation']['id']}/undo"
    )

    assert undone.status_code == 200
    assert not (library_root / "clip.mkv").exists()
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    assert [e["original_path"] for op in listing["operations"] for e in op["entries"]] == [
        "clip.mkv"
    ]


def test_an_empty_upload_is_refused_and_leaves_nothing(
    client: TestClient, writable: str, library_root: Path
) -> None:
    refused = _import(client, writable, b"", "clip.mkv")

    assert refused.status_code == 422
    assert not (library_root / "clip.mkv").exists()
    assert list((library_root / ".cairndex" / "tmp").iterdir()) == []
    # The attempt is recorded as failed rather than vanishing.
    history = client.get(f"/api/v1/libraries/{writable}/file-ops").json()["operations"]
    assert history[0]["op"] == "import"
    assert history[0]["status"] == "failed"


def _move(client: TestClient, library_id: str, **payload: object) -> Response:
    return client.post(f"/api/v1/libraries/{library_id}/file-ops/move", json=payload)


def test_move_is_gated(client: TestClient, library_id: str, library_root: Path) -> None:
    (library_root / "a.mkv").write_bytes(b"x")
    (library_root / "Dest").mkdir()

    refused = _move(client, library_id, paths=["a.mkv"], dest_dir="Dest")

    assert refused.status_code == 403
    assert refused.json()["code"] == "write_mode_disabled"
    assert (library_root / "a.mkv").is_file()


def test_move_and_undo_round_trip(client: TestClient, writable: str, library_root: Path) -> None:
    (library_root / "Inbox").mkdir()
    (library_root / "Inbox/a.mkv").write_bytes(b"x")
    (library_root / "Dest").mkdir()

    moved = _move(client, writable, paths=["Inbox/a.mkv"], dest_dir="Dest")

    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["path"] == "Dest/a.mkv"
    assert (library_root / "Dest/a.mkv").is_file()

    undone = client.post(f"/api/v1/libraries/{writable}/file-ops/{body['operation']['id']}/undo")

    assert undone.status_code == 200
    assert (library_root / "Inbox/a.mkv").is_file()
    assert not (library_root / "Dest/a.mkv").exists()


def test_move_collision_reaches_the_client_as_a_choice(
    client: TestClient, writable: str, library_root: Path
) -> None:
    (library_root / "Inbox").mkdir()
    (library_root / "Inbox/a.mkv").write_bytes(b"incoming")
    (library_root / "Dest").mkdir()
    (library_root / "Dest/a.mkv").write_bytes(b"already here")

    refused = _move(client, writable, paths=["Inbox/a.mkv"], dest_dir="Dest")

    assert refused.status_code == 409
    assert refused.json()["details"]["code"] == "path_conflict"

    kept_both = _move(
        client, writable, paths=["Inbox/a.mkv"], dest_dir="Dest", on_conflict="suffix"
    )

    assert kept_both.status_code == 200
    assert kept_both.json()["path"] == "Dest/a (2).mkv"
    assert (library_root / "Dest/a.mkv").read_bytes() == b"already here"
    assert (library_root / "Dest/a (2).mkv").read_bytes() == b"incoming"


# --- Deleting a bundle together with its files (plan 4 W6, closing W4) -------


def _linked_bundle(session: Session, library_root: Path, relative: str) -> str:
    """A confirmed bundle owning one real file on disk. Returns its id."""
    (library_root / relative).write_bytes(b"payload")
    bundle = AssetBundle(title="Bundle", grouping_state=GroupingState.CONFIRMED)
    session.add(bundle)
    session.flush()
    session.add(
        AssetFile(
            bundle_id=bundle.id,
            relative_path=relative,
            original_filename=relative,
            display_title=relative,
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
            sequence=0,
            size_bytes=7,
        )
    )
    session.commit()
    return bundle.id


def test_delete_with_files_trashes_them_and_removes_the_bundle(
    client: TestClient, writable: str, library_root: Path, session: Session
) -> None:
    """The dialog's "also delete files" checkbox, finally wired to something.

    Trash-first like every other deletion, so it is undoable and the files stay
    visible in the Trash rather than simply being gone.
    """
    bundle_id = _linked_bundle(session, library_root, "a.mkv")

    response = client.post(f"/api/v1/libraries/{writable}/bundles/{bundle_id}/delete-with-files")

    assert response.status_code == 200, response.text
    assert not (library_root / "a.mkv").exists()
    assert client.get(f"/api/v1/libraries/{writable}/bundles/{bundle_id}").status_code == 404
    listing = client.get(f"/api/v1/libraries/{writable}/file-ops/trash").json()
    trashed = [e["original_path"] for op in listing["operations"] for e in op["entries"]]
    assert trashed == ["a.mkv"]


def test_delete_with_files_is_refused_when_write_mode_is_off(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Deleting the files is a guarded write; dissolving the grouping is not.

    That is why these are two routes and not one with a flag: a read-only library
    must keep the ordinary delete while refusing this one.
    """
    bundle_id = _linked_bundle(session, library_root, "a.mkv")

    response = client.post(f"/api/v1/libraries/{library_id}/bundles/{bundle_id}/delete-with-files")

    assert response.status_code == 403
    assert response.json()["code"] == "write_mode_disabled"
    assert (library_root / "a.mkv").is_file()
    assert client.get(f"/api/v1/libraries/{library_id}/bundles/{bundle_id}").status_code == 200


def test_deleting_an_empty_bundle_with_files_reports_no_operation(
    client: TestClient, writable: str, session: Session
) -> None:
    """Nothing to trash means nothing to undo — null, not an invented entry."""
    bundle = AssetBundle(title="Empty")
    session.add(bundle)
    session.commit()

    response = client.post(f"/api/v1/libraries/{writable}/bundles/{bundle.id}/delete-with-files")

    assert response.status_code == 200
    assert response.json() is None
    assert client.get(f"/api/v1/libraries/{writable}/bundles/{bundle.id}").status_code == 404
