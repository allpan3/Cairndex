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
    assert page(store, q="ExcludedTag").total == 1
    assert page(store, q="ExcludedOrigin").total == 1
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
    # A naive stored timestamp is UTC; without the offset a browser reads local time
    assert all(item["date_added"].endswith("Z") for item in result.json()["items"])
    for body in (
        {"filter": {"version": 1, "root": {"field": "codec", "operator": "equals", "value": "x"}}},
        {"sort": "unsupported"},
        {"view": "trash"},
        {"limit": 101},
    ):
        assert client.post(url, json=body).status_code == 422
    assert client.get(base + "/bundles/browse").status_code == 409
    assert client.get(base + "/replica/status").json()["browse_version"] == 12


def test_api_single_bundle_summary_matches_browse_without_observing_or_writing(api):  # noqa: F811
    from cairndex.replicas.catalog.local_history import observed

    client, base, store = api
    endpoint = base + "/replica/catalog/bundles/bundle-000000/summary"
    assert client.get(base + "/replica/status").json()["bundle_summary_version"] == 1
    first = client.get(endpoint)
    assert first.status_code == 200
    assert first.json()["total_size"] is None
    with store.connection() as db:
        for file in db.execute(
            "SELECT entity,path FROM catalog_paths WHERE family='asset_files'"
        ).fetchall():
            observed(db, file["entity"], file["path"], 10, 1_700_000_000_000_000_000)
        before = tuple(db.execute("SELECT count(*) FROM events").fetchone())
    expected = client.post(base + "/replica/catalog/bundles/browse", json={}).json()["items"]
    summary = client.get(endpoint).json()
    assert summary == next(item for item in expected if item["id"] == "bundle-000000")
    assert summary["file_count"] == 2
    assert summary["total_size"] == 20
    with store.connection(readonly=True) as db:
        assert tuple(db.execute("SELECT count(*) FROM events").fetchone()) == before
        assert db.execute("SELECT count(*) FROM local_media").fetchone()[0] == 0
    assert client.get(base + "/replica/catalog/bundles/absent/summary").status_code == 409


# Manual follows the authored order, or one collection's own membership order
def test_manual_and_file_count_sorts(tmp_path):
    import sqlite3

    from cairndex.devtools.catalog_fixture import insert_row

    fixture = create_disposable(parent=tmp_path, bundles=4)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_bundle_collections SET sort_order=1")
        insert_row(
            db,
            "asset_bundle_collections",
            {"bundle_id": "bundle-000001", "collection_id": "collections-child", "sort_order": 5},
        )
    store = prepare_disposable(fixture).store
    for identity, order in (("000000", 3), ("000001", 2), ("000002", 2), ("000003", 1)):
        changes = edit(store, "asset_bundles", f"bundle-{identity}", "manual_order", order)
        save(store, changes, f"order-{identity}")

    def ids(**args):
        return [item.id.removeprefix("bundle-") for item in page(store, **args).items]

    # Equal orders put the newer bundle first, as in the legacy browser
    assert ids(sort="manual") == ["000003", "000002", "000001", "000000"]
    assert ids(sort="manual", order="desc") == ["000000", "000001", "000002", "000003"]
    single = {"collection_id": "collections-child", "include_descendants": False}
    assert ids(sort="manual", **single) == ["000000", "000001"]
    nested = {"collection_id": "collections-root", "include_descendants": True}
    assert ids(sort="manual", **nested) == ["000001", "000000"]
    assert ids(sort="file_count", order="desc")[0] == "000000"
    assert ids(sort="file_count")[-1] == "000000"


