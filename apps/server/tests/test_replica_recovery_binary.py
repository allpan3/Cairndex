"""Exercise the supported recovery command and serving lifecycle in source or frozen sidecars"""

import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import closing, contextmanager

import httpx

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.binding import location
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.recovery_validation import file_hash


# An optional binary runs the identical acceptance path against a built packaged sidecar
def executable():
    binary = os.environ.get("CAIRNDEX_RECOVERY_TEST_BINARY")
    return [binary] if binary else [sys.executable, "-m", "cairndex.sidecar"]


# Explicit private arguments keep the command independent of shell preferences and owner data
def command(root, base, *args):
    result = subprocess.run(
        [
            *executable(),
            "replica-recovery",
            "--library",
            str(root),
            "--data-dir",
            str(base),
            *map(str, args),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# The sidecar receives only disposable local state and its own synthetic HTTP credential
@contextmanager
def running(base, tmp_path):
    token = "synthetic-recovery-local-token"
    environment = {
        name: value for name, value in os.environ.items() if not name.startswith("CAIRNDEX_")
    }
    environment.update(
        CAIRNDEX_DATA_DIR=str(base), CAIRNDEX_LOCAL_TOKEN=token, CAIRNDEX_WORKER_ENABLED="false"
    )
    log = tmp_path / (base.name + ".log")
    with log.open("w") as sink:
        process = subprocess.Popen(
            [*executable(), "--watch-parent"],
            stdin=subprocess.PIPE,
            stdout=sink,
            stderr=sink,
            env=environment,
        )
        try:
            deadline = time.monotonic() + 20
            client = None
            while time.monotonic() < deadline:
                assert process.poll() is None, log.read_text()
                port = next(
                    (
                        line.split("=", 1)[1]
                        for line in log.read_text().splitlines()
                        if line.startswith("CAIRNDEX_SIDECAR_PORT=")
                    ),
                    None,
                )
                if port:
                    client = httpx.Client(
                        base_url=f"http://127.0.0.1:{port}",
                        headers={"Authorization": f"Bearer {token}"},
                        timeout=10,
                    )
                    try:
                        if client.get("/api/v1/health").is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    client.close()
                    client = None
                time.sleep(0.05)
            assert client is not None, log.read_text()
            with closing(client):
                yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


# Poll observable HTTP state rather than trusting command dispatch or database serialization alone
def eventually(read, valid, *, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if valid(value):
            return value
        time.sleep(0.05)
    raise AssertionError("Synthetic sidecar did not reach the expected state")


# Full local command lifecycle restores private work to a new server and repairs a damaged original
def test_supported_sidecar_backup_restore_and_damaged_device(tmp_path):
    conversion = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    root, base = conversion.package, tmp_path / "server-a"
    second_root, second_base = tmp_path / "package-b", tmp_path / "server-b"
    shutil.copytree(root, second_root)
    with running(base, tmp_path) as client:
        response = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
        assert response.status_code == 201
        prefix = f"/api/v1/libraries/{response.json()['id']}"
        eventually(
            lambda: client.get(prefix + "/replica/status").json(), lambda value: value.get("ready")
        )
        entity = client.get(prefix + "/replica/catalog/entities/asset_bundles/bundle-000000").json()
        body = {
            "changes": [
                {
                    "unit": entity["fields"][field]["unit"],
                    "basis": entity["fields"][field]["basis"],
                    "value": json.dumps(value),
                }
                for field, value in (("title", "Packaged private recovery"), ("$alive", True))
            ],
            "parents": entity["parents"],
            "resolve": False,
            "recover": False,
        }
        assert (
            client.post(
                prefix + "/replica/catalog/jobs",
                json={"operation": "packaged-save", "action": "save", "body": body},
            ).status_code
            == 202
        )
        eventually(
            lambda: client.get(prefix + "/replica/catalog/jobs/packaged-save").json(),
            lambda value: value.get("state") == "succeeded",
        )
        assert (
            client.put(
                prefix + "/replica/catalog/drafts/editor/packaged-draft",
                json={
                    "revision": 1,
                    "body": {"text": "Private retained text", "bases": entity["parents"]},
                },
            ).status_code
            == 204
        )
        checkpoint = tmp_path / "backup"
        backup = command(root, base, "backup", "--output", checkpoint)
        assert backup["inventory"]["tables"]["drafts"] == 1
        preserved = {path.name: file_hash(path) for path in checkpoint.iterdir()}
        review = command(second_root, second_base, "prepare", "--backup", checkpoint)
        assert review["state"] == "prepared"
        command(
            second_root,
            second_base,
            "activate",
            "--recovery",
            review["id"],
            "--receipt",
            review["receipt"],
        )
        with running(second_base, tmp_path) as second:
            registered = second.post(
                "/api/v1/libraries/register", json={"root_path": str(second_root)}
            ).json()
            other = f"/api/v1/libraries/{registered['id']}/replica/catalog"
            assert (
                second.get(other + "/entities/asset_bundles/bundle-000000").json()["fields"][
                    "title"
                ]["value"]
                == '"Packaged private recovery"'
            )
            assert (
                second.get(other + "/drafts?owner=editor").json()["items"][0]["body"]["text"]
                == "Private retained text"
            )
            assert second.get(other + "/jobs/packaged-save").json()["state"] == "succeeded"
        assert client.post(prefix + "/ownership/release").status_code == 200
        original, _ = location(base, conversion.store.descriptor)
        (original / "replica.db").write_bytes(b"damaged synthetic database")
        repair = command(root, base, "prepare", "--backup", checkpoint)
        assert repair["previous"]["state"] == "damaged"
        command(root, base, "activate", "--recovery", repair["id"], "--receipt", repair["receipt"])
        assert client.post(prefix + "/ownership/reopen").status_code == 200
        assert (
            client.get(prefix + "/replica/catalog/entities/asset_bundles/bundle-000000").json()[
                "fields"
            ]["title"]["value"]
            == '"Packaged private recovery"'
        )
        assert (original / "replica.db").read_bytes() == b"damaged synthetic database"
        assert preserved == {path.name: file_hash(path) for path in checkpoint.iterdir()}
        assert (
            len(
                {
                    backup["inventory"]["author"],
                    review["inventory"]["author"],
                    repair["inventory"]["author"],
                }
            )
            == 3
        )
