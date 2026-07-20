"""Loopback owner token and media-tool resolution for the desktop sidecar.

Plan 3 D6 / ADR-0018 §5. Both concern a server the desktop shell spawns rather
than one a person starts from a shell, which is a different environment in two
ways: nobody is present to approve a pairing, and there is barely any ``PATH``.
"""

import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.api.deps import get_registry_access, get_registry_db
from cairndex.auth.local_token import is_local_owner_token, local_token, sidecar_mode
from cairndex.core.config import get_settings
from cairndex.main import create_app
from cairndex.media import tool_paths

TOKEN = "sidecar-token-abcdef0123456789"


@pytest.fixture
def sidecar_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CAIRNDEX_LOCAL_TOKEN", TOKEN)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def sidecar_client(sidecar_env: None, registry_session: Session) -> Iterator[TestClient]:
    """A client against a server built in sidecar mode (token gate registered)."""
    from tests.conftest import _registry_access_override

    app = create_app()

    def _override_get_registry_db() -> Iterator[Session]:
        try:
            yield registry_session
            registry_session.commit()
        except Exception:
            registry_session.rollback()
            raise

    app.dependency_overrides[get_registry_db] = _override_get_registry_db
    app.dependency_overrides[get_registry_access] = lambda: _registry_access_override(
        registry_session
    )
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


# --- the token itself -----------------------------------------------------


def test_an_ordinary_server_is_not_in_sidecar_mode() -> None:
    """A NAS or container deployment must be completely unaffected."""
    assert sidecar_mode() is False
    assert local_token() is None
    assert is_local_owner_token("anything") is False


def test_sidecar_mode_activates_from_the_environment(sidecar_env: None) -> None:
    assert sidecar_mode() is True
    assert is_local_owner_token(TOKEN) is True


def test_a_wrong_token_is_rejected(sidecar_env: None) -> None:
    assert is_local_owner_token(TOKEN + "x") is False
    assert is_local_owner_token("") is False


def test_a_blank_configured_token_does_not_enable_sidecar_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whitespace must not become a server that accepts an empty bearer."""
    monkeypatch.setenv("CAIRNDEX_LOCAL_TOKEN", "   ")
    get_settings.cache_clear()
    try:
        assert sidecar_mode() is False
        assert is_local_owner_token("") is False
        assert is_local_owner_token("   ") is False
    finally:
        get_settings.cache_clear()


# --- the whole-server gate ------------------------------------------------


def test_an_unauthenticated_api_request_is_refused(sidecar_client: TestClient) -> None:
    """A loopback port is reachable by any local process, so this is the gate."""
    resp = sidecar_client.get("/api/v1/libraries")

    assert resp.status_code == 401
    assert resp.json()["code"] == "local_token_required"


def test_the_owner_token_is_accepted(sidecar_client: TestClient) -> None:
    resp = sidecar_client.get("/api/v1/libraries", headers={"Authorization": f"Bearer {TOKEN}"})
    assert resp.status_code == 200


def test_a_wrong_bearer_is_refused_by_the_gate(sidecar_client: TestClient) -> None:
    resp = sidecar_client.get("/api/v1/libraries", headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401


@pytest.mark.parametrize("header", ["", "Basic abc", "Bearer", "Token " + TOKEN, TOKEN])
def test_malformed_authorization_headers_are_refused(
    sidecar_client: TestClient, header: str
) -> None:
    resp = sidecar_client.get("/api/v1/libraries", headers={"Authorization": header})
    assert resp.status_code == 401


def test_health_stays_open_so_the_shell_can_wait_for_readiness(
    sidecar_client: TestClient,
) -> None:
    """The shell polls this before it has reason to trust what it just spawned."""
    resp = sidecar_client.get("/api/v1/health")

    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_the_gate_is_absent_on_an_ordinary_server(isolated_client: TestClient) -> None:
    assert isolated_client.get("/api/v1/libraries").status_code == 200


# --- the passphrase still applies -----------------------------------------


def test_the_local_token_does_not_unlock_a_protected_library(
    sidecar_client: TestClient, tmp_path: Path
) -> None:
    """ADR-0018 §5, deliberately unlike a paired device token.

    A device token may stand in for a passphrase because pairing is approved
    from an already-unlocked owner session. The local token is minted with no
    ceremony at all, so a locked library must stay locked.
    """
    from cairndex.auth.library_auth import set_passphrase

    root = tmp_path / "locked"
    root.mkdir()
    auth = {"Authorization": f"Bearer {TOKEN}"}
    created = sidecar_client.post(
        "/api/v1/libraries/create",
        json={"root_path": str(root), "display_name": "Locked"},
        headers=auth,
    )
    assert created.status_code == 201, created.text
    library_id = created.json()["id"]

    # Reachable before the lock is set.
    before = sidecar_client.get(f"/api/v1/libraries/{library_id}/collections", headers=auth)
    assert before.status_code == 200, before.text

    from cairndex.registry.engine import registry_session_scope

    with registry_session_scope() as registry:
        set_passphrase(root, "hunter2", registry=registry)

    resp = sidecar_client.get(f"/api/v1/libraries/{library_id}/collections", headers=auth)

    assert resp.status_code == 401
    assert resp.json()["code"] == "auth_required"


# --- media tool resolution ------------------------------------------------


def make_executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_an_explicitly_configured_ffmpeg_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What the shell sets when it points the sidecar at bundled binaries."""
    bundled = make_executable(tmp_path / "ffmpeg")
    monkeypatch.setenv("CAIRNDEX_FFMPEG_PATH", str(bundled))
    get_settings.cache_clear()
    try:
        assert tool_paths.ffmpeg_path() == str(bundled)
    finally:
        get_settings.cache_clear()


