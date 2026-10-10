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


# Source and frozen servers accept complete collections and verified large media
def test_sidecar_complete_collection_and_full_verification(tmp_path):
    import hashlib
    from functools import partial

    wait = partial(eventually, timeout=60)

    root = create_discovery(parent=tmp_path, playable=True)
    shelf = root / "Shelf"
    (shelf / "Album").mkdir(parents=True)
    picture = (root / "Playback/picture.png").read_bytes()
    for index in range(201):
        (shelf / "Album" / f"frame{index:03}.png").write_bytes(picture)
    source = root / "large.mp4"
    from cairndex.media.ffmpeg_exec import ffmpeg_exe, run_ffmpeg

    run_ffmpeg(
        [
            ffmpeg_exe(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=20",
            "-t",
            "20",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(source),
        ],
        timeout=30,
        stderr_limit=200,
    )
    assert source.stat().st_size > 2 * 1024 * 1024
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with running(tmp_path / "private-complete", tmp_path) as client:
        registered = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
        assert registered.status_code == 201
        prefix = f"/api/v1/libraries/{registered.json()['id']}"
        base = prefix + "/replica/discovery"
        wait(lambda: client.get(prefix + "/replica/status").json(), lambda s: s.get("ready"))
        client.post(base + "/runs", json={"operation": "complete-update"})
        wait(lambda: client.get(base + "/status").json(), lambda s: s.get("state") == "succeeded")
        candidates = client.get(base + "/candidates").json()["items"]
        album = next(c for c in candidates if c["body"]["kind"] == "collection")
        large = next(c for c in candidates if c["path"] == "large.mp4")
        client.post(
            base + "/verifications", json={"operation": "complete-hash", "candidate": large["id"]}
        )
        verified = wait(
            lambda: client.get(base + "/verifications/complete-hash").json(),
            lambda s: s.get("state") == "succeeded",
        )
        assert verified["bytes_read"] == source.stat().st_size
        for candidate, operation, extra in (
            (album, "complete-album", {"collection": "collections-child"}),
            (large, "complete-large", {"verification": "complete-hash"}),
        ):
            client.post(
                base + "/reviews",
                json={"operation": operation, "candidate": candidate["id"], **extra},
            )
            reviewed = wait(
                lambda operation=operation: client.get(base + "/reviews/" + operation).json(),
                lambda s: s.get("state") == "ready",
            )
            if candidate is album:
                assert reviewed["prepared"]["file_count"] == 201
                assert len(reviewed["prepared"]["files"]) == 50
                assert reviewed["prepared"]["groups"][0]["placement"] == [
                    "Synthetic root",
                    "Synthetic child",
                    "Shelf",
                ]
            else:
                assert reviewed["prepared"]["files"][0]["evidence"]["digest"] == digest
            client.post(
                base + "/reviews/" + operation + "/accept", json={"receipt": reviewed["receipt"]}
            )
            wait(
                lambda operation=operation: client.get(base + "/reviews/" + operation).json(),
                lambda s: s.get("state") == "applied",
            )
        assert not client.get(base + "/candidates").json()["items"]
        checkpoint = tmp_path / "complete-backup"
        command(root, tmp_path / "private-complete", "backup", "--output", checkpoint)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
