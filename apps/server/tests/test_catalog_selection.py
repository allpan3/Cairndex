"""Bulk reviews retain displayed bases, exact targets and retry identities."""

import json

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
    # A context menu reads one known destination without paging
    target = second["items"][0]["id"]
    only = client.post(
        base + "/bundles/selection/memberships", json=body | {"target": target}
    ).json()
    assert ([item["id"] for item in only["items"]], only["next_cursor"]) == ([target], None)
    status = client.get(base.removesuffix("/catalog") + "/status").json()
    assert status["selection_version"] == 2


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


def test_dissolve_returns_files_to_unbundled_with_their_identities(store):
    from cairndex.replicas.catalog.browse import CatalogUnbundledRequest, unbundled
    from cairndex.replicas.catalog.projection import read_row

    commit(store, preview(store, {"action": "dissolve", "ids": IDS}), "dissolve")

    def alive(family, identity):
        return store.entity(family, identity)["fields"]["$alive"]["value"]

    assert alive("asset_bundles", IDS[0]) == alive("asset_bundles", IDS[1]) == "false"
    with store.connection(readonly=True) as db:
        page = unbundled(db, CatalogUnbundledRequest())
        staged = {item.id: item.bundle_id for item in page.items}
        # Each file has its own staging bundle, named by its stem, and its moment follows it
        assert set(staged) == {"file-video", "file-subtitle"}
        assert len(set(staged.values())) == 2
        assert read_row(db, "moments", "moment-one")["bundle_id"] == staged["file-video"]
        bundle = read_row(db, "asset_bundles", staged["file-video"])
        assert (bundle["title"], bundle["grouping_state"]) == ("雪", "PROVISIONAL")
    # A pairing of two files cannot follow both, and the folder member goes with the bundle
    assert alive("subtitle_tracks", "track-one") == "false"
    assert alive("bundle_directory_members", "directory-one") == "false"
    assert alive("moments", "moment-one") == "true"

    # An Unbundled staging bundle is deleted with its file
    commit(
        store,
        preview(store, {"action": "dissolve", "ids": [staged["file-subtitle"]]}),
        "drop-loose-file",
    )
    assert alive("asset_files", "file-subtitle") == "false"
    assert alive("asset_files", "file-video") == "true"
    with pytest.raises(ReplicaError, match="absent"):
        preview(store, {"action": "dissolve", "ids": [IDS[0]]})


def test_manual_order_moves_and_cleanups_write_only_changed_positions(store):
    from cairndex.replicas.catalog.browse import scope_order

    def order(collection=None):
        with store.connection(readonly=True) as db:
            return scope_order(db, collection, "manual", "asc")

    def positions(result):
        return sorted(
            item["unit"] for item in result["changes"] if not item["unit"].endswith("/$alive")
        )

    assert order() == ["bundle-000000", "bundle-000001", "bundle-000002"]
    moved = {"action": "order", "collection": None, "moved": ["bundle-000002"]}
    commit(store, preview(store, moved | {"before": "bundle-000000"}), "move")
    assert order() == ["bundle-000002", "bundle-000000", "bundle-000001"]
    # The new first bundle keeps position 0, so only the other two are written
    cleanup = preview(
        store, {"action": "order", "collection": None, "sort": "title", "descending": True}
    )
    assert positions(cleanup) == [
        "asset_bundles/bundle-000000/manual_order",
        "asset_bundles/bundle-000001/manual_order",
    ]
    commit(store, cleanup, "cleanup")
    assert order() == ["bundle-000002", "bundle-000001", "bundle-000000"]
    again = {"action": "order", "collection": None, "sort": "title", "descending": True}
    with pytest.raises(ReplicaError, match="already in this order"):
        preview(store, again)

    # A collection orders its own memberships, never the global order
    commit(store, preview(store, membership(store, "collections")), "join")
    child = {"action": "order", "collection": "collections-child", "moved": ["bundle-000001"]}
    result = preview(store, child | {"before": "bundle-000000"})
    assert all("asset_bundle_collections/" in unit for unit in positions(result))
    commit(store, result, "collection-move")
    assert order("collections-child") == ["bundle-000001", "bundle-000000"]
    assert order() == ["bundle-000002", "bundle-000001", "bundle-000000"]
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, child | {"moved": ["bundle-000002"], "before": None})


