"""Catalog queries retain the established filter and local-only observation contracts."""

import json
import sqlite3

import pytest

from cairndex.core.errors import ValidationError
from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.replicas.catalog.browse import CatalogBrowseRequest, browse
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.file_browser import list_directory
from cairndex.replicas.catalog.navigation import CatalogFacetRequest, facets, navigation
from cairndex.replicas.media import ReplicaMedia
from tests.test_catalog_browse import page


def pred(field, operator, value, **extra):
    return dict(field=field, operator=operator, value=value, **extra)


def test_descendants_compound_saved_filters_counts_and_pages(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=65)
    expression = (
        ' { "version": 1, "root": {"op":"and","children":['
        '{"field":"rating","operator":"gte","value":3.5},'
        '{"op":"not","child":{"field":"title","operator":"contains","value":"absent"}}]}} '
    )
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE smart_folders SET filter_json=?", (expression,))
        insert_row(
            db,
            "asset_bundle_collections",
            synthetic_row(
                "asset_bundle_collections",
                "synthetic-edge",
                bundle_id="bundle-000064",
                collection_id="collections-child",
                sort_order=1,
            ),
        )
        insert_row(
            db,
            "asset_bundle_tags",
            synthetic_row(
                "asset_bundle_tags",
                "synthetic-edge",
                bundle_id="bundle-000064",
                tag_id="tags-child",
            ),
        )
    store = prepare_disposable(fixture).store
    assert page(store, collection_id="collections-root", include_descendants=False).total == 0
    assert page(store, collection_id="collections-root", include_descendants=True).total == 2
    assert page(store, collection_id="collections-root", q="64").items[0].id == "bundle-000064"
    with store.connection(readonly=True) as db:
        saved = navigation(db, "smart_folders", "", 1).items[0]
        assert saved["filter_json"] == expression
        result = browse(
            db, CatalogBrowseRequest(smart_collection_id=saved["id"], limit=10, offset=60)
        )
        assert result.total == 64
        assert len(result.items) == 4
        counts = facets(db, CatalogFacetRequest(collection_id="collections-root"))
        assert counts.tags["tags-root"] == 2
        assert counts.ratings["3.5"] == 1
        assert navigation(db, "collections", "", 1).next_cursor
    compound = {
        "root": {
            "op": "and",
            "children": [
                pred("tags", "contains_all", ["tags-root"], include_descendants=True),
                {
                    "op": "or",
                    "children": [
                        pred("title", "equals", "Synthetic bundle 64 雪"),
                        pred("rating", "lt", 0),
                    ],
                },
            ],
        }
    }
    assert page(store, filter=compound).total == 1
    assert (
        page(
            store,
            filter={"root": pred("tags", "contains_none", ["tags-root"], include_descendants=True)},
        ).total
        == 63
    )
    assert page(store, filter={"root": pred("tags", "contains_any", [])}).total == 0
    assert page(store, filter={"root": pred("tags", "contains_all", [])}).total == 65
    with store.connection(readonly=True) as db:
        assert (
            json.loads(
                db.execute("SELECT body FROM catalog_rows WHERE family='smart_folders'").fetchone()[
                    0
                ]
            )["filter_json"]
            == expression
        )


@pytest.mark.parametrize(
    "node",
    [
        pred("size_bytes", "eq", 0),
        pred("has_missing", "equals", False),
        {"op": "not", "child": pred("has_missing", "equals", True)},
    ],
)
def test_unknown_source_observations_do_not_become_matches(tmp_path, node):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    assert {row.id for row in page(store, filter={"root": node}).items} == {
        "bundle-000001",
        "bundle-000002",
    }


def test_literal_text_dates_and_notes(tmp_path):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    assert (
        page(store, filter={"root": pred("date_added", "gte", "2000-01-01T00:00:00Z")}).total == 3
    )
    assert page(store, filter={"root": pred("title", "contains", "%")}).total == 0
    assert page(store, filter={"root": pred("notes", "equals", "雪")}).total == 1
    assert page(store, filter={"root": pred("filename", "starts_with", "Synthetic/")}).total == 1
    assert page(store, filter={"root": pred("extension", "equals", "mp4")}).total == 1
    assert page(store, filter={"root": pred("source", "contains", "magnet:")}).total == 1


def test_local_directory_retains_catalog_and_rejects_unsafe_sources(tmp_path):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    media = ReplicaMedia(converted.store, converted.package, "synthetic")
    root = converted.package
    (root / "Synthetic").mkdir(exist_ok=True)
    (root / "Synthetic" / "new.txt").write_text("synthetic")
    (root / "Synthetic" / ".hidden").write_text("synthetic")
    (root / "Synthetic" / "escape").symlink_to(tmp_path, target_is_directory=True)
    before = converted.store.frontier()
    result = list_directory(media, "Synthetic")
    rows = {item.name: item for item in result.entries}
    assert ".hidden" not in rows and "escape" not in rows
    assert rows["new.txt"].local_state == "observed" and not rows["new.txt"].linked
    assert rows["雪.mp4"].linked
    (root / "Synthetic" / "雪.mp4").unlink(missing_ok=True)
    assert (
        next(
            item for item in list_directory(media, "Synthetic").entries if item.name == "雪.mp4"
        ).local_state
        == "unavailable"
    )
    assert converted.store.frontier() == before
    for path in ("../outside", "/tmp", "C:\\outside", ".cairndex", "Synthetic/escape"):
        with pytest.raises(ValidationError):
            list_directory(media, path)
