"""Run Update, explicit review and causal delivery through independent production sidecars"""

import shutil

from cairndex.devtools.discovery_fixture import create_discovery
from tests.test_replica_recovery_binary import command, eventually, running


# The same HTTP and backup workflow runs against source and the selected frozen executable
def test_two_sidecars_discover_move_and_restore_review(tmp_path):
    root = create_discovery(parent=tmp_path)
    peer = tmp_path / "peer"
    shutil.copytree(root, peer)
    roots = [root, peer]
    bases = [tmp_path / "private-a", tmp_path / "private-b"]
    (root / "new.png").write_bytes(b"synthetic packaged discovery")
    shutil.copy2(root / "new.png", peer / "new.png")
    with running(bases[0], tmp_path) as a, running(bases[1], tmp_path) as b:
        clients = [a, b]
        prefixes = []
        for index, client in enumerate(clients):
            response = client.post(
                "/api/v1/libraries/register", json={"root_path": str(roots[index])}
            )
            assert response.status_code == 201
            prefix = f"/api/v1/libraries/{response.json()['id']}"
            prefixes.append(prefix)
            eventually(
                lambda client=client, prefix=prefix: client.get(prefix + "/replica/status").json(),
                lambda s: s.get("ready"),
            )
            discovery = prefix + "/replica/discovery"
            assert (
                client.post(discovery + "/runs", json={"operation": "packaged-update"}).status_code
                == 202
            )
            eventually(
                lambda client=client, discovery=discovery: client.get(discovery + "/status").json(),
                lambda s: s.get("state") == "succeeded",
            )
            candidate = client.get(discovery + "/candidates").json()["items"][0]
            assert (
                client.post(
                    discovery + "/reviews",
                    json={"operation": "packaged-review", "candidate": candidate["id"]},
                ).status_code
                == 202
            )
            review = eventually(
                lambda client=client, discovery=discovery: client.get(
                    discovery + "/reviews/packaged-review"
                ).json(),
                lambda s: s.get("state") == "ready",
            )
            assert (
                client.post(
                    discovery + "/reviews/packaged-review/accept",
                    json={"receipt": review["receipt"]},
                ).status_code
                == 202
            )
            eventually(
                lambda client=client, discovery=discovery: client.get(
                    discovery + "/reviews/packaged-review"
                ).json(),
                lambda s: s.get("state") == "applied",
            )
        for source, destination in ((root, peer), (peer, root)):
            shutil.copytree(
                source / ".cairndex/replica/objects",
                destination / ".cairndex/replica/objects",
                dirs_exist_ok=True,
            )
        for client, prefix in zip(clients, prefixes, strict=True):
            eventually(
                lambda client=client, prefix=prefix: client.get(prefix + "/replica/status").json(),
                lambda s: s.get("outbox") == 0,
            )
            files = client.get(prefix + "/replica/catalog/entities/asset_files?limit=50").json()[
                "items"
            ]
            assert len(files) == 3 and all(not file["has_conflicts"] for file in files)
        (root / "new.png").rename(root / "moved.png")
        discovery = prefixes[0] + "/replica/discovery"
        assert a.post(discovery + "/runs", json={"operation": "packaged-move"}).status_code == 202
        moved = eventually(
            lambda: a.get(discovery + "/status").json(),
            lambda s: s.get("state") == "succeeded" and s.get("id") == "packaged-move",
        )
        assert moved["repaired"] == 1
        (root / "pending.png").write_bytes(b"synthetic pending packaged review")
        a.post(discovery + "/runs", json={"operation": "packaged-pending"})
        eventually(
            lambda: a.get(discovery + "/status").json(),
            lambda s: s.get("state") == "succeeded" and s.get("id") == "packaged-pending",
        )
        candidate = a.get(discovery + "/candidates").json()["items"][0]
        a.post(
            discovery + "/reviews",
            json={"operation": "retained-review", "candidate": candidate["id"]},
        )
        prepared = eventually(
            lambda: a.get(discovery + "/reviews/retained-review").json(),
            lambda s: s.get("state") == "ready",
        )
        checkpoint = tmp_path / "backup"
        command(root, bases[0], "backup", "--output", checkpoint)
        recovery = command(root, bases[0], "prepare", "--backup", checkpoint)
        assert a.post(prefixes[0] + "/ownership/release").status_code == 200
        command(
            root,
            bases[0],
            "activate",
            "--recovery",
            recovery["id"],
            "--receipt",
            recovery["receipt"],
        )
        assert a.post(prefixes[0] + "/ownership/reopen").status_code == 200
        retained = a.get(discovery + "/reviews/retained-review").json()
        assert retained["state"] == "failed" and retained["prepared"] == prepared["prepared"]
        assert (
            a.post(
                discovery + "/reviews", json={"operation": "retained-review", **retained["intent"]}
            ).status_code
            == 202
        )
        ready = eventually(
            lambda: a.get(discovery + "/reviews/retained-review").json(),
            lambda s: s.get("state") == "ready",
        )
        assert ready["prepared"] == prepared["prepared"]
        assert (
            a.post(
                discovery + "/reviews/retained-review/accept", json={"receipt": ready["receipt"]}
            ).status_code
            == 202
        )
        eventually(
            lambda: a.get(discovery + "/reviews/retained-review").json(),
            lambda s: s.get("state") == "applied",
        )
        assert (root / "moved.png").read_bytes() == (peer / "new.png").read_bytes()
