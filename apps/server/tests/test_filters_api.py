"""API surface for Phase 5: filter preview, filtered browse, Smart Folder CRUD."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.services import bundles as bundle_service

_HIGH_RATED = {"version": 1, "root": {"field": "rating", "operator": "gte", "value": 4}}


def _seed(session: Session) -> None:
    bundle_service.create_bundle(session, title="keep", rating=5)
    bundle_service.create_bundle(session, title="drop", rating=1)
    session.commit()


def test_preview_counts_matches(client: TestClient, session: Session) -> None:
    _seed(session)
    r = client.post("/api/v1/filters/preview", json={"filter": _HIGH_RATED})
    assert r.status_code == 200
    assert r.json() == {"count": 1}


def test_preview_invalid_filter_is_422(client: TestClient, session: Session) -> None:
    r = client.post(
        "/api/v1/filters/preview",
        json={"filter": {"version": 1, "root": {"field": "nope", "operator": "eq", "value": 1}}},
    )
    assert r.status_code == 422


def test_browse_post_with_filter(client: TestClient, session: Session) -> None:
    _seed(session)
    r = client.post("/api/v1/bundles/browse", json={"filter": _HIGH_RATED})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "keep"


def test_browse_post_no_filter_matches_all(client: TestClient, session: Session) -> None:
    _seed(session)
    r = client.post("/api/v1/bundles/browse", json={})
    assert r.status_code == 200
    assert r.json()["total"] == 2


def test_smart_folder_crud(client: TestClient, session: Session) -> None:
    created = client.post(
        "/api/v1/smart-folders",
        json={"name": "Highly rated", "filter": _HIGH_RATED},
    )
    assert created.status_code == 201
    sf = created.json()
    assert sf["name"] == "Highly rated"
    assert sf["filter"]["root"]["field"] == "rating"

    listed = client.get("/api/v1/smart-folders")
    assert [x["id"] for x in listed.json()] == [sf["id"]]

    patched = client.patch(f"/api/v1/smart-folders/{sf['id']}", json={"name": "Renamed"})
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/v1/smart-folders/{sf['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/smart-folders/{sf['id']}").status_code == 404


def test_smart_folder_invalid_filter_is_422(client: TestClient) -> None:
    r = client.post(
        "/api/v1/smart-folders",
        json={
            "name": "bad",
            "filter": {"version": 1, "root": {"field": "nope", "operator": "eq", "value": 1}},
        },
    )
    assert r.status_code == 422
