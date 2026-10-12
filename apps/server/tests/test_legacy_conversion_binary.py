"""The source or frozen sidecar runs the public conversion worker and Undo."""

from uuid import uuid4

from tests.test_legacy_conversion import _legacy, _tree
from tests.test_replica_recovery_binary import eventually, running


def test_sidecar_conversion_review_activation_and_undo(tmp_path):
    root = _legacy(tmp_path)
    original = _tree(root / ".cairndex")
    media = _tree(root / "Synthetic")
    tasks = "/api/v1/libraries/conversions/tasks"
    with running(tmp_path / "private", tmp_path, worker_enabled=True) as client:

        def step(action, **fields):
            operation = uuid4().hex
            response = client.post(
                tasks,
                json={
                    "operation": operation,
                    "action": action,
                    "root_path": str(root),
                    **fields,
                },
            )
            assert response.status_code == 202
            result = eventually(
                lambda: client.get(tasks + "/" + operation).json(),
                lambda row: row.get("state") in {"succeeded", "failed"},
            )
            assert result["state"] == "succeeded", result.get("error")
            return result

        assert step("inspect")["result"]["inspection"]["blocking"] == []
        review = step("prepare")
        assert _tree(root / ".cairndex") == original
        exact = {"attempt": review["id"], "receipt": review["result"]["receipt"]}
        converted = step("activate", **exact)
        prefix = "/api/v1/libraries/" + converted["result"]["library_id"]
        assert client.post(prefix + "/ownership/reopen").status_code == 200
        eventually(
            lambda: client.get(prefix + "/replica/status").json(), lambda row: row.get("ready")
        )
        assert client.post(prefix + "/ownership/release").status_code == 200
        restored = step("undo", **exact)
        assert restored["result"]["state"] == "restored"
        assert _tree(root / ".cairndex") == original
        assert _tree(root / "Synthetic") == media
