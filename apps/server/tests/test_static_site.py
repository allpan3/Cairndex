"""The backend serves the built SPA when CAIRNDEX_STATIC_DIR is set.

This is the production single-container path (docs/deployment.md): FastAPI
keeps owning ``/api/v1`` while serving ``index.html`` for client routes.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cairndex.core.config import get_settings
from cairndex.main import create_app


@pytest.fixture
def static_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Cairndex</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('cairndex')", encoding="utf-8")
    (dist / "favicon.ico").write_text("icon", encoding="utf-8")

    monkeypatch.setenv("CAIRNDEX_STATIC_DIR", str(dist))
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            yield client
    finally:
        get_settings.cache_clear()


def test_root_serves_spa_shell(static_client: TestClient) -> None:
    response = static_client.get("/")

    assert response.status_code == 200
    assert "Cairndex" in response.text


def test_unknown_client_route_falls_back_to_index(static_client: TestClient) -> None:
    # A deep link refreshed in the browser must return the SPA shell, not 404,
    # so the client router can resolve it.
    response = static_client.get("/folders/anything")

    assert response.status_code == 200
    assert "Cairndex" in response.text


def test_hashed_asset_is_served_directly(static_client: TestClient) -> None:
    response = static_client.get("/assets/app.js")

    assert response.status_code == 200
    assert "cairndex" in response.text


def test_root_file_is_served(static_client: TestClient) -> None:
    response = static_client.get("/favicon.ico")

    assert response.status_code == 200
    assert response.text == "icon"


def test_api_still_wins_over_static(static_client: TestClient) -> None:
    response = static_client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_unknown_api_path_stays_json_404(static_client: TestClient) -> None:
    # Unmatched /api/* must not be answered with the HTML shell.
    response = static_client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert "Cairndex" not in response.text
