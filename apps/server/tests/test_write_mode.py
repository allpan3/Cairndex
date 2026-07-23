"""The per-library write-mode gate (ADR-0013 §1, plan 4 W0).

Uses ``isolated_client`` so the per-library passphrase gate really runs: the
plain ``client`` fixture overrides library resolution and would bypass it.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Engine, inspect, text
from sqlalchemy.orm import Session

from cairndex.api.deps import WriteModeRequired, get_registry_db
from cairndex.auth import set_passphrase
from cairndex.core.config import get_settings
from cairndex.main import create_app
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import create_registry_engine

# A stand-in for the write endpoints W1 onwards will declare. The gate is a
# route dependency, so the only faithful way to test it is through a route.
GATED_PATH = "/api/v1/libraries/{library_id}/_gated-write"


def _make_library(tmp_path: Path, registry: Session, name: str, *, passphrase: str | None) -> str:
    root = tmp_path / name
    root.mkdir()
    pkg.create_package(root, name)
    library = registry_service.register_existing_library(registry, root_path=str(root))
    if passphrase is not None:
        set_passphrase(root, passphrase, registry=registry)
    registry.commit()
    return library.id


def _mount_gated_route(app: FastAPI) -> None:
    @app.post(GATED_PATH)
    def gated_write(library_id: str, _gate: WriteModeRequired) -> dict[str, str]:
        return {"library_id": library_id}


@pytest.fixture
def gated_client(registry_session: Session) -> Iterator[TestClient]:
    """A client whose app carries one write-gated route alongside the real API."""
    app = create_app()
    _mount_gated_route(app)

    def _override_get_registry_db() -> Iterator[Session]:
        try:
            yield registry_session
            registry_session.commit()
        except Exception:
            registry_session.rollback()
            raise

    app.dependency_overrides[get_registry_db] = _override_get_registry_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@contextmanager
def _deployment_write_mode(value: str) -> Iterator[None]:
    """Set the ``CAIRNDEX_WRITE_MODE`` master switch for one block."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CAIRNDEX_WRITE_MODE", value)
        get_settings.cache_clear()
        try:
            yield
        finally:
            get_settings.cache_clear()


def _gated(client: TestClient, library_id: str) -> Response:
    return client.post(GATED_PATH.format(library_id=library_id))


def _set(client: TestClient, library_id: str, **payload: object) -> Response:
    return client.put(f"/api/v1/libraries/{library_id}/write-mode", json=payload)


# --- default posture ---------------------------------------------------------
def test_write_mode_is_off_by_default(gated_client: TestClient, library_id: str) -> None:
    state = gated_client.get(f"/api/v1/libraries/{library_id}/write-mode")

    assert state.status_code == 200
    assert state.json() == {
        "enabled": False,
        "allowed_by_deployment": True,
        "effective": False,
        "requires_passphrase": False,
    }
    # And the listing agrees, so the manager needs no extra request to render it.
    listed = gated_client.get("/api/v1/libraries").json()
    assert [lib["write_mode_enabled"] for lib in listed] == [False]


def test_gate_refuses_a_read_only_library(gated_client: TestClient, library_id: str) -> None:
    refused = _gated(gated_client, library_id)

    assert refused.status_code == 403
    body = refused.json()
    assert body["code"] == "write_mode_disabled"
    # Which gate said no decides what the user can do about it.
    assert body["details"] == {"reason": "library"}


def test_enabling_opens_the_gate(gated_client: TestClient, library_id: str) -> None:
    updated = _set(gated_client, library_id, enabled=True)

    assert updated.status_code == 200
    assert updated.json()["enabled"] is True
    assert updated.json()["effective"] is True
    assert _gated(gated_client, library_id).status_code == 200

    # And disabling closes it again.
    assert _set(gated_client, library_id, enabled=False).status_code == 200
    assert _gated(gated_client, library_id).status_code == 403


def test_gate_404s_an_unknown_library(gated_client: TestClient) -> None:
    assert _gated(gated_client, "01JUNKJUNKJUNKJUNKJUNKJUNK").status_code == 404


# --- deployment master switch ------------------------------------------------
def test_deployment_switch_forces_read_only(gated_client: TestClient, library_id: str) -> None:
    assert _set(gated_client, library_id, enabled=True).status_code == 200

    with _deployment_write_mode("disabled"):
        # The library's own flag is reported honestly — the UI must be able to
        # say "on, but blocked here" rather than show a switch nobody turned off.
        state = gated_client.get(f"/api/v1/libraries/{library_id}/write-mode").json()
        assert state == {
            "enabled": True,
            "allowed_by_deployment": False,
            "effective": False,
            "requires_passphrase": False,
        }
        refused = _gated(gated_client, library_id)
        assert refused.status_code == 403
        assert refused.json()["details"] == {"reason": "deployment"}

    # Lifting the deployment switch restores the library's own answer.
    assert _gated(gated_client, library_id).status_code == 200


def test_deployment_switch_refuses_enabling(gated_client: TestClient, library_id: str) -> None:
    with _deployment_write_mode("disabled"):
        refused = _set(gated_client, library_id, enabled=True)

        assert refused.status_code == 403
        assert refused.json()["details"] == {"reason": "deployment"}
        assert gated_client.get(f"/api/v1/libraries/{library_id}/write-mode").json()["enabled"] is (
            False
        )


