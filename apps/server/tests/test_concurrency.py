"""Optimistic-concurrency (ADR-0008 phase 9).

Frequently edited entities carry a ``version`` counter. Edits may send the
version they last read via the ``If-Match`` header; a stale value is rejected
with 409 (``version_conflict``) and nothing is mutated. Without ``If-Match``
edits are last-write-wins so existing clients keep working.
"""

from fastapi.testclient import TestClient


def _base(library_id: str) -> str:
    return f"/api/v1/libraries/{library_id}"


def test_bundle_version_starts_at_one_and_increments(client: TestClient, library_id: str) -> None:
    base = _base(library_id)
    bundle = client.post(f"{base}/bundles", json={"title": "a"}).json()
    assert bundle["version"] == 1

    updated = client.patch(f"{base}/bundles/{bundle['id']}", json={"title": "b"}).json()
    assert updated["version"] == 2


def test_if_match_matching_version_succeeds(client: TestClient, library_id: str) -> None:
    base = _base(library_id)
    bundle = client.post(f"{base}/bundles", json={"title": "a"}).json()

    resp = client.patch(
        f"{base}/bundles/{bundle['id']}",
        json={"title": "b"},
        headers={"If-Match": str(bundle["version"])},
    )
    assert resp.status_code == 200
    assert resp.json()["version"] == 2


def test_if_match_stale_version_conflicts_without_mutating(
    client: TestClient, library_id: str
) -> None:
    base = _base(library_id)
    bundle = client.post(f"{base}/bundles", json={"title": "a"}).json()
    # Someone else edits first, bumping the version to 2.
    client.patch(f"{base}/bundles/{bundle['id']}", json={"title": "b"})

    # We still hold version 1 -> 409, and the title is left untouched.
    resp = client.patch(
        f"{base}/bundles/{bundle['id']}",
        json={"title": "c"},
        headers={"If-Match": "1"},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "version_conflict"

    current = client.get(f"{base}/bundles/{bundle['id']}").json()
    assert current["title"] == "b"
    assert current["version"] == 2


def test_no_if_match_is_last_write_wins(client: TestClient, library_id: str) -> None:
    base = _base(library_id)
    bundle = client.post(f"{base}/bundles", json={"title": "a"}).json()
    client.patch(f"{base}/bundles/{bundle['id']}", json={"title": "b"})

    # No precondition header -> the edit applies regardless of version drift.
    resp = client.patch(f"{base}/bundles/{bundle['id']}", json={"title": "c"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "c"
    assert resp.json()["version"] == 3


def test_collection_tag_and_smart_collection_enforce_if_match(
    client: TestClient, library_id: str
) -> None:
    base = _base(library_id)

    collection = client.post(f"{base}/collections", json={"name": "Films"}).json()
    assert collection["version"] == 1
    tag = client.post(f"{base}/tags", json={"name": "genre"}).json()
    assert tag["version"] == 1
    smart = client.post(
        f"{base}/smart-collections",
        json={
            "name": "Recent",
            "filter": {"version": 1, "root": {"field": "rating", "operator": "gte", "value": 4}},
        },
    ).json()
    assert smart["version"] == 1

    # Each: a matching If-Match bumps to 2, then a stale retry conflicts.
    for url, body in (
        (f"{base}/collections/{collection['id']}", {"name": "Movies"}),
        (f"{base}/tags/{tag['id']}", {"name": "category"}),
        (
            f"{base}/smart-collections/{smart['id']}",
            {"name": "Newest"},
        ),
    ):
        ok = client.patch(url, json=body, headers={"If-Match": "1"})
        assert ok.status_code == 200, url
        assert ok.json()["version"] == 2

        stale = client.patch(url, json=body, headers={"If-Match": "1"})
        assert stale.status_code == 409, url
        assert stale.json()["code"] == "version_conflict"
