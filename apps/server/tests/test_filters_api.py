"""API surface for Phase 5: filter preview, filtered browse, Smart Collection CRUD."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.services import bundles as bundle_service

_HIGH_RATED = {"version": 1, "root": {"field": "rating", "operator": "gte", "value": 4}}


def _seed(session: Session) -> None:
    bundle_service.create_bundle(session, title="keep", rating=5)
    bundle_service.create_bundle(session, title="drop", rating=1)
    session.commit()


def test_preview_counts_matches(client: TestClient, library_id: str, session: Session) -> None:
    _seed(session)
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(f"{base}/filters/preview", json={"filter": _HIGH_RATED})
    assert r.status_code == 200
    assert r.json() == {"count": 1}


def test_preview_invalid_filter_is_422(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(
        f"{base}/filters/preview",
        json={"filter": {"version": 1, "root": {"field": "nope", "operator": "eq", "value": 1}}},
    )
    assert r.status_code == 422


def test_browse_post_with_filter(client: TestClient, library_id: str, session: Session) -> None:
    _seed(session)
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(f"{base}/bundles/browse", json={"filter": _HIGH_RATED})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "keep"


def test_browse_post_no_filter_matches_all(
    client: TestClient, library_id: str, session: Session
) -> None:
    _seed(session)
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(f"{base}/bundles/browse", json={})
    assert r.status_code == 200
    assert r.json()["total"] == 2


def test_smart_collection_crud(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    created = client.post(
        f"{base}/smart-collections",
        json={"name": "Highly rated", "filter": _HIGH_RATED},
    )
    assert created.status_code == 201
    sc = created.json()
    assert sc["name"] == "Highly rated"
    assert sc["filter"]["root"]["field"] == "rating"

    listed = client.get(f"{base}/smart-collections")
    assert [x["id"] for x in listed.json()] == [sc["id"]]

    patched = client.patch(f"{base}/smart-collections/{sc['id']}", json={"name": "Renamed"})
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed"

    deleted = client.delete(f"{base}/smart-collections/{sc['id']}")
    assert deleted.status_code == 204
    assert client.get(f"{base}/smart-collections/{sc['id']}").status_code == 404


def test_smart_collection_invalid_filter_is_422(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(
        f"{base}/smart-collections",
        json={
            "name": "bad",
            "filter": {"version": 1, "root": {"field": "nope", "operator": "eq", "value": 1}},
        },
    )
    assert r.status_code == 422


# Name/layout edits and stale writes must preserve the accepted nested expression
def test_nested_rules_survive_unrelated_and_stale_saves(
    client: TestClient, library_id: str
) -> None:
    base = f"/api/v1/libraries/{library_id}"
    expr = {
        "version": 1,
        "root": {
            "op": "not",
            "child": {
                "op": "or",
                "children": [
                    _HIGH_RATED["root"],
                    {
                        "op": "and",
                        "children": [
                            {"field": "title", "operator": "contains", "value": "Amber"},
                            {"field": "has_missing", "operator": "equals", "value": True},
                        ],
                    },
                ],
            },
        },
    }
    created = client.post(f"{base}/smart-collections", json={"name": "Nested", "filter": expr})
    assert created.status_code == 201
    original = created.json()
    url = f"{base}/smart-collections/{original['id']}"
    renamed = client.patch(
        url,
        json={"name": "Renamed", "default_layout": "list"},
        headers={"If-Match": str(original["version"])},
    )
    assert renamed.status_code == 200
    assert renamed.json()["filter"] == original["filter"]
    newer = client.patch(
        url, json={"filter": _HIGH_RATED}, headers={"If-Match": str(renamed.json()["version"])}
    )
    assert newer.status_code == 200
    stale = client.patch(
        url, json={"name": "Stale", "filter": expr}, headers={"If-Match": str(original["version"])}
    )
    assert stale.status_code == 409
    assert client.get(url).json() == newer.json()


# Preview and browse share every visibility boundary, including empty bundles
def test_preview_matches_browse_population(
    client: TestClient, library_id: str, session: Session
) -> None:
    from cairndex.domain.enums import (
        FileAvailability,
        FileRole,
        GroupingSource,
        GroupingState,
        MediaKind,
    )

    expected = []
    for title, paths, staged in [
        ("Empty", [], False),
        ("Provisional", ["staged.mp4"], True),
        ("Hidden", [".hidden.mp4", "dir/.hidden/clip.mp4"], False),
        ("Missing", ["gone.mp4"], False),
        ("Confirmed", ["visible.mp4"], False),
        ("Mixed", [".sidecar", "mixed.mp4"], False),
    ]:
        bundle = bundle_service.create_bundle(session, title=title, rating=5)
        if staged:
            bundle.grouping_state = GroupingState.PROVISIONAL
            bundle.grouping_source = GroupingSource.SCAN_SUGGESTION
        for path in paths:
            file = bundle_service.add_file(
                session,
                bundle.id,
                relative_path=path,
                role=FileRole.PRIMARY_VIDEO,
                media_kind=MediaKind.VIDEO,
            )
            if title == "Missing":
                file.availability = FileAvailability.MISSING
        if title not in {"Provisional", "Hidden"}:
            expected.append(bundle.id)
    session.commit()
    base = f"/api/v1/libraries/{library_id}"
    for expr in (_HIGH_RATED, {"version": 1, "root": None}):
        preview = client.post(f"{base}/filters/preview", json={"filter": expr})
        browse = client.post(f"{base}/bundles/browse", json={"filter": expr})
        assert preview.status_code == browse.status_code == 200
        assert preview.json()["count"] == browse.json()["total"] == len(expected)
        assert {row["id"] for row in browse.json()["items"]} == set(expected)
    empty = client.post(
        f"{base}/filters/preview",
        json={
            "filter": {
                "version": 1,
                "root": {"field": "rating", "operator": "lt", "value": 1},
            }
        },
    )
    assert empty.json() == {"count": 0}


# Execute each published AST example against preview, save and browse contracts
def test_documented_filter_examples(client: TestClient, library_id: str) -> None:
    import json
    import re
    from pathlib import Path

    doc = Path(__file__).resolve().parents[3] / "docs" / "filter-language.md"
    examples = re.findall(r"```json\n(.*?)\n```", doc.read_text(), re.DOTALL)
    assert examples
    base = f"/api/v1/libraries/{library_id}"
    for index, example in enumerate(examples):
        expr = json.loads(example)
        assert client.post(f"{base}/filters/preview", json={"filter": expr}).status_code == 200
        assert client.post(f"{base}/bundles/browse", json={"filter": expr}).status_code == 200
        assert (
            client.post(
                f"{base}/smart-collections",
                json={
                    "name": f"Example {index}",
                    "filter": expr,
                },
            ).status_code
            == 201
        )


# Invalid value shapes must fail at the API boundary instead of reaching SQLite
@pytest.mark.parametrize(
    "field, operator, value",
    [
        ("title", "contains", None),
        ("notes", "contains", []),
        ("rating", "gte", None),
        ("rating", "eq", True),
        ("rating", "between", [1, "high"]),
        ("size_bytes", "between", [None, 3]),
        ("file_count", "between", [[1], 3]),
        ("date_added", "between", ["2026-01-01", None]),
        ("tags", "contains_any", [None]),
        ("collections", "contains_all", [{}]),
        ("extension", "equals", None),
        ("extension", "in", [2]),
        ("has_cover", "equals", None),
        ("has_missing", "eq", True),
    ],
)
def test_invalid_predicate_values_are_422(
    client: TestClient, library_id: str, field: str, operator: str, value: object
) -> None:
    base = f"/api/v1/libraries/{library_id}"
    expr = {"version": 1, "root": {"field": field, "operator": operator, "value": value}}
    assert client.post(f"{base}/filters/preview", json={"filter": expr}).status_code == 422
    assert (
        client.post(
            f"{base}/smart-collections", json={"name": "Invalid", "filter": expr}
        ).status_code
        == 422
    )
