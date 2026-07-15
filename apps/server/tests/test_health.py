import pytest
from fastapi.testclient import TestClient

from cairndex.core.config import get_settings
from cairndex.main import app, create_app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["app_name"] == "Cairndex"
    assert body["api_features"] == ["trickplay", "hls", "progress", "pairing"]


def test_health_is_unversioned_outside_v1() -> None:
    response = client.get("/health")

    assert response.status_code == 404


def test_tauri_origins_can_reach_the_versioned_api() -> None:
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]:
        response = client.options(
            "/api/v1/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )

        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
        assert "access-control-allow-credentials" not in response.headers


@pytest.mark.parametrize("origin", ["http://127.0.0.1:5173", "https://example.invalid"])
def test_unlisted_web_origins_are_not_allowed(origin: str) -> None:
    response = client.options(
        "/api/v1/health",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_tauri_dev_origin_requires_explicit_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "CAIRNDEX_CORS_EXTRA_ORIGINS",
        "http://127.0.0.1:5173, https://dev.example/",
    )
    get_settings.cache_clear()
    try:
        configured_client = TestClient(create_app())
        response = configured_client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "DELETE",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert get_settings().cors_extra_origins == [
            "http://127.0.0.1:5173",
            "https://dev.example",
        ]
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
        assert "access-control-allow-credentials" not in response.headers
    finally:
        get_settings.cache_clear()