# Card facts come from this device's last observations, never from source bytes
def test_card_facts_follow_local_observations(tmp_path):
    import sqlite3

    from cairndex.devtools.catalog_fixture import insert_row, synthetic_row
    from cairndex.media.storyboards import storyboard_cache_key

    fixture = create_disposable(parent=tmp_path, bundles=3)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        for identity, name, role, sequence in (
            ("file-photo", "one.jpg", "IMAGE", 1),
            ("file-clip", "two.mp4", "PRIMARY_VIDEO", 2),
        ):
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    identity,
                    bundle_id="bundle-000001",
                    relative_path=f"Synthetic/b/{name}",
                    directory_path="Synthetic/b",
                    original_filename=name,
                    display_title=name,
                    role=role,
                    sequence=sequence,
                ),
            )
    store = prepare_disposable(fixture).store

    def card(identity):
        return next(item for item in page(store).items if item.id == identity)

    def observe(file_id, state, metadata=None, position=None, completed=0, generation="g1"):
        with store.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO local_media VALUES (?,?,?,?,NULL)",
                (file_id, generation, state, json.dumps(metadata) if metadata else None),
            )
            if position is not None:
                db.execute(
                    "INSERT OR REPLACE INTO local_progress VALUES (?,'g1',?,60,?)",
                    (file_id, position, completed),
                )

    # A file this device never observed names its kind but offers no preview
    first = card("bundle-000000")
    facts = (first.media_kind, first.extension, first.resume_file_id)
    assert facts == ("video", "mp4", "file-video")
    assert first.resume_media_kind is None and first.duration is None and not first.has_missing
    assert card("bundle-000002").resume_file_id is None

    meta = {"duration": 60.0, "width": 640, "height": 360}
    meta |= {"container": "mp4", "video_codec": "h264"}
    observe("file-video", "available", meta, position=12.5)
    first = card("bundle-000000")
    assert (first.resume_media_kind, first.resume_duration, first.resume_position) == (
        "video",
        60.0,
        12.5,
    )
    assert (first.width, first.height, first.resume_container) == (640, 360, "mp4")
    assert first.resume_generation == "g1"
    assert first.resume_storyboard_version == storyboard_cache_key("g1")
    observe("file-video", "available", meta, position=60.0, completed=1)
    assert card("bundle-000000").resume_position is None
    # Progress of an earlier generation is not this file's resume position
    observe("file-video", "available", meta, position=12.5, generation="g2")
    assert card("bundle-000000").resume_position is None

    # An unfinished member is current before the first one, and a lost file marks the card
    observe("file-photo", "unavailable")
    observe("file-clip", "available", meta, position=5.0)
    second = card("bundle-000001")
    assert (second.resume_file_id, second.has_missing) == ("file-clip", True)
    # The cursor wins, but a file last seen unavailable has no preview
    with store.connection() as db:
        db.execute("INSERT INTO local_cursors VALUES ('bundle-000001','file-photo')")
    second = card("bundle-000001")
    assert (second.resume_file_id, second.media_kind, second.extension) == (
        "file-photo",
        "image",
        "jpg",
    )
    assert second.resume_media_kind is None
    assert [item.id for item in page(store, view="missing").items] == ["bundle-000001"]


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
    from cairndex.replicas.catalog.index import remove
    from cairndex.replicas.private_schema import validate_schema

    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    with store.connection() as db:
        remove(db)
        validate_schema(db, catalog=True)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    assert page(reopened, q="Synthetic").total == 3
    with reopened.connection() as db:
        validate_schema(db, catalog=True)
    try:
        with reopened.connection() as db:
            db.execute("DELETE FROM catalog_rows WHERE family='asset_bundles'")
            assert db.execute("SELECT count(*) FROM catalog_search").fetchone()[0] == 0
            raise RuntimeError("synthetic rollback")
    except RuntimeError:
        pass
    assert page(reopened, q="Synthetic").total == 3


def test_empty_created_catalog_has_a_valid_empty_browse(tmp_path):
    from cairndex.devtools.replica_creation_fixture import prepare_disposable as empty_fixture
    from cairndex.replicas.catalog.creation import complete

    fixture = empty_fixture(parent=tmp_path)
    complete(fixture)
    from tests.test_replica_creation import open_store

    store = open_store(fixture.root, tmp_path / "author")
    assert store.status()["ready"]
    assert page(store).total == 0


