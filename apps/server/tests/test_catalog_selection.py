"""Bulk reviews retain displayed bases, exact targets and retry identities."""

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.selection import (
    CatalogBulkMembershipRequest,
    CatalogSelectionRequest,
    choices,
    selection,
)
from cairndex.replicas.protocol import ReplicaError
from tests.test_catalog_inspector import commit
from tests.test_replica_catalog import edit, save
from tests.test_replica_catalog_api import api  # noqa: F401

IDS = ["bundle-000000", "bundle-000001"]


@pytest.fixture
def store(tmp_path):
    return prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store


def scalar(store, field="title", value="Selected title"):
    items = selection(store, CatalogSelectionRequest(ids=IDS)).items
    return {
        "action": "bulk",
        "ids": IDS,
        "field": field,
        "value": value,
        "observed": {
            unit: basis
            for item in items
            for unit, basis in item.observed.items()
            if unit.endswith(f"/{field}") or unit.endswith("/$alive")
        },
    }


def membership(store, family="tags", assigned=True):
    page = choices(store, CatalogBulkMembershipRequest(ids=IDS, family=family))
    item = next(item for item in page.items if item.id == f"{family}-child")
    return {
        "action": "bulk",
        "ids": IDS,
        "field": family,
        "target": item.id,
        "assigned": assigned,
        "observed": item.observed,
    }


def test_scalar_review_stale_atomic_and_unrelated_notes(store):
    save(store, edit(store, "asset_bundles", IDS[1], "notes", '["Independent note"]'), "note")
    intent = scalar(store)
    result = preview(store, intent)
    assert not any(item["unit"].endswith("/notes") for item in result["changes"])
    commit(store, result, "bulk-title")
    for identity in IDS:
        assert (
            store.entity("asset_bundles", identity)["fields"]["title"]["value"]
            == '"Selected title"'
        )
    assert (
        store.entity("asset_bundles", "bundle-000002")["fields"]["title"]["value"]
        != '"Selected title"'
    )
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, intent)
    stale = scalar(store, "rating", 3.5)
    save(store, edit(store, "asset_bundles", IDS[1], "rating", 2), "peer-rating")
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, stale)
    assert store.entity("asset_bundles", IDS[0])["fields"]["rating"]["value"] != "3.5"


@pytest.mark.parametrize("family", ["tags", "collections"])
def test_membership_mixed_add_remove_restore(store, family):
    if family == "collections":
        save(store, edit(store, family, "collections-child", "cover_bundle_id", IDS[0]), "cover")
    for assigned in (True, False, True):
        intent = membership(store, family, assigned)
        result = preview(store, intent)
        if not assigned and family == "collections":
            assert any(
                item["unit"].endswith("/cover_bundle_id") and item["value"] == "null"
                for item in result["changes"]
            )
        commit(store, result, f"membership-{assigned}-{result['recover']}")
        count = next(
            item.assigned_count
            for item in choices(store, CatalogBulkMembershipRequest(ids=IDS, family=family)).items
            if item.id == f"{family}-child"
        )
        assert count == (2 if assigned else 0)
        with pytest.raises(ReplicaError, match="changed"):
            preview(store, intent)


def test_bulk_preview_retry_and_conflict_after_review(store):
    intent = scalar(store)
    jobs.enqueue(store, "bulk-preview", "preview", intent)
    jobs.run_one(store)
    prepared = jobs.job(store, "bulk-preview")
    assert prepared["state"] == "succeeded"
    assert jobs.enqueue(store, "bulk-preview", "preview", intent) == prepared
    with pytest.raises(ReplicaError, match="reused"):
        jobs.enqueue(store, "bulk-preview", "preview", scalar(store, value="Other"))
    save(store, edit(store, "asset_bundles", IDS[1], "title", "Peer title"), "peer-title")
    body = {"job": prepared["id"], "receipt": prepared["receipt"]}
    jobs.enqueue(store, "bulk-commit", "commit_preview", body)
    jobs.run_one(store)
    result = jobs.job(store, "bulk-commit")
    assert result["state"] == "succeeded"
    assert store.entity("asset_bundles", IDS[1])["has_conflicts"]
    assert jobs.enqueue(store, "bulk-commit", "commit_preview", body) == result


def test_bulk_api_bounds_and_membership_pages(api):  # noqa: F811
    client, base, _ = api
    base += "/replica/catalog"
    for ids in ([], IDS * 2, [f"bundle-{i}" for i in range(101)]):
        assert client.post(base + "/bundles/selection", json={"ids": ids}).status_code == 422
    assert len(client.post(base + "/bundles/selection", json={"ids": IDS}).json()["items"]) == 2
    body = {"ids": IDS, "family": "tags", "limit": 1}
    first = client.post(base + "/bundles/selection/memberships", json=body).json()
    second = client.post(
        base + "/bundles/selection/memberships", json=body | {"after": first["next_cursor"]}
    ).json()
    assert first["items"][0]["assigned_count"] == 1
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert (
        client.post(base + "/bundles/selection/memberships", json=body | {"q": "root"}).json()[
            "items"
        ][0]["name"]
        == "Synthetic root"
    )


@pytest.mark.parametrize(
    "field,value", [("rating", 3.3), ("rating", 6), ("rating", "4"), ("title", ""), ("notes", "x")]
)
def test_bulk_rejects_invalid_scalar(store, field, value):
    with pytest.raises((ReplicaError, ValueError)):
        preview(store, scalar(store, field, value))


def test_bulk_remove_guards_absent_pairs_and_rejects_deleted_target(store):
    result = preview(store, membership(store, assigned=False))
    assert any(
        item["unit"] == "asset_bundle_tags/bundle-000001~tags-child/$alive"
        and item["value"] == "false"
        for item in result["changes"]
    )
    commit(store, result, "mixed-remove")
    commit(store, preview(store, membership(store, assigned=True)), "mixed-restore")
    intent = scalar(store)
    commit(
        store,
        preview(store, {"action": "delete", "family": "asset_bundles", "entity": IDS[1]}),
        "delete",
    )
    with pytest.raises(ReplicaError, match="changed|unavailable"):
        preview(store, intent)