def test_a_configured_path_that_is_not_executable_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fall through to discovery rather than failing outright on a stale config."""
    not_executable = tmp_path / "ffmpeg"
    not_executable.write_text("", encoding="utf-8")
    monkeypatch.setenv("CAIRNDEX_FFMPEG_PATH", str(not_executable))
    get_settings.cache_clear()
    try:
        assert tool_paths.ffmpeg_path() != str(not_executable)
    finally:
        get_settings.cache_clear()


def test_path_is_used_when_nothing_is_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    on_path = make_executable(tmp_path / "ffprobe")
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(tool_paths, "_FALLBACK_PREFIXES", ())
    get_settings.cache_clear()
    try:
        assert tool_paths.ffprobe_path() == str(on_path)
    finally:
        get_settings.cache_clear()


def test_a_conventional_prefix_rescues_an_empty_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Finder-launch case: launchd gives a GUI app a PATH with no Homebrew.

    Without this fallback a desktop-spawned sidecar reports "ffmpeg not found"
    on a machine that plainly has ffmpeg installed.
    """
    prefix = tmp_path / "opt-homebrew-bin"
    prefix.mkdir()
    installed = make_executable(prefix / "ffmpeg")
    monkeypatch.setenv("PATH", "/nonexistent-for-this-test")
    monkeypatch.setattr(tool_paths, "_FALLBACK_PREFIXES", (str(prefix),))
    get_settings.cache_clear()
    try:
        assert tool_paths.ffmpeg_path() == str(installed)
    finally:
        get_settings.cache_clear()


def test_a_missing_tool_reports_none_rather_than_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", "/nonexistent-for-this-test")
    monkeypatch.setattr(tool_paths, "_FALLBACK_PREFIXES", ())
    get_settings.cache_clear()
    try:
        assert tool_paths.ffmpeg_path() is None
        assert tool_paths.ffprobe_path() is None
    finally:
        get_settings.cache_clear()


def test_path_entries_that_are_directories_are_not_mistaken_for_binaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "ffmpeg").mkdir()  # a directory named like the tool
    monkeypatch.setenv("PATH", "/nonexistent-for-this-test")
    monkeypatch.setattr(tool_paths, "_FALLBACK_PREFIXES", (str(tmp_path),))
    get_settings.cache_clear()
    try:
        assert tool_paths.ffmpeg_path() is None
    finally:
        get_settings.cache_clear()


def test_os_access_is_what_decides_executability(tmp_path: Path) -> None:
    """Guard the assumption the resolver rests on."""
    candidate = make_executable(tmp_path / "ffmpeg")
    assert os.access(candidate, os.X_OK)