def test_random_pages_stable_after_projection_edit_and_local_missing(tmp_path):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=65)).store
    first = [item.id for item in page(store, view="random", seed=721, limit=100).items]
    pages = [
        item.id
        for offset in (0, 20, 40, 60)
        for item in page(store, view="random", seed=721, offset=offset, limit=20).items
    ]
    assert pages == first
    assert len(set(pages)) == 65
    save(store, edit(store, "asset_bundles", first[0], "title", "Changed title"), "title")
    assert [item.id for item in page(store, view="random", seed=721, limit=100).items] == first
    assert [item.id for item in page(store, view="random", seed=722, limit=100).items] != first
    assert page(store, view="missing").total == 0
    with store.connection() as db:
        db.execute("INSERT INTO local_media VALUES ('file-video',NULL,'unavailable',NULL,NULL)")
    assert [item.id for item in page(store, view="missing").items] == ["bundle-000000"]
    assert page(store, view="missing", q="no-match").total == 0
    with store.connection() as db:
        db.execute("UPDATE local_media SET state='available'")
    assert page(store, view="missing").total == 0


def test_unbundled_file_population_search_and_hidden_paths(tmp_path):
    import sqlite3

    from cairndex.replicas.catalog.browse import CatalogUnbundledRequest, unbundled

    fixture = create_disposable(parent=tmp_path, bundles=4)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL', "
            "grouping_source='SCAN_SUGGESTION' WHERE id='bundle-000000'"
        )
    store = prepare_disposable(fixture).store
    with store.connection(readonly=True) as db:
        complete = unbundled(db, CatalogUnbundledRequest())
        first = unbundled(db, CatalogUnbundledRequest(limit=1))
        second = unbundled(db, CatalogUnbundledRequest(limit=1, offset=1))
        assert complete.total >= 2
        assert first.items[0].id != second.items[0].id
        assert unbundled(db, CatalogUnbundledRequest(q=second.items[0].relative_path)).total == 1
        assert all(item.bundle_id == "bundle-000000" for item in complete.items)
        assert {item.media_kind for item in complete.items} == {"video", "subtitle"}
    assert "bundle-000000" not in {item.id for item in page(store).items}
    save(
        store,
        edit(store, "asset_files", complete.items[0].id, "relative_path", ".hidden/file"),
        "hide",
    )
    with store.connection(readonly=True) as db:
        assert unbundled(db, CatalogUnbundledRequest()).total == complete.total - 1


# Browse version 10: the sidebar's view counts, and a collection's own and subtree counts
def test_view_counts_and_direct_collection_counts(api, tmp_path):  # noqa: F811
    import sqlite3

    from cairndex.devtools.catalog_fixture import insert_row, synthetic_row
    from cairndex.replicas.catalog.navigation import navigation, view_counts

    fixture = create_disposable(parent=tmp_path, bundles=4)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute(
            "INSERT INTO asset_bundle_collections (bundle_id,collection_id,sort_order) "
            "VALUES ('bundle-000001','collections-root',1)"
        )
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL', "
            "grouping_source='SCAN_SUGGESTION' WHERE id='bundle-000003'"
        )
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "file-staged",
                bundle_id="bundle-000003",
                relative_path="Staged/clip.mp4",
                directory_path="Staged",
                original_filename="clip.mp4",
                display_title="clip.mp4",
                role="PRIMARY_VIDEO",
                tech_metadata="{}",
            ),
        )
    store = prepare_disposable(fixture).store
    with store.connection(readonly=True) as db:
        counts = view_counts(db).model_dump()
        collections = {item["id"]: item for item in navigation(db, "collections", "", 50).items}
    # The staged bundle is Unbundled, not a browsable bundle; Recent lists every bundle
    assert counts == {
        "all": 3,
        "recent": 3,
        "uncategorized": 1,
        "untagged": 2,
        "missing": 0,
        "unbundled": 1,
    }
    assert (
        collections["collections-root"]["count"],
        collections["collections-root"]["direct_count"],
    ) == (2, 1)
    assert (
        collections["collections-child"]["count"],
        collections["collections-child"]["direct_count"],
    ) == (1, 1)
    client, base, _ = api
    served = client.get(base + "/replica/catalog/bundles/counts")
    assert served.status_code == 200
    assert set(served.json()) == set(counts)
    assert served.json()["all"] == page(api[2]).total
