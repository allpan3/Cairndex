"""Ordinary saved-filter controls keep exact AST text, opening bases and retry receipts."""

import json

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError
from tests.test_catalog_inspector import commit
from tests.test_replica_catalog import edit, save


@pytest.fixture
def store(tmp_path):
    return prepare_disposable(create_disposable(parent=tmp_path, bundles=3), format_version=3).store


def command(store, *, delete=False, filter_json=None):
    entity = store.entity("smart_folders", "filter-one")
    fields = entity["fields"]
    columns = fields if delete else ["name", "$alive", *(["$filter"] if filter_json else [])]
    return {
        "action": "smart_collection",
        "entity": "filter-one",
        "observed": {fields[column]["unit"]: fields[column]["basis"] for column in columns},
        **({"delete": True} if delete else {"name": "Reviewed rules"}),
        **({"filter_json": filter_json} if filter_json else {}),
    }


def test_rename_preserves_exact_advanced_filter_and_other_defaults(store):
    raw = (
        '{ "version":1,"root":{"op":"not","child":'
        '{"field":"title","operator":"contains","value":"Comet"}} }'
    )
    save(
        store,
        edit(
            store,
            "smart_folders",
            "filter-one",
            "$filter",
            {
                "filter_version": 1,
                "filter_json": raw,
            },
        ),
        "advanced",
    )
    before = store.entity("smart_folders", "filter-one")
    prepared = preview(store, command(store))
    assert {item["unit"] for item in prepared["changes"]} == {
        "smart_folders/filter-one/name",
        "smart_folders/filter-one/$alive",
    }
    assert store.entity("smart_folders", "filter-one") == before
    commit(store, prepared, "rename")
    after = store.entity("smart_folders", "filter-one")
    assert after["fields"]["$filter"]["value"] == before["fields"]["$filter"]["value"]
    assert json.loads(after["fields"]["name"]["value"]) == "Reviewed rules"
    assert store.status()["browse_version"] >= 14


@pytest.mark.parametrize("delete", [False, True])
def test_stale_opening_cannot_rename_or_delete_a_later_edit(store, delete):
    captured = command(store, delete=delete)
    save(store, edit(store, "smart_folders", "filter-one", "name", "Later name"), "later")
    frontier = store.frontier()
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, captured)
    assert store.frontier() == frontier
    assert store.entity("smart_folders", "filter-one")["fields"]["$alive"]["value"] == "true"


def test_invalid_filter_refuses_atomically_and_valid_replacement_keeps_other_fields(store):
    frontier = store.frontier()
    with pytest.raises(ReplicaError):
        preview(
            store,
            command(
                store,
                filter_json=(
                    '{"version":1,"root":{"field":"unsupported","operator":"eq","value":1}}'
                ),
            ),
        )
    assert store.frontier() == frontier
    raw = '{"version":1,"root":{"field":"rating","operator":"gte","value":4}}'
    commit(store, preview(store, command(store, filter_json=raw)), "conditions")
    with store.connection(readonly=True) as db:
        row = read_row(db, "smart_folders", "filter-one")
        assert row["filter_json"] == raw
        assert row["filter_version"] == 1


def test_delete_retains_bundles_and_exact_retry_survives_later_work(store):
    with store.connection(readonly=True) as db:
        before = list(
            db.execute(
                "SELECT entity,body FROM catalog_rows WHERE family='asset_bundles' ORDER BY entity"
            )
        )
        before = [tuple(row) for row in before]
    jobs.enqueue(store, "delete-preview", "preview", command(store, delete=True))
    jobs.run_one(store)
    prepared = jobs.job(store, "delete-preview")
    assert prepared["state"] == "succeeded", prepared
    body = {"job": prepared["id"], "receipt": prepared["receipt"]}
    jobs.enqueue(store, "delete-commit", "commit_preview", body)
    jobs.run_one(store)
    applied = jobs.job(store, "delete-commit")
    assert applied["state"] == "succeeded", applied
    with store.connection(readonly=True) as db:
        assert read_row(db, "smart_folders", "filter-one") is None
    with store.connection(readonly=True) as db:
        assert [
            tuple(row)
            for row in db.execute(
                "SELECT entity,body FROM catalog_rows WHERE family='asset_bundles' ORDER BY entity"
            )
        ] == before
    save(store, edit(store, "asset_bundles", "bundle-000000", "title", "Later bundle"), "later")
    frontier = store.frontier()
    jobs.enqueue(store, "delete-commit", "commit_preview", body)
    jobs.run_one(store)
    assert jobs.job(store, "delete-commit")["result"] == applied["result"]
    assert store.frontier() == frontier
