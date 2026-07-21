"""The ownership lease as seen through the API (ADR-0018 §3-§4).

Uses ``isolated_client`` so library-scoped routes perform real resolution and
actually pass through the mount gate — the shared-session ``client`` fixture
overrides that dependency and would bypass the thing under test.
"""

from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cairndex.core.time import utcnow
from cairndex.ownership import get_lease_manager, read_lease
from cairndex.ownership.lease import LeaseRecord, new_nonce, write_lease
from cairndex.registry import library_package as pkg

FOREIGN_UUID = "01OTHERSERVERAAAAAAAAAAAAA"


@pytest.fixture
def client(isolated_client: TestClient) -> TestClient:
    return isolated_client


def make_library(client: TestClient, root: Path, name: str = "Lib") -> str:
    root.mkdir()
    resp = client.post(
        "/api/v1/libraries/create", json={"root_path": str(root), "display_name": name}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


def plant_foreign_lease(
    root: Path,
    *,
    age: timedelta = timedelta(seconds=0),
    machine_name: str = "NAS",
    advertised_url: str | None = "http://nas.local:8000",
) -> None:
    """Write a lease belonging to some other server, aged as requested."""
    when = utcnow() - age
    write_lease(
        root,
        LeaseRecord(
            server_uuid=FOREIGN_UUID,
            machine_name=machine_name,
            advertised_url=advertised_url,
            acquired_at=when,
            heartbeat_at=when,
            nonce=new_nonce(),
        ),
    )


def content_url(library_id: str) -> str:
    return f"/api/v1/libraries/{library_id}/collections"


# --- the happy path -------------------------------------------------------


def test_serving_a_library_acquires_its_lease_on_disk(client: TestClient, tmp_path: Path) -> None:
    library_id = make_library(client, tmp_path / "lib")

    assert client.get(content_url(library_id)).status_code == 200

    snapshot = read_lease(tmp_path / "lib")
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == get_lease_manager().server_uuid


def test_ownership_reports_a_served_library_as_ours(client: TestClient, tmp_path: Path) -> None:
    library_id = make_library(client, tmp_path / "lib")
    client.get(content_url(library_id))

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()
    assert body["state"] == "own"
    assert body["mountable"] is True
    assert body["can_take_over"] is False
    assert body["holder"] is None


# --- refusing a library another server holds ------------------------------


def test_a_live_foreign_lease_blocks_the_mount_with_a_redirect(
    client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root)

    resp = client.get(content_url(library_id))

    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "library_lease_held"
    assert body["details"]["machine_name"] == "NAS"
    assert body["details"]["advertised_url"] == "http://nas.local:8000"


def test_the_refusal_reaches_streaming_routes_too(client: TestClient, tmp_path: Path) -> None:
    """``LibraryAccess`` is a separate gate from ``LibrarySession``; both must hold.

    A media byte-range request that skipped the lease would be a read of a
    library.db another machine is writing — exactly what ADR-0008 rejected.
    """
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root)

    resp = client.get(f"/api/v1/libraries/{library_id}/files/does-not-matter/content")

    assert resp.status_code == 409
    assert resp.json()["code"] == "library_lease_held"


def test_ownership_stays_readable_while_the_mount_gate_refuses(
    client: TestClient, tmp_path: Path
) -> None:
    """The whole point of this endpoint: it answers when nothing else will."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root)

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()

    assert body["state"] == "fresh"
    assert body["mountable"] is False
    assert body["can_take_over"] is False  # talk to that server; don't steal from it
    assert body["redirect_url"] == "http://nas.local:8000"
    assert body["holder"]["machine_name"] == "NAS"


def test_a_loopback_advertised_url_is_not_offered_as_a_redirect(
    client: TestClient, tmp_path: Path
) -> None:
    """A sidecar's own loopback address means nothing on a different machine."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root, advertised_url="http://127.0.0.1:8000")

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()

    assert body["redirect_url"] is None
    # Still named, so the user learns which machine has it.
    assert body["holder"]["machine_name"] == "NAS"


# --- stale leases and takeover -------------------------------------------


def test_a_stale_lease_refuses_the_mount_but_offers_a_takeover(
    client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root, age=timedelta(hours=9))

    resp = client.get(content_url(library_id))
    assert resp.status_code == 409
    assert resp.json()["code"] == "library_lease_takeover_required"

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()
    assert body["state"] == "stale"
    assert body["mountable"] is False
    assert body["can_take_over"] is True