def test_invalid_deployment_switch_is_rejected_at_startup() -> None:
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CAIRNDEX_WRITE_MODE", "sure-why-not")
        get_settings.cache_clear()
        try:
            with pytest.raises(ValueError):
                get_settings()
        finally:
            get_settings.cache_clear()


def test_health_reports_the_deployment_switch(gated_client: TestClient) -> None:
    assert gated_client.get("/api/v1/health").json()["write_mode"] == "allowed"


# --- passphrase re-auth (ADR-0010 + ADR-0013) --------------------------------
def test_enabling_a_protected_library_re_prompts(
    gated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    protected = _make_library(tmp_path, registry_session, "protected", passphrase="open-sesame")

    # Locked: not even readable, let alone changeable without the passphrase.
    assert gated_client.get(f"/api/v1/libraries/{protected}/write-mode").status_code == 401
    assert _set(gated_client, protected, enabled=True).status_code == 401

    gated_client.post(
        f"/api/v1/libraries/{protected}/auth/unlock", json={"passphrase": "open-sesame"}
    )
    assert (
        gated_client.get(f"/api/v1/libraries/{protected}/write-mode").json()["requires_passphrase"]
        is True
    )

    # An unlocked session is not enough on its own — this is the re-auth.
    missing = _set(gated_client, protected, enabled=True)
    assert missing.status_code == 401
    assert missing.json()["code"] == "auth_required"

    # A wrong passphrase is refused identically; nothing distinguishes the two.
    wrong = _set(gated_client, protected, enabled=True, passphrase="guess")
    assert wrong.status_code == 401
    assert wrong.json()["message"] == missing.json()["message"]
    assert _gated(gated_client, protected).status_code == 403

    right = _set(gated_client, protected, enabled=True, passphrase="open-sesame")
    assert right.status_code == 200
    assert _gated(gated_client, protected).status_code == 200


def test_the_passphrase_authorizes_a_locked_library_on_its_own(
    gated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    """No unlock in this session, one prompt, and it works — otherwise enabling
    write mode on a locked library would cost two passphrase prompts."""
    protected = _make_library(tmp_path, registry_session, "never-unlocked", passphrase="pw")

    enabled = _set(gated_client, protected, enabled=True, passphrase="pw")

    assert enabled.status_code == 200
    assert enabled.json()["effective"] is True
    # The library is still locked for content — this authorized one request, not
    # a session.
    assert gated_client.get(f"/api/v1/libraries/{protected}/bundles/browse").status_code == 401


def test_disabling_never_asks_for_the_passphrase(
    gated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    """Giving up a capability is always safe, and a forgotten passphrase must
    never be able to strand a library in a writable state."""
    protected = _make_library(tmp_path, registry_session, "protected-off", passphrase="pw")
    gated_client.post(f"/api/v1/libraries/{protected}/auth/unlock", json={"passphrase": "pw"})
    assert _set(gated_client, protected, enabled=True, passphrase="pw").status_code == 200

    turned_off = _set(gated_client, protected, enabled=False)

    assert turned_off.status_code == 200
    assert turned_off.json()["enabled"] is False
    assert _gated(gated_client, protected).status_code == 403


def test_a_corrupt_manifest_cannot_be_written_to(
    gated_client: TestClient, registry_session: Session, tmp_path: Path
) -> None:
    """``is_protected`` fails closed, so an unreadable manifest reads as locked —
    and a library nobody can unlock is a library nobody can enable writes on."""
    library = _make_library(tmp_path, registry_session, "corrupt", passphrase=None)
    pkg.manifest_path(tmp_path / "corrupt").write_text("{broken", encoding="utf-8")

    assert _set(gated_client, library, enabled=True).status_code == 401


# --- registry schema ---------------------------------------------------------
def test_existing_registries_gain_the_write_mode_column(tmp_path: Path) -> None:
    """A registry created before ADR-0013 must come back read-only, not broken."""
    url = f"sqlite:///{(tmp_path / 'registry.db').as_posix()}"
    engine: Engine = create_registry_engine(database_url=url)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE registered_libraries DROP COLUMN write_mode_enabled"))
        conn.execute(
            text(
                "INSERT INTO registered_libraries "
                "(id, library_uuid, name, root_path, manifest_path, status, schema_version, "
                " created_at, updated_at) "
                "VALUES ('01LEGACY', '01LEGACYUUID', 'Legacy', '/tmp/legacy', "
                "        '/tmp/legacy/.cairndex/manifest.json', 'available', 1, "
                "        '2026-01-01T00:00:00', '2026-01-01T00:00:00')"
            )
        )
    engine.dispose()

    reopened = create_registry_engine(database_url=url)
    try:
        columns = {c["name"] for c in inspect(reopened).get_columns("registered_libraries")}
        assert "write_mode_enabled" in columns
        with reopened.connect() as conn:
            stored = conn.execute(
                text("SELECT write_mode_enabled FROM registered_libraries WHERE id = '01LEGACY'")
            ).scalar()
        assert not stored
    finally:
        reopened.dispose()
