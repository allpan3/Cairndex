"""Production request admission and release coordinate private recovery activation"""

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from cairndex.core.config import get_settings
from cairndex.ownership.lifecycle import lifecycle
from cairndex.registry.library_package import read_manifest
from cairndex.replicas import recovery, service
from cairndex.replicas.protocol import ReplicaError
from tests.test_replica_catalog_api import api as api


# Activation waits for the existing release contract to drain admitted work and retire old handles
def test_api_release_drains_before_explicit_recovery_activation(api, tmp_path):
    client, api_base, store = api
    library = api_base.split("/")[-1]
    root = service._handles[library][1].root
    base = get_settings().data_dir.resolve()
    recovery.backup(root, base, tmp_path / "backup")
    review = recovery.prepare(root, base, tmp_path / "backup")
    entered, finish = threading.Event(), threading.Event()

    # This admission represents a stream/job request already running when Release begins
    def work():
        with lifecycle.work(library):
            entered.set()
            assert finish.wait(10)

    with ThreadPoolExecutor() as pool:
        request = pool.submit(work)
        assert entered.wait(5)
        releasing = pool.submit(client.post, api_base + "/ownership/release")
        with pytest.raises(ReplicaError, match="active"):
            recovery.activate(root, base, review["id"], review["receipt"])
        finish.set()
        request.result()
        assert releasing.result().status_code == 200
    with pytest.raises(ReplicaError, match="changed"):
        store.status()
    recovery.activate(root, base, review["id"], review["receipt"])
    assert client.post(api_base + "/ownership/reopen").status_code == 200
    assert client.get(api_base + "/replica/status").json()["ready"]
    new_store = service._handles[library][0]
    assert new_store.path != store.path
    assert read_manifest(root).replica == store.descriptor


# A vanished private database or entire generation remains a recovery-required state on Reopen
@pytest.mark.parametrize("missing", ["database", "directory"])
def test_bound_missing_private_store_never_silently_resets(api, tmp_path, missing):
    client, api_base, store = api
    library = api_base.split("/")[-1]
    root = service._handles[library][1].root
    base = get_settings().data_dir.resolve()
    recovery.backup(root, base, tmp_path / "backup")
    assert client.post(api_base + "/ownership/release").status_code == 200
    if missing == "database":
        store.path.unlink()
    else:
        store.path.parent.rename(tmp_path / "retained-original")
    client.post(api_base + "/ownership/reopen")
    response = client.get(api_base + "/replica/status")
    assert response.status_code == 409
    assert not store.path.exists()
    review = recovery.prepare(root, base, tmp_path / "backup")
    recovery.activate(root, base, review["id"], review["receipt"])
    assert client.get(api_base + "/replica/status").json()["ready"]
    assert not store.path.exists()


# Replacing a DB beneath an admitted handle cannot redirect a later transaction
def test_database_replacement_fences_existing_handle(api, tmp_path):
    client, api_base, store = api
    replacement = tmp_path / "replaced.db"
    store.path.rename(replacement)
    Path(store.path).write_bytes(replacement.read_bytes())
    assert client.get(api_base + "/replica/status").status_code == 409
