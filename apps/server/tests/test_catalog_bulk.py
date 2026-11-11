"""Selections above one request change in durable, resumable 100-bundle batches."""

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog import bulk, jobs
from cairndex.replicas.catalog.bulk import CatalogBulkStage
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.selection import (
    CatalogBulkMembershipRequest,
    CatalogSelectionRequest,
    choices,
    selection,
)
from cairndex.replicas.protocol import ReplicaError
from tests.test_replica_catalog import edit, save
from tests.test_replica_catalog_api import api  # noqa: F401

# The default fixture's 125 bundles take two batches
IDS = [f"bundle-{index:06}" for index in range(125)]


@pytest.fixture
def store(tmp_path):
    return prepare_disposable(create_disposable(parent=tmp_path)).store


def chunks(ids, size=100):
    return [ids[start : start + size] for start in range(0, len(ids), size)]


def reviewed(store, field, ids=IDS):
    """Each bundle's lifetime and field bases, read as the inspector reads them."""
    return [
        {
            "id": item.id,
            "observed": {
                unit: basis
                for unit, basis in item.observed.items()
                if unit.endswith((f"/{field}", "/$alive"))
            },
        }
        for chunk in chunks(ids)
        for item in selection(store, CatalogSelectionRequest(ids=chunk)).items
    ]


def reviewed_membership(store, family, target, ids=IDS):
    items, shared = [], {}
    for chunk in chunks(ids):
        page = choices(store, CatalogBulkMembershipRequest(ids=chunk, family=family, target=target))
        observed = page.items[0].observed
        shared = {f"{family}/{target}/$alive": observed[f"{family}/{target}/$alive"]}
        for identity in chunk:
            items.append(
                {
                    "id": identity,
                    "observed": {
                        unit: basis
                        for unit, basis in observed.items()
                        if unit.startswith(f"asset_bundles/{identity}/") or f"/{identity}~" in unit
                    },
                }
            )
    return items, shared


def start(store, operation, items, change):
    for offset in range(0, len(items), bulk.PAGE):
        page = CatalogBulkStage(start=offset, items=items[offset : offset + bulk.PAGE])
        bulk.stage(store, operation, page)
    return jobs.enqueue(store, operation, "bulk_selection", {"change": change, "total": len(items)})


def run(store, operation):
    for _ in range(10):
        jobs.run_one(store)
        if jobs.job(store, operation)["state"] != "queued":
            break
    return jobs.job(store, operation)


def unchanged(store, operation):
    return bulk.unchanged(store, operation, 0, bulk.PAGE).items


def title(store, identity):
    return store.entity("asset_bundles", identity)["fields"]["title"]["value"]


def test_batches_skip_changed_bundles_and_report_them(store):
    change = {"action": "bulk", "field": "title", "value": "Shelved"}
    start(store, "retitle", reviewed(store, "title"), change)
    # Another device retitles a bundle the second batch will reach
    save(store, edit(store, "asset_bundles", IDS[110], "title", "Peer title"), "peer")
    jobs.run_one(store)
    first = jobs.job(store, "retitle")
    assert first["state"] == "queued"
    assert first["result"] | {"target": None} == {
        "total": 125,
        "applied": 100,
        "skipped": 0,
        "batches": 1,
        "target": None,
    }
    finished = run(store, "retitle")
    assert finished["state"] == "succeeded"
    assert (finished["result"]["applied"], finished["result"]["skipped"]) == (124, 1)
    assert unchanged(store, "retitle") == [IDS[110]]
    assert title(store, IDS[110]) == '"Peer title"'
    assert not store.entity("asset_bundles", IDS[110])["has_conflicts"]
    assert {title(store, identity) for identity in IDS if identity != IDS[110]} == {'"Shelved"'}
    # Each batch is its own event with its own retry identity
    with store.connection(readonly=True) as db:
        events = db.execute(
            "SELECT operation FROM events WHERE operation LIKE 'retitle-%' ORDER BY operation"
        ).fetchall()
    assert [row[0] for row in events] == ["retitle-0", "retitle-1"]


def test_an_ordinary_edit_runs_between_batches(store):
    start(
        store, "rate", reviewed(store, "rating"), {"action": "bulk", "field": "rating", "value": 4}
    )
    jobs.run_one(store)
    single = edit(store, "asset_bundles", IDS[0], "notes", '["Between batches"]')
    body = {
        "changes": [change.model_dump() for change in single],
        "parents": store.frontier(),
        "resolve": False,
        "recover": False,
    }
    jobs.enqueue(store, "note", "save", body)
    jobs.run_one(store)
    assert jobs.job(store, "note")["state"] == "succeeded"
    assert jobs.job(store, "rate")["result"]["batches"] == 1
    assert run(store, "rate")["state"] == "succeeded"


def test_cancel_stops_after_the_current_batch_and_lists_the_rest(store):
    start(
        store,
        "cancelled",
        reviewed(store, "title"),
        {"action": "bulk", "field": "title", "value": "Half"},
    )
    jobs.run_one(store)
    jobs.cancel(store, "cancelled")
    jobs.run_one(store)
    stopped = jobs.job(store, "cancelled")
    assert (stopped["state"], stopped["result"]["applied"]) == ("cancelled", 100)
    assert unchanged(store, "cancelled") == IDS[100:]
    assert title(store, IDS[99]) == '"Half"' and title(store, IDS[100]) != '"Half"'


