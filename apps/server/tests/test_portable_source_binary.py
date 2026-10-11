"""Qualify source and frozen HTTP workers with local or explicit disposable storage."""

import json
import os
import tempfile
from pathlib import Path

import pytest

from tests.test_replica_recovery_binary import eventually, running


def assert_absent(path):
    # A mounted stat can stay positive after direct SMB publication. An open
    # verifies absence without deleting a cached or newly arriving name.
    with pytest.raises(FileNotFoundError):
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        os.close(descriptor)


def test_source_reviews_preserve_identity_versions_and_restart(tmp_path):
    # An opt-in parent permits the same synthetic acceptance path on a mounted
    # share. Private SQLite always remains in the ordinary local tmp_path.
    parent = os.environ.get("CAIRNDEX_SOURCE_TEST_PARENT")
    root = (
        Path(tempfile.mkdtemp(prefix="cairndex-synthetic-source-", dir=parent)).resolve()
        if parent
        else tmp_path / "library"
    )
    root.mkdir(exist_ok=True)
    (root / "amber.txt").write_bytes(b"Synthetic amber")
    (root / "blue.txt").write_bytes(b"Synthetic blue")
    (root / "Folder" / "Nested" / "Empty").mkdir(parents=True)
    (root / "Folder" / "Nested" / "entry.txt").write_bytes(b"Synthetic nested bytes")
    base = tmp_path / "private"

    def wait(client, path, state):
        def read():
            response = client.get(path)
            assert response.status_code == 200, response.text
            value = response.json()
            assert value["state"] not in {"failed", "cancelled", "interrupted"}, value
            return value

        return eventually(read, lambda value: value["state"] == state, timeout=90)

    def prepare(client, path, operation, action, **kwargs):
        intent = {"operation": operation, "action": action, **kwargs}
        response = client.post(path, json=intent)
        assert response.status_code == 202, response.text
        prepared = wait(client, path + "/" + operation, "prepared")
        assert client.post(path, json=intent).json()["receipt"] == prepared["receipt"]
        assert client.post(path, json=intent | {"byte_limit": 1}).status_code == 409
        return prepared

    def apply(client, path, prepared):
        target = path + "/" + prepared["id"]
        response = client.post(target + "/accept", json={"receipt": prepared["receipt"]})
        assert response.status_code == 202, response.text
        result = wait(client, target, "succeeded")
        assert (
            client.post(target + "/accept", json={"receipt": prepared["receipt"]}).json()["state"]
            == "succeeded"
        )
        return result

    def perform(client, path, operation, action, **kwargs):
        return apply(client, path, prepare(client, path, operation, action, **kwargs))

    with running(base, tmp_path) as client:
        response = client.post(
            "/api/v1/libraries/create",
            json={"root_path": str(root), "display_name": "Synthetic source qualification"},
        )
        assert response.status_code == 201, response.text
        prefix = f"/api/v1/libraries/{response.json()['id']}"
        path = prefix + "/source-operations"
        eventually(
            lambda: client.get(prefix + "/replica/status").json(),
            lambda value: value.get("ready"),
            timeout=90,
        )
        intent = {
            "operation": "source-copy",
            "action": "copy",
            "source": "amber.txt",
            "destination": "source.txt",
        }
        assert client.post(path, json=intent).status_code == 403
        assert client.put(prefix + "/write-mode", json={"enabled": True}).status_code == 200
        source = perform(client, path, **intent)
        target = perform(
            client, path, "target-copy", "copy", source="blue.txt", destination="target.txt"
        )
        source_id, target_id = source["review"]["output_id"], target["review"]["output_id"]
        changed = perform(
            client,
            path,
            "move-replace",
            "move",
            source="source.txt",
            destination="target.txt",
            collision="replace",
        )
        assert changed["review"]["output_id"] == source_id
        assert_absent(root / "source.txt")
        assert (root / "target.txt").read_bytes() == b"Synthetic amber"
        retained = root / ".cairndex/source-operations/move-replace"
        assert (retained / "source").read_bytes() == b"Synthetic amber"
        assert (retained / "destination").read_bytes() == b"Synthetic blue"
        perform(client, path, "undo-replace", "undo", prior="move-replace")
        assert (root / "source.txt").read_bytes() == b"Synthetic amber"
        assert (root / "target.txt").read_bytes() == b"Synthetic blue"
        for identity, expected in ((source_id, "source.txt"), (target_id, "target.txt")):
            entity = client.get(prefix + "/replica/catalog/entities/asset_files/" + identity)
            assert entity.status_code == 200
            assert json.loads(entity.json()["fields"]["relative_path"]["value"]) == expected

        renamed = prepare(
            client, path, "folder-rename", "rename", source="Folder", destination="Renamed"
        )
        assert (root / "Folder/Nested/entry.txt").read_bytes() == b"Synthetic nested bytes"

    # A fresh process must retain the exact prepared review and per-server opt-in.
    with running(base, tmp_path) as client:
        assert client.get(path + "/folder-rename").json()["receipt"] == renamed["receipt"]
        apply(client, path, renamed)
        assert_absent(root / "Folder")
        assert (root / "Renamed/Nested/Empty").is_dir()
        perform(client, path, "folder-trash", "trash", source="Renamed")
        assert_absent(root / "Renamed")
        perform(client, path, "undo-folder-trash", "undo", prior="folder-trash")
        assert (root / "Renamed/Nested/entry.txt").read_bytes() == b"Synthetic nested bytes"
        assert (root / "Renamed/Nested/Empty").is_dir()

        upload = b"Synthetic picker bytes"
        response = client.put(path + f"/uploads/picker?size={len(upload)}", content=upload)
        assert response.status_code == 201, response.text
        perform(client, path, "picker-copy", "copy", upload="picker", destination="picked.txt")
        assert (root / "picked.txt").read_bytes() == upload

        raced = prepare(
            client, path, "arrival-copy", "copy", source="amber.txt", destination="arrival.txt"
        )
        (root / "arrival.txt").write_bytes(b"Synthetic external arrival")
        assert (
            client.post(
                path + "/arrival-copy/accept", json={"receipt": raced["receipt"]}
            ).status_code
            == 202
        )
        eventually(
            lambda: client.get(path + "/arrival-copy").json(),
            lambda value: value["state"] == "interrupted",
            timeout=90,
        )
        assert (root / "arrival.txt").read_bytes() == b"Synthetic external arrival"
        perform(
            client,
            path,
            "recovery-copy",
            "restore",
            prior="arrival-copy",
            destination="recovered.txt",
        )
        assert (root / "recovered.txt").read_bytes() == b"Synthetic amber"
        assert client.put(prefix + "/write-mode", json={"enabled": False}).status_code == 200
        assert client.post(path, json=intent | {"operation": "permission-off"}).status_code == 403
        assert client.post(prefix + "/ownership/release").status_code == 200
        assert client.post(path, json=intent | {"operation": "released"}).status_code == 409
        assert client.post(prefix + "/ownership/reopen").status_code == 200
        receipts = client.get(path + "/receipts").json()["items"]
        assert len(receipts) == 9
        shared = json.dumps([value["receipt"] for value in receipts])
        assert str(root) not in shared and "smb3-v1:" not in shared
        assert not list(root.rglob("*.db*"))
