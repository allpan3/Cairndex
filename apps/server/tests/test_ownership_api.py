"""Portable serving uses private Release/Reopen and never a shared-folder lease."""

from tests.test_library_scoped import create


def test_private_release_reopen_and_repeated_release(isolated_client, tmp_path):
    client = isolated_client
    identity, catalog = create(client, tmp_path / "library")
    base = f"/api/v1/libraries/{identity}"
    status = client.get(base + "/ownership").json()
    assert status["mountable"] and not status["can_take_over"]
    for _ in range(2):
        released = client.post(base + "/ownership/release")
        assert released.status_code == 200, released.text
        assert released.json()["state"] == "locally_released"
        assert not released.json()["mountable"]
    assert client.get(catalog + "/entities/collections").status_code == 409
    assert client.post(base + "/ownership/reopen").status_code == 200
    assert client.get(catalog + "/entities/collections").status_code == 200
    assert not (tmp_path / "library/.cairndex/locks").exists()


def test_release_and_reopen_require_private_grant(isolated_client, tmp_path):
    client = isolated_client
    identity, _ = create(client, tmp_path / "library")
    base = f"/api/v1/libraries/{identity}"
    assert (
        client.put(base + "/auth/settings", json={"passphrase": "Synthetic guard"}).status_code
        == 200
    )
    client.post(base + "/auth/lock")
    assert client.post(base + "/ownership/release").status_code == 401
    client.post(base + "/auth/unlock", json={"passphrase": "Synthetic guard"})
    assert client.post(base + "/ownership/release").status_code == 200
    client.post(base + "/auth/lock")
    assert client.post(base + "/ownership/reopen").status_code == 401
    client.post(base + "/auth/unlock", json={"passphrase": "Synthetic guard"})
    assert client.post(base + "/ownership/reopen").status_code == 200


def test_shared_folder_takeover_is_not_supported(isolated_client, tmp_path):
    identity, _ = create(isolated_client, tmp_path / "library")
    response = isolated_client.post(f"/api/v1/libraries/{identity}/ownership/takeover")
    assert response.status_code == 409
    assert not (tmp_path / "library/.cairndex/locks").exists()