def test_a_change_to_the_shared_target_stops_the_operation(store):
    items, shared = reviewed_membership(store, "tags", "tags-child")
    change = {"action": "bulk", "field": "tags", "target": "tags-child", "assigned": True}
    start(store, "tag-all", items, change | {"observed": shared})
    jobs.run_one(store)
    # The operation's own first batch advanced the tag's lifetime; the next batch accepts it
    assert jobs.job(store, "tag-all")["state"] == "queued"
    save(store, edit(store, "tags", "tags-child", "name", "Renamed elsewhere"), "peer-rename")
    jobs.run_one(store)
    stopped = jobs.job(store, "tag-all")
    assert stopped["state"] == "failed"
    assert "100 of 125" in stopped["error"]
    assert unchanged(store, "tag-all") == IDS[100:]
    counts = [
        choices(store, CatalogBulkMembershipRequest(ids=chunk, family="tags", target="tags-child"))
        .items[0]
        .assigned_count
        for chunk in chunks(IDS)
    ]
    assert counts == [100, 0]


def test_membership_and_metadata_only_delete_cover_every_batch(store):
    items, shared = reviewed_membership(store, "collections", "collections-child")
    change = {
        "action": "bulk",
        "field": "collections",
        "target": "collections-child",
        "assigned": True,
        "observed": shared,
    }
    start(store, "collect", items, change)
    assert run(store, "collect")["state"] == "succeeded"
    counts = [
        choices(
            store,
            CatalogBulkMembershipRequest(
                ids=chunk, family="collections", target="collections-child"
            ),
        )
        .items[0]
        .assigned_count
        for chunk in chunks(IDS)
    ]
    assert counts == [100, 25]
    with store.connection(readonly=True) as db:
        files = db.execute(
            "SELECT count(*) FROM catalog_rows WHERE family='asset_files'"
        ).fetchone()[0]
    start(
        store,
        "dissolve",
        [{"id": identity, "observed": {}} for identity in IDS],
        {"action": "dissolve"},
    )
    assert run(store, "dissolve")["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        assert not db.execute(
            "SELECT 1 FROM catalog_rows WHERE family='asset_bundles' AND entity IN "
            f"({','.join('?' * len(IDS))})",
            IDS,
        ).fetchone()
        # Every file keeps its identity and returns to Unbundled
        assert (
            db.execute("SELECT count(*) FROM catalog_rows WHERE family='asset_files'").fetchone()[0]
            == files
        )
    # Starting a new operation releases the finished one's staged selection
    with store.connection(readonly=True) as db:
        assert {
            row[0] for row in db.execute("SELECT DISTINCT operation FROM catalog_bulk_items")
        } == {"dissolve"}


def test_staging_retries_freezes_and_refuses_incomplete_selections(store):
    items = reviewed(store, "title")
    page = CatalogBulkStage(start=0, items=items[:100])
    assert bulk.stage(store, "staged", page).staged == 100
    assert bulk.stage(store, "staged", page).staged == 100
    with pytest.raises(ReplicaError, match="reused"):
        bulk.stage(store, "staged", CatalogBulkStage(start=0, items=items[1:101]))
    with pytest.raises(ReplicaError, match="once"):
        bulk.stage(store, "staged", CatalogBulkStage(start=100, items=items[:1]))
    change = {"change": {"action": "bulk", "field": "title", "value": "Late"}, "total": 125}
    with pytest.raises(ReplicaError, match="incomplete"):
        jobs.enqueue(store, "staged", "bulk_selection", change)
    bulk.stage(store, "staged", CatalogBulkStage(start=100, items=items[100:]))
    queued = jobs.enqueue(store, "staged", "bulk_selection", change)
    assert jobs.enqueue(store, "staged", "bulk_selection", change) == queued
    with pytest.raises(ReplicaError, match="already started"):
        bulk.stage(store, "staged", page)
    with pytest.raises(ReplicaError, match="intent"):
        jobs.enqueue(
            store,
            "unscoped",
            "bulk_selection",
            {"change": {"action": "bulk", "field": "tags", "target": "tags-child"}, "total": 1},
        )


def test_bulk_routes_stage_pages_and_list_unchanged_bundles(api):  # noqa: F811
    client, base, store = api
    base += "/replica/catalog"
    assert client.get(base.rsplit("/catalog", 1)[0] + "/status").json()["selection_version"] == 5
    items = reviewed(store, "title", IDS[:3])
    foreign = [{"id": IDS[0], "observed": {f"asset_bundles/{IDS[1]}/title": []}}]
    assert (
        client.post(base + "/bundles/selection/bulk/api-op", json={"start": 0, "items": foreign})
    ).status_code == 422
    staged = client.post(base + "/bundles/selection/bulk/api-op", json={"start": 0, "items": items})
    assert staged.json() == {"staged": 3}
    body = {"change": {"action": "bulk", "field": "title", "value": "Routed"}, "total": 3}
    queued = client.post(
        base + "/jobs", json={"operation": "api-op", "action": "bulk_selection", "body": body}
    )
    assert queued.status_code == 202
    run(store, "api-op")
    listed = client.get(base + "/bundles/selection/bulk/api-op/unchanged?limit=1")
    assert listed.json() == {"items": [], "next_start": None}
