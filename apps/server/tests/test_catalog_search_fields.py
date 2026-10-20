"""Search the complete metadata population and retain historical private indexes."""

import sqlite3

import pytest

from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas.catalog import index
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.private_schema import validate_schema
from tests.test_catalog_browse import page
from tests.test_catalog_inspector import commit
from tests.test_replica_catalog import edit, save


def test_search_fields_follow_paths_names_memberships_and_transfers_before_paging(
    tmp_path, monkeypatch
):
    fixture = create_disposable(parent=tmp_path, bundles=65)
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "search-file",
                bundle_id="bundle-000064",
                relative_path="Remote/Comet/feature-archive.mp4",
                directory_path="Remote/Comet",
                original_filename="origin-name.mp4",
                display_title="Orbit recording",
                source="https://example.invalid/externalBeacon",
                media_kind="VIDEO",
                role="PRIMARY_VIDEO",
            ),
        )
        insert_row(db, "asset_bundle_tags", {"bundle_id": "bundle-000064", "tag_id": "tags-child"})
        insert_row(
            db,
            "asset_bundle_collections",
            {"bundle_id": "bundle-000064", "collection_id": "collections-child", "sort_order": 2},
        )
    store = prepare_disposable(fixture).store
    save(store, edit(store, "tags", "tags-child", "name", "SearchTag"), "tag")
    save(
        store,
        edit(store, "collections", "collections-child", "name", "SearchCollection"),
        "collection",
    )

    def forbid(*_args, **_kwargs):
        raise AssertionError("Metadata search must not open or enumerate source files")

    monkeypatch.setattr("os.scandir", forbid)
    monkeypatch.setattr("cairndex.replicas.media.open_source", forbid)
    for query in (
        "orbit",
        "origin-name",
        "comet",
        "archive",
        "externalBeacon",
        "orbit searchtag",
        "orbit searchcollection",
        "orbit video",
    ):
        found = page(store, q=query, limit=1)
        assert found.total == 1
        assert [item.id for item in found.items] == ["bundle-000064"]
    save(
        store,
        edit(store, "asset_files", "search-file", "relative_path", "Outer/Moon/scene.mkv"),
        "path",
    )
    assert page(store, q="comet").total == 0
    assert page(store, q="moon orbit").total == 1
    save(
        store,
        edit(store, "asset_files", "search-file", "display_title", "Launch flight"),
        "display",
    )
    assert page(store, q="orbit").total == 0
    save(store, edit(store, "asset_files", "search-file", "source", None), "clear-source")
    assert page(store, q="externalBeacon").total == 0
    save(store, edit(store, "tags", "tags-child", "name", "RenamedTag"), "rename-tag")
    save(
        store,
        edit(store, "collections", "collections-child", "name", "RetainedCollection"),
        "rename-collection",
    )
    assert page(store, q="SearchTag").total == 0
    assert page(store, q="SearchCollection").total == 0
    assert page(store, q="launch renamedtag retainedcollection").total == 1
    for family, identity in (
        ("asset_bundle_tags", "bundle-000064~tags-child"),
        ("asset_bundle_collections", "bundle-000064~collections-child"),
    ):
        commit(
            store,
            preview(store, {"action": "delete", "family": family, "entity": identity}),
            "remove-" + family,
        )
    assert page(store, q="launch renamedtag").total == 0
    assert page(store, q="launch retainedcollection").total == 0
    commit(
        store,
        preview(
            store,
            {
                "action": "transfer",
                "source": "bundle-000064",
                "target": "bundle-000002",
                "members": ["asset_files/search-file"],
            },
        ),
        "transfer",
    )
    assert [item.id for item in page(store, q="launch moon").items] == ["bundle-000002"]


def legacy(store):
    with store.connection() as db:
        index.remove(db)
        db.executescript("BEGIN IMMEDIATE;" + index.LEGACY_INDEX_SCHEMA)
        db.execute(
            "INSERT INTO catalog_search(rowid,bundle_id,title,notes,file_notes,moments) "
            "SELECT * FROM catalog_search_source"
        )
        validate_schema(db, catalog=True)


def test_historical_search_is_rebuilt_without_changing_authored_events(tmp_path):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    save(store, edit(store, "asset_files", "file-video", "source", "HistoricBeacon"), "source")
    legacy(store)
    assert page(store, q="HistoricBeacon").total == 0
    with store.connection(readonly=True) as db:
        before = list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id")))
    reopened = CatalogStore(store.path.parent, store.descriptor)
    assert page(reopened, q="HistoricBeacon").total == 1
    with reopened.connection(readonly=True) as db:
        validate_schema(db, catalog=True)
        assert list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id"))) == before


def test_failed_derived_search_upgrade_rolls_back_its_ddl_and_contents(tmp_path):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    legacy(store)
    with store.connection() as db:
        before = list(map(tuple, db.execute("SELECT * FROM catalog_search ORDER BY rowid")))

        def deny_insert(action, table, *_args):
            return (
                sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_INSERT and table == "catalog_search"
                else sqlite3.SQLITE_OK
            )

        db.set_authorizer(deny_insert)
        try:
            with pytest.raises(sqlite3.DatabaseError):
                index.install(db)
        finally:
            db.set_authorizer(None)
            db.rollback()
        validate_schema(db, catalog=True)
        assert list(map(tuple, db.execute("SELECT * FROM catalog_search ORDER BY rowid"))) == before
