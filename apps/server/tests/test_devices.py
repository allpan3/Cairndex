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
from cairndex.core.errors import CapacityError
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
    library = registry_service.register_existing_library(registry, root_path=str(root))
    if passphrase is not None:
        set_passphrase(root, passphrase, registry=registry)
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


def _poll(client: TestClient, poll_key: str) -> dict[str, object]:
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
    assert delivered["library_ids"] == [library_id]
    assert isinstance(token, str)
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


def test_pairing_capacity_rejects_without_evicting_pending_requests() -> None:
    now = 1000.0
    store = PairingStore(ttl_seconds=600, max_outstanding=2)
    store._now = lambda: now  # type: ignore[method-assign]  # controlled clock
    first_code, first_poll = store.start("first", source="client-a")
    second_code, second_poll = store.start("second", source="client-b")
    assert store.approve(first_code, ["lib"]) is True

    with pytest.raises(CapacityError):
        store.start("third", source="client-c")

    assert store.consume_approval(first_poll, lambda _name, _ids: "token") == "token"
    assert store.consume_approval(second_poll, lambda _name, _ids: "token") is None

    now += 601
    assert store.approve(second_code, ["lib"]) is False
    assert store.consume_approval(second_poll, lambda _name, _ids: "token") is None


def test_pairing_start_is_limited_per_source() -> None:
    store = PairingStore(max_outstanding=16)
    for index in range(3):
        store.start(f"same-source-{index}", source="192.0.2.10")

    with pytest.raises(CapacityError):
        store.start("blocked", source="192.0.2.10")

    store.start("other-client", source="192.0.2.11")


def test_pairing_start_limit_returns_structured_429(isolated_client: TestClient) -> None:
    for index in range(3):
        assert (
            isolated_client.post(
                "/api/v1/auth/pair/start", json={"device_name": f"Device {index}"}
            ).status_code
            == 200
        )

    limited = isolated_client.post("/api/v1/auth/pair/start", json={"device_name": "One too many"})

    assert limited.status_code == 429
    assert limited.json() == {
        "code": "capacity_exhausted",
        "message": "Too many outstanding pairing requests from this client",
    }


def test_failed_token_commit_keeps_approval_and_issues_outside_store_lock() -> None:
    store = PairingStore()
    pair_code, poll_key = store.start("TV", source="client")
    assert store.approve(pair_code, ["lib"]) is True

    def fail_issue(_name: str, _library_ids: list[str]) -> str:
        assert store._lock.locked() is False  # noqa: SLF001 — lock-boundary regression
        raise RuntimeError("commit failed")

    with pytest.raises(RuntimeError, match="commit failed"):
        store.consume_approval(poll_key, fail_issue)

    assert store.consume_approval(poll_key, lambda _name, _ids: "token") == "token"
    assert store.consume_approval(poll_key, lambda _name, _ids: "duplicate") is None


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


def test_unavailable_library_cannot_be_approved_without_bypassing_owner_guard(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    owner_id = _make_library(tmp_path, registry_session, "owner", passphrase="owner")
    offline_id = _make_library(tmp_path, registry_session, "offline")
    (tmp_path / "offline").rename(tmp_path / "offline-unmounted")
    assert isolated_client.get("/api/v1/auth/devices").status_code == 401
    isolated_client.post(
        f"/api/v1/libraries/{owner_id}/auth/unlock",
        json={"passphrase": "owner"},
    )
    started = _start(isolated_client)

    response = isolated_client.post(
        "/api/v1/auth/pair/approve",
        json={"pair_code": started["pair_code"], "library_ids": [offline_id]},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"
    assert _poll(isolated_client, started["poll_key"]) == {"status": "pending"}


def test_unavailable_library_does_not_block_device_revocation(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "plain-online")
    _make_library(tmp_path, registry_session, "unrelated-offline")
    (tmp_path / "unrelated-offline").rename(tmp_path / "unrelated-offline-unmounted")
    token = token_service.issue_device_token(
        registry_session, name="Leaked TV", library_ids=[library_id]
    )
    registry_session.commit()
    device_id = registry_session.query(DeviceToken).filter_by(name="Leaked TV").one().id

    assert isolated_client.get("/api/v1/auth/devices").status_code == 200
    assert isolated_client.delete(f"/api/v1/auth/devices/{device_id}").status_code == 204
    denied = isolated_client.get(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert denied.status_code == 401


def test_setting_passphrase_revokes_tokens_minted_while_unprotected(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "protect-later")
    started = _start(isolated_client)
    _approve(isolated_client, started["pair_code"], [library_id])
    token = _poll(isolated_client, started["poll_key"])["token"]
    assert (
        isolated_client.get(
            f"/api/v1/libraries/{library_id}/bundles/browse",
            headers={"Authorization": f"Bearer {token}"},
        ).status_code
        == 200
    )

    assert set_passphrase(tmp_path / "protect-later", "owner", registry=registry_session) == 1
    registry_session.commit()

    device = registry_session.query(DeviceToken).one()
    assert device.revoked_at is not None
    denied = isolated_client.get(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert denied.status_code == 401


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


def test_auth_status_accepts_valid_scoped_bearer_for_protected_library(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    library_id = _make_library(tmp_path, registry_session, "protected", passphrase="owner")
    token = token_service.issue_device_token(
        registry_session, name="Cairndex Desktop", library_ids=[library_id]
    )
    registry_session.commit()

    status_response = isolated_client.get(
        f"/api/v1/libraries/{library_id}/auth/status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert status_response.status_code == 200
    assert status_response.json() == {"protected": True, "unlocked": True}


def test_auth_status_rejects_invalid_or_out_of_scope_bearer(
    isolated_client: TestClient,
    registry_session: Session,
    tmp_path: Path,
) -> None:
    allowed_id = _make_library(tmp_path, registry_session, "status-allowed", passphrase="owner")
    denied_id = _make_library(tmp_path, registry_session, "status-denied", passphrase="other")
    token = token_service.issue_device_token(
        registry_session, name="Cairndex Desktop", library_ids=[allowed_id]
    )
    registry_session.commit()

    out_of_scope = isolated_client.get(
        f"/api/v1/libraries/{denied_id}/auth/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    invalid = isolated_client.get(
        f"/api/v1/libraries/{allowed_id}/auth/status",
        headers={"Authorization": "Bearer invalid"},
    )

    assert out_of_scope.status_code == 403
    assert out_of_scope.json()["code"] == "device_scope_forbidden"
    assert invalid.status_code == 401
    assert invalid.json()["code"] == "invalid_device_token"


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
