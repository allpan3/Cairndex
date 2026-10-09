"""Open a directly created empty package through independent serving processes."""

import shutil

from cairndex.devtools.replica_creation_fixture import prepare_disposable
from cairndex.replicas.catalog.creation import complete
from tests.test_replica_recovery_binary import eventually, running


def test_empty_creation_opens_releases_and_restarts(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    descriptor = complete(fixture)
    peer = tmp_path / "peer"
    shutil.copytree(fixture.root, peer)
    for index, root in enumerate((fixture.root, peer)):
        base = tmp_path / f"server-{index}"
        with running(base, tmp_path) as client:
            response = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
            assert response.status_code == 201
            assert response.json()["library_uuid"] == descriptor.library_uuid
            prefix = f"/api/v1/libraries/{response.json()['id']}"
            eventually(
                lambda client=client, prefix=prefix: client.get(prefix + "/replica/status").json(),
                lambda state: state.get("ready"),
            )
            assert (
                client.get(prefix + "/replica/catalog/entities/asset_bundles").json()["items"] == []
            )
            assert client.post(prefix + "/ownership/release").status_code == 200
            assert client.get(prefix + "/replica/status").status_code == 409
        with running(base, tmp_path) as client:
            assert client.get(prefix + "/replica/status").status_code == 409
            assert client.post(prefix + "/ownership/reopen").status_code == 200
            eventually(
                lambda client=client, prefix=prefix: client.get(prefix + "/replica/status").json(),
                lambda state: state.get("ready"),
            )
            assert not (root / ".cairndex/library.db").exists()
            assert not (root / ".cairndex/locks").exists()
