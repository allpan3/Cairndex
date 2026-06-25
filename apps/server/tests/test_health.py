from fastapi.testclient import TestClient

from cairndex.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["app_name"] == "Cairndex"


def test_health_is_unversioned_outside_v1() -> None:
    response = client.get("/health")

    assert response.status_code == 404
