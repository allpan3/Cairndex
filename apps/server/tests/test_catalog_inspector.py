"""Inspector choices retain exact bases and never turn local observations into metadata."""

import pytest

from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.inspector import memberships
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.protocol import ReplicaError
from tests.test_replica_catalog import edit, save
from tests.test_replica_catalog_api import api  # noqa: F401
from tests.test_replica_media import authored, media_api, specimen  # noqa: F401


def choice(store, family, target, assigned):
    item = next(
        item
        for item in memberships(store, "bundle-000000", family, "", 30, "", False).items
        if item.id == target
    )
    return {
        "action": "membership",
        "family": family,
        "bundle": "bundle-000000",
        "target": target,
        "assigned": assigned,
        "observed": item.observed,
    }


def commit(store, result, operation):
    return store.save(
        [UnitChange.model_validate(item) for item in result["changes"]],
        operation,
        parents=result["parents"],
        resolve=result["resolve"],
        recover=result["recover"],
    )


@pytest.mark.parametrize("family", ["tags", "collections"])
def test_membership_remove_restore_and_stale_review(api, family):  # noqa: F811
    client, base, store = api
    assert client.get(base + "/replica/status").json()["inspector_version"] == 1
    target = f"{family}-child"
    path = base + f"/replica/catalog/bundles/bundle-000000/memberships/{family}"
    assert client.get(path + "?assigned=true").json()["items"][0]["id"] == target
    intent = choice(store, family, target, False)
    commit(store, preview(store, intent), "remove-membership")
    assert client.get(path + "?assigned=true").json()["items"] == []
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, intent)
    restoration = preview(store, choice(store, family, target, True))
    assert restoration["recover"] is True
    commit(store, restoration, "restore-membership")
    assert client.get(path + "?assigned=true").json()["items"][0]["assigned"]
    # Pages and search cover all choices, without only searching the first client page.
    first = client.get(path + "?limit=1").json()
    second = client.get(path, params={"limit": 1, "after": first["next_cursor"]}).json()
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert client.get(path + "?q=root&limit=1").json()["items"][0]["name"] == "Synthetic root"
    assert first["items"][0]["path"] == ["Synthetic root", "Synthetic child"]
    assert client.get(path + "?limit=51").status_code == 422


def test_membership_preview_keeps_collection_cover_cascade(api):  # noqa: F811
    _, _, store = api
    save(
        store,
        edit(store, "collections", "collections-child", "cover_bundle_id", "bundle-000000"),
        "cover",
    )
    result = preview(store, choice(store, "collections", "collections-child", False))
    assert any(
        item["unit"] == "collections/collections-child/cover_bundle_id" and item["value"] == "null"
        for item in result["changes"]
    )
    commit(store, result, "remove-covered-membership")
    assert (
        store.entity("collections", "collections-child")["fields"]["cover_bundle_id"]["value"]
        == "null"
    )


def test_bundle_cover_derivative_is_private_and_source_guarded(media_api):  # noqa: F811
    client, base, store, _, roots = media_api
    before = authored(store)
    image = client.get(base + "/replica/media/files/media-image").json()
    assert image["file"]["tech_metadata"] == {"width": 640, "height": 360}
    response = client.get(base + "/bundles/bundle-000001/thumbnail")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert authored(store) == before
    # The automatic cover is the first image, independent of the playback cursor.
    summary = client.post(base + "/replica/catalog/bundles/browse", json={}).json()
    item = next(item for item in summary["items"] if item["id"] == "bundle-000001")
    assert item["cover_file_id"] == "media-image"
    (roots[0] / "Playback/picture.png").unlink()
    (roots[0] / "Playback/picture.png").symlink_to(roots[0] / "Playback/movie.mp4")
    assert client.get(base + "/bundles/bundle-000001/thumbnail").status_code == 404
    assert authored(store) == before
