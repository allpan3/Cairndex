"""Whole-catalog search, projection changes and strict ordinary browser contracts."""

import json

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog.browse import CatalogBrowseRequest, browse
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.store import CatalogStore
from tests.test_replica_catalog import edit, exchange, save
from tests.test_replica_catalog_api import api  # noqa: F401


def page(store, **args):
    with store.connection(readonly=True) as db:
        return browse(db, CatalogBrowseRequest(**args))


def test_search_complete_population_and_changes(tmp_path):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=65))
    store = converted.store
    assert page(store, limit=10).total == 65
    assert len(page(store, offset=60, limit=10).items) == 5
    save(store, edit(store, "asset_bundles", "bundle-000064", "title", "Distant Nebula"), "title")
    save(store, edit(store, "asset_bundles", "bundle-000064", "notes", '["Amber","Café"]'), "notes")
    assert [x.id for x in page(store, q="nebu cafe amber").items] == ["bundle-000064"]
    save(store, edit(store, "asset_files", "file-video", "note", "File quasar"), "file")
    save(store, edit(store, "moments", "moment-one", "comment", "Moment pulsar"), "moment")
    assert [x.id for x in page(store, q="quasar pulsar").items] == ["bundle-000000"]
    save(store, edit(store, "tags", "tags-child", "name", "ExcludedTag"), "tag")
    save(store, edit(store, "asset_files", "file-video", "source", "ExcludedOrigin"), "origin")
    assert page(store, q="ExcludedTag").total == 0
    assert page(store, q="ExcludedOrigin").total == 0
    save(store, edit(store, "asset_files", "file-video", "note", None), "clear")
    assert page(store, q="quasar").total == 0
    assert page(store, q="pulsar").total == 1
    reopened = CatalogStore(store.path.parent, store.descriptor)
    assert page(reopened, q="nebu cafe amber").total == 1


def test_search_follows_peer_conflicts_and_projection(tmp_path):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    a = converted.store
    b = CatalogStore(tmp_path / "peer", a.descriptor)
    exchange(a, b)
    first = edit(a, "asset_bundles", "bundle-000001", "title", "Amber")
    second = edit(b, "asset_bundles", "bundle-000001", "title", "Blue")
    save(a, first, "amber")
    save(b, second, "blue")
    exchange(a, b)
    for store in (a, b):
        entity = store.entity("asset_bundles", "bundle-000001")
        assert entity["has_conflicts"]
        shown = json.loads(entity["fields"]["title"]["value"])
        assert page(store, q=shown).total == 1
        assert page(store).total == 3


def test_api_browse_refuses_unsupported_filters_and_sorts(api):  # noqa: F811
    client, base, _ = api
    url = base + "/replica/catalog/bundles/browse"
    result = client.post(url, json={"limit": 2})
    assert result.status_code == 200
    assert result.json()["total"] == 3
    assert len(result.json()["items"]) == 2
    for body in (
        {"filter": {"version": 1, "root": {"field": "codec", "operator": "equals", "value": "x"}}},
        {"sort": "size"},
        {"view": "missing"},
        {"limit": 101},
    ):
        assert client.post(url, json=body).status_code == 422
    assert client.get(base + "/bundles/browse").status_code == 409
    assert client.get(base + "/replica/status").json()["browse_version"] == 2


def test_browse_population_hidden_provisional_and_empty(tmp_path):
    import sqlite3

    fixture = create_disposable(parent=tmp_path, bundles=4)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_files SET relative_path='.hidden/' || relative_path")
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL', "
            "grouping_source='SCAN_SUGGESTION' "
            "WHERE id='bundle-000001'"
        )
    store = prepare_disposable(fixture).store
    assert {item.id for item in page(store).items} == {"bundle-000002", "bundle-000003"}
    assert page(store, q="Synthetic").total == 2


def test_index_upgrade_and_rollback_remain_complete(tmp_path):
    from cairndex.replicas.private_schema import validate_schema

    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    with store.connection() as db:
        for trigger in ("catalog_search_insert", "catalog_search_delete", "catalog_search_remove"):
            db.execute(f"DROP TRIGGER {trigger}")
        db.execute("DROP TABLE catalog_search")
        db.execute("DROP VIEW catalog_search_source")
        db.execute("DROP INDEX catalog_file_bundle")
        db.execute("DROP INDEX catalog_moment_file")
        validate_schema(db, catalog=True)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    assert page(reopened, q="Synthetic").total == 2
    with reopened.connection() as db:
        validate_schema(db, catalog=True)
    try:
        with reopened.connection() as db:
            db.execute("DELETE FROM catalog_rows WHERE family='asset_bundles'")
            assert db.execute("SELECT count(*) FROM catalog_search").fetchone()[0] == 0
            raise RuntimeError("synthetic rollback")
    except RuntimeError:
        pass
    assert page(reopened, q="Synthetic").total == 2


def test_empty_created_catalog_has_a_valid_empty_browse(tmp_path):
    from cairndex.devtools.replica_creation_fixture import prepare_disposable as empty_fixture
    from cairndex.replicas.catalog.creation import complete

    fixture = empty_fixture(parent=tmp_path)
    complete(fixture)
    from tests.test_replica_creation import open_store

    store = open_store(fixture.root, tmp_path / "author")
    assert store.status()["ready"]
    assert page(store).total == 0