def test_a_stale_lease_is_never_taken_without_confirmation(
    client: TestClient, tmp_path: Path
) -> None:
    """There is no auto-takeover after any TTL (ADR-0018 §3, owner-ratified)."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root, age=timedelta(days=30))

    for _ in range(3):
        client.get(content_url(library_id))

    snapshot = read_lease(root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == FOREIGN_UUID


def test_taking_over_a_live_library_is_refused(client: TestClient, tmp_path: Path) -> None:
    """ "That machine is gone" is not a claim anyone can make about a live server."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root)

    resp = client.post(f"/api/v1/libraries/{library_id}/ownership/takeover")

    assert resp.status_code == 422
    snapshot = read_lease(root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == FOREIGN_UUID


def test_a_confirmed_takeover_runs_in_the_background_and_then_mounts(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The endpoint accepts and returns; the observation happens off-request.

    The observation window is deliberately longer than a heartbeat period, so an
    endpoint that waited for it would hold a request open for minutes. Here the
    sleep is stubbed out and the background thread joined.
    """
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root, age=timedelta(hours=9))

    manager = get_lease_manager()
    monkeypatch.setattr(manager, "_sleep", lambda _seconds: None)

    resp = client.post(f"/api/v1/libraries/{library_id}/ownership/takeover")
    assert resp.status_code == 202

    _join_takeover_threads()

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()
    assert body["takeover"]["running"] is False
    assert body["takeover"]["error_code"] is None
    assert body["state"] == "own"
    assert client.get(content_url(library_id)).status_code == 200

    snapshot = read_lease(root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == manager.server_uuid


def test_a_takeover_loses_to_a_holder_that_wakes_up_mid_observation(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    plant_foreign_lease(root, age=timedelta(hours=9))

    manager = get_lease_manager()

    def holder_wakes(seconds: float) -> None:
        if seconds == manager.settings.observation_window:
            plant_foreign_lease(root, machine_name="NAS")

    monkeypatch.setattr(manager, "_sleep", holder_wakes)

    assert client.post(f"/api/v1/libraries/{library_id}/ownership/takeover").status_code == 202
    _join_takeover_threads()

    body = client.get(f"/api/v1/libraries/{library_id}/ownership").json()
    assert body["takeover"]["running"] is False
    assert body["takeover"]["error_code"] == "library_lease_held"
    assert body["state"] == "fresh"
    assert client.get(content_url(library_id)).status_code == 409


# --- ownership loss unmounts ---------------------------------------------


def test_losing_the_lease_unmounts_the_library_and_redirects(
    client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    assert client.get(content_url(library_id)).status_code == 200

    # Another machine completes a confirmed takeover while we are serving.
    plant_foreign_lease(root, machine_name="NAS")
    assert get_lease_manager().heartbeat_once() == [library_id]

    resp = client.get(content_url(library_id))
    assert resp.status_code == 409
    assert resp.json()["code"] == "library_lease_held"
    assert resp.json()["details"]["machine_name"] == "NAS"


def test_a_released_lease_is_picked_up_without_a_prompt(client: TestClient, tmp_path: Path) -> None:
    """The everyday cloud-sync flow: quit on one machine, open on the next."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    when = utcnow() - timedelta(days=2)
    write_lease(
        root,
        LeaseRecord(
            server_uuid=FOREIGN_UUID,
            machine_name="other laptop",
            advertised_url=None,
            acquired_at=when,
            heartbeat_at=when,
            nonce=new_nonce(),
            released_at=when,
        ),
    )

    assert client.get(content_url(library_id)).status_code == 200

    snapshot = read_lease(root)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == get_lease_manager().server_uuid


def test_the_lease_lives_inside_the_library_package(client: TestClient, tmp_path: Path) -> None:
    """It must travel with the folder — that is the whole enforcement model."""
    root = tmp_path / "lib"
    library_id = make_library(client, root)
    client.get(content_url(library_id))

    assert pkg.lease_path(root).is_file()
    assert pkg.lease_path(root) == root / ".cairndex" / "locks" / "active-owner.json"


def _join_takeover_threads(timeout: float = 5.0) -> None:
    import threading

    for thread in threading.enumerate():
        if thread.name.startswith("cairndex-takeover-"):
            thread.join(timeout=timeout)
