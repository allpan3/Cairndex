"""Device pairing and bearer-token authentication (ADR-0015)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session

from cairndex.auth import device_tokens as auth_tokens
from cairndex.auth import set_passphrase
from cairndex.auth.device_tokens import PairingStore
from cairndex.registry import device_tokens as token_service
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import create_registry_engine
from cairndex.registry.models import DeviceToken, JobQueueEntry, RegisteredLibrary


def _make_library(
    tmp_path: Path,
    registry: Session,
    name: str,
    *,
    passphrase: str | None = None,
) -> str:
    """Create and register a test library with an optional owner lock."""
    root = tmp_path / name
    root.mkdir()
    pkg.create_package(root, name)
    if passphrase is not None:
        set_passphrase(root, passphrase)
    library = registry_service.register_existing_library(registry, root_path=str(root))
    registry.commit()
    return library.id


def _start(client: TestClient, name: str = "Living room TV") -> dict[str, str]:
    """Start a pairing request and return its public device-side values."""
    response = client.post("/api/v1/auth/pair/start", json={"device_name": name})
    assert response.status_code == 200
    return response.json()


def _approve(client: TestClient, pair_code: str, library_ids: list[str]) -> None:
    """Approve a pairing request from the current browser session."""
    response = client.post(
        "/api/v1/auth/pair/approve",
        json={"pair_code": pair_code, "library_ids": library_ids},
    )
    assert response.status_code == 204


def _poll(client: TestClient, poll_key: str) -> dict[str, str]:
    """Poll a device-side pairing key."""
    response = client.post("/api/v1/auth/pair/poll", json={"poll_key": poll_key})
    assert response.status_code == 200
    return response.json()


def test_pairing_round_trip_delivers_token_once_and_stores_only_hash(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "plain")

    started = _start(isolated_client)
    assert len(started["pair_code"]) == 6
    assert "0" not in started["pair_code"] and "O" not in started["pair_code"]
    assert "1" not in started["pair_code"] and "I" not in started["pair_code"]
    _approve(isolated_client, started["pair_code"].lower(), [library_id])

    delivered = _poll(isolated_client, started["poll_key"])
    assert delivered["status"] == "approved"
    token = delivered["token"]
    assert token.startswith("cdx_")
    assert _poll(isolated_client, started["poll_key"]) == {"status": "pending"}

    device = registry_session.query(DeviceToken).one()
    assert token not in device.token_hash
    assert device.library_ids == [library_id]
    allowed = isolated_client.get(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert allowed.status_code == 200


def test_pairing_expiry_and_eviction_have_uniform_pending_shape() -> None:
    now = 1000.0
    store = PairingStore(ttl_seconds=600, max_outstanding=2)
    store._now = lambda: now  # type: ignore[method-assign]  # controlled clock
    first_code, first_poll = store.start("first")
    _second_code, second_poll = store.start("second")
    _third_code, third_poll = store.start("third")

    assert store.approve(first_code, ["lib"]) is False  # oldest was evicted
    assert store.consume_approval(first_poll, lambda _name, _ids: "token") is None
    assert store.consume_approval(second_poll, lambda _name, _ids: "token") is None
    assert store.consume_approval(third_poll, lambda _name, _ids: "token") is None

    now += 601
    assert store.approve(_second_code, ["lib"]) is False
    assert store.consume_approval(second_poll, lambda _name, _ids: "token") is None


def test_wrong_pair_code_is_structured_not_found(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "plain")
    _start(isolated_client)
    response = isolated_client.post(
        "/api/v1/auth/pair/approve",
        json={"pair_code": "AAAAAA", "library_ids": [library_id]},
    )
    assert response.status_code == 404
    assert response.json() == {
        "code": "not_found",
        "message": "Pairing code is invalid or expired",
    }


def test_protected_library_requires_cookie_approval_and_bearer_scope(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    allowed_id = _make_library(tmp_path, registry_session, "allowed", passphrase="owner")
    denied_id = _make_library(tmp_path, registry_session, "denied", passphrase="other")
    started = _start(isolated_client)

    locked = isolated_client.post(
        "/api/v1/auth/pair/approve",
        json={"pair_code": started["pair_code"], "library_ids": [allowed_id]},
    )
    assert locked.status_code == 401
    assert locked.json()["code"] == "auth_required"
    assert isolated_client.get(f"/api/v1/libraries/{allowed_id}/bundles/browse").status_code == 401

    isolated_client.post(
        f"/api/v1/libraries/{allowed_id}/auth/unlock",
        json={"passphrase": "owner"},
    )
    _approve(isolated_client, started["pair_code"], [allowed_id])
    token = _poll(isolated_client, started["poll_key"])["token"]

    assert (
        isolated_client.get(
            f"/api/v1/libraries/{allowed_id}/bundles/browse",
            headers={"Authorization": f"Bearer {token}"},
        ).status_code
        == 200
    )
    denied = isolated_client.get(
        f"/api/v1/libraries/{denied_id}/bundles/browse",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert denied.status_code == 403
    assert denied.json()["code"] == "device_scope_forbidden"


def test_revoked_and_unknown_tokens_return_structured_401(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "plain")
    started = _start(isolated_client)
    _approve(isolated_client, started["pair_code"], [library_id])
    token = _poll(isolated_client, started["poll_key"])["token"]
    device_id = registry_session.query(DeviceToken).one().id

    revoked = isolated_client.delete(f"/api/v1/auth/devices/{device_id}")
    assert revoked.status_code == 204
    response = isolated_client.get(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    assert response.json() == {
        "code": "invalid_device_token",
        "message": "Device token is invalid or revoked",
    }

    unknown = isolated_client.get(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        headers={"Authorization": "Bearer not-a-device-token"},
    )
    assert unknown.status_code == 401
    assert unknown.json()["code"] == "invalid_device_token"


def test_device_hash_comparison_uses_compare_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    token = "cdx_01J00000000000000000000000." + "x" * 43
    record = auth_tokens.hash_device_token(token)
    real_compare = auth_tokens.hmac.compare_digest
    calls = 0

    def tracked_compare(left: bytes, right: bytes) -> bool:
        nonlocal calls
        calls += 1
        return real_compare(left, right)

    monkeypatch.setattr(auth_tokens.hmac, "compare_digest", tracked_compare)
    assert auth_tokens.verify_device_token(token, record) is True
    assert calls == 1


def test_last_used_write_is_throttled(
    registry_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = datetime(2026, 7, 13, tzinfo=UTC)
    monkeypatch.setattr(token_service, "utcnow", lambda: base)
    token = token_service.issue_device_token(registry_session, name="TV", library_ids=["lib"])
    first = token_service.authenticate_device_token(registry_session, token=token, library_id="lib")
    assert first.last_used_at == base

    monkeypatch.setattr(token_service, "utcnow", lambda: base + timedelta(seconds=30))
    token_service.authenticate_device_token(registry_session, token=token, library_id="lib")
    assert first.last_used_at == base

    later = base + timedelta(seconds=61)
    monkeypatch.setattr(token_service, "utcnow", lambda: later)
    token_service.authenticate_device_token(registry_session, token=token, library_id="lib")
    assert first.last_used_at == later


def test_registry_bootstrap_adds_device_tokens_table(tmp_path: Path) -> None:
    db_path = tmp_path / "old-registry.db"
    old_engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    RegisteredLibrary.__table__.create(old_engine)
    JobQueueEntry.__table__.create(old_engine)
    old_engine.dispose()

    migrated = create_registry_engine(f"sqlite:///{db_path.as_posix()}")
    try:
        assert "device_tokens" in inspect(migrated).get_table_names()
    finally:
        migrated.dispose()
