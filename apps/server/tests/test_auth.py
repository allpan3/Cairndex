"""Per-library optional owner passphrase lock (ADR-0010).

Uses ``isolated_client`` so library-scoped routes do real per-library resolution
and the content gate actually runs (the plain ``client`` fixture overrides that
dependency and bypasses the gate).
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.auth import (
    hash_passphrase,
    is_protected,
    set_passphrase,
    verify_hash,
    verify_passphrase,
)
from cairndex.auth.sessions import SessionStore
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service


def _make_library(tmp_path: Path, registry: Session, name: str, *, passphrase: str | None) -> str:
    root = tmp_path / name
    root.mkdir()
    pkg.create_package(root, name)
    if passphrase is not None:
        set_passphrase(root, passphrase)
    library = registry_service.register_existing_library(registry, root_path=str(root))
    registry.commit()
    return library.id


def _browse(client: TestClient, library_id: str) -> int:
    return client.get(f"/api/v1/libraries/{library_id}/bundles/browse").status_code


# --- password hashing --------------------------------------------------------
def test_hash_roundtrip_and_reject() -> None:
    record = hash_passphrase("correct horse")
    assert "hash" in record and "correct horse" not in str(record)
    assert verify_hash("correct horse", record) is True
    assert verify_hash("wrong", record) is False
    # Tampered/foreign record shape → False, never raises.
    assert verify_hash("x", {"scheme": "bogus"}) is False


def test_empty_passphrase_rejected() -> None:
    with pytest.raises(ValueError):
        hash_passphrase("")


# --- session store -----------------------------------------------------------
def test_session_store_scoping_and_expiry() -> None:
    store = SessionStore(ttl_seconds=1000)
    token = store.unlock(None, "libA")
    assert store.is_unlocked(token, "libA") is True
    # Scoped: the same session has not unlocked another library.
    assert store.is_unlocked(token, "libB") is False
    # A different (unknown) token is not unlocked for libA.
    assert store.is_unlocked("someone-else", "libA") is False
    # Manual lock revokes it.
    store.lock(token, "libA")
    assert store.is_unlocked(token, "libA") is False
    # Expiry: force the grant into the past.
    token2 = store.unlock(None, "libA")
    store._sessions[token2].unlocked["libA"] = 0.0  # noqa: SLF001 — white-box expiry check
    assert store.is_unlocked(token2, "libA") is False


# --- manifest-backed config --------------------------------------------------
def test_set_and_verify_passphrase(tmp_path: Path) -> None:
    root = tmp_path / "lib"
    root.mkdir()
    pkg.create_package(root, "L")
    assert is_protected(root) is False
    set_passphrase(root, "s3cret")
    assert is_protected(root) is True
    assert verify_passphrase(root, "s3cret") is True
    assert verify_passphrase(root, "nope") is False
    # Other manifest fields survive the auth write.
    assert pkg.read_manifest(root).display_name == "L"


# --- API + gate --------------------------------------------------------------
def test_protected_library_blocks_until_unlocked(
    isolated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    protected = _make_library(tmp_path, registry_session, "protected", passphrase="open-sesame")
    unprotected = _make_library(tmp_path, registry_session, "plain", passphrase=None)

    # Status reflects protection; content is blocked while locked.
    status = isolated_client.get(f"/api/v1/libraries/{protected}/auth/status").json()
    assert status == {"protected": True, "unlocked": False}
    assert _browse(isolated_client, protected) == 401
    # Unprotected library works normally and needs no unlock.
    assert _browse(isolated_client, unprotected) == 200
    assert (
        isolated_client.get(f"/api/v1/libraries/{unprotected}/auth/status").json()["unlocked"]
        is True
    )

    # Wrong passphrase → generic 401, no unlock.
    bad = isolated_client.post(
        f"/api/v1/libraries/{protected}/auth/unlock", json={"passphrase": "guess"}
    )
    assert bad.status_code == 401
    assert _browse(isolated_client, protected) == 401

    # Correct passphrase → unlocked; content now accessible (cookie persists).
    ok = isolated_client.post(
        f"/api/v1/libraries/{protected}/auth/unlock", json={"passphrase": "open-sesame"}
    )
    assert ok.status_code == 200
    assert ok.json() == {"protected": True, "unlocked": True}
    assert _browse(isolated_client, protected) == 200


def test_unlocking_one_library_does_not_unlock_another(
    isolated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    a = _make_library(tmp_path, registry_session, "libA", passphrase="aaa")
    b = _make_library(tmp_path, registry_session, "libB", passphrase="bbb")

    isolated_client.post(f"/api/v1/libraries/{a}/auth/unlock", json={"passphrase": "aaa"})
    assert _browse(isolated_client, a) == 200
    # B remains locked — unlocking A must not leak to B.
    assert _browse(isolated_client, b) == 401
    assert isolated_client.get(f"/api/v1/libraries/{b}/auth/status").json()["unlocked"] is False


def test_manual_lock_relocks(
    isolated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    lib = _make_library(tmp_path, registry_session, "lib", passphrase="pw")
    isolated_client.post(f"/api/v1/libraries/{lib}/auth/unlock", json={"passphrase": "pw"})
    assert _browse(isolated_client, lib) == 200
    isolated_client.post(f"/api/v1/libraries/{lib}/auth/lock")
    assert _browse(isolated_client, lib) == 401
