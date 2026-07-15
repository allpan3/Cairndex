from fastapi.testclient import TestClient

from cairndex.main import app

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
        "http://127.0.0.1:5173",
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


def test_unlisted_web_origins_are_not_allowed() -> None:
    response = client.options(
        "/api/v1/health",
        headers={
            "Origin": "https://example.invalid",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