def test_collect_directory_files_one_folder_into_a_new_collection(store):
    from cairndex.replicas.catalog.browse import directory_bundles
    from cairndex.replicas.catalog.projection import read_row

    with store.connection(readonly=True) as db:
        assert directory_bundles(db, "Synthetic") == ["bundle-000000"]
        assert directory_bundles(db, "Synthetic/") == ["bundle-000000"]
        # A sibling sharing the prefix is not inside the folder
        assert directory_bundles(db, "Synth") == []
        for invalid in ("", "/", "../Synthetic", "/abs"):
            with pytest.raises(ReplicaError):
                directory_bundles(db, invalid)
    command = {
        "action": "collect_directory",
        "directory": "Synthetic",
        "name": " Folder 雪 ",
        "parent": "collections-root",
    }
    result = preview(store, command)
    created = next(
        item["unit"].split("/")[1]
        for item in result["changes"]
        if item["cohort"] == "domain"
        and item["unit"].startswith("collections/")
        and item["unit"].endswith("/$alive")
    )
    commit(store, result, "collect")
    with store.connection(readonly=True) as db:
        row = read_row(db, "collections", created)
        assert (row["name"], row["parent_id"]) == ("Folder 雪", "collections-root")
        siblings = [
            item
            for item in json.loads(
                db.execute(
                    "SELECT value FROM catalog_units WHERE unit='collections/_/$forest'"
                ).fetchone()[0]
            )
            if item["parent_id"] == "collections-root"
        ]
        assert max(siblings, key=lambda item: item["sort_order"])["id"] == created
        assert read_row(db, "asset_bundle_collections", f"bundle-000000~{created}") is not None
    with pytest.raises(ReplicaError, match="parent"):
        preview(store, command | {"parent": "collections-gone"})


def test_api_directory_bundle_count(api):  # noqa: F811
    client, base, _ = api
    url = base + "/replica/catalog/directories/bundle-count"
    assert client.get(url, params={"directory": "Synthetic"}).json() == {"bundle_count": 1}
    refused = client.get(url, params={"directory": "../Synthetic"})
    assert refused.status_code == 409
    assert refused.json()["message"] == "Invalid library-relative directory"


def test_group_tag_adds_restores_and_removes_one_membership(store):
    from cairndex.replicas.catalog.projection import read_row

    def run(assigned, operation):
        command = {"action": "group_tag", "group": "group-one", "tag": "tags-root"}
        commit(store, preview(store, command | {"assigned": assigned}), operation)

    run(True, "add")
    with store.connection(readonly=True) as db:
        # The new member goes after the group's existing one
        assert read_row(db, "tag_group_memberships", "group-one~tags-root")["sort_order"] == 8
    with pytest.raises(ReplicaError, match="already present"):
        run(True, "again")
    run(False, "remove")
    with pytest.raises(ReplicaError, match="already absent"):
        run(False, "remove-again")
    run(True, "restore")
    alive = store.entity("tag_group_memberships", "group-one~tags-root")["fields"]["$alive"]
    assert alive["value"] == "true"


def test_cascading_delete_removes_a_tag_with_its_descendants(store):
    commit(
        store,
        preview(
            store, {"action": "delete", "family": "tags", "entity": "tags-root", "cascade": True}
        ),
        "delete-tree",
    )
    for family, identity in (
        ("tags", "tags-root"),
        ("tags", "tags-child"),
        ("asset_bundle_tags", "bundle-000000~tags-child"),
        ("moment_tags", "moment-one~tags-child"),
        ("tag_group_memberships", "group-one~tags-child"),
    ):
        assert store.entity(family, identity)["fields"]["$alive"]["value"] == "false"
    forest = store.entity("tags", "_")["fields"]["$forest"]["value"]
    assert json.loads(forest) == []
    with pytest.raises(ReplicaError, match="tree"):
        preview(
            store, {"action": "delete", "family": "asset_bundles", "entity": "x", "cascade": True}
        )
