"""History and complete SQL sorts use only this instance's private facts."""

from datetime import UTC, datetime

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.local_history import observed, opened
from cairndex.replicas.catalog.store import CatalogStore
from tests.test_catalog_browse import page
from tests.test_replica_catalog import edit, exchange, save


def test_history_and_file_facts_are_local_and_sort_before_pagination(tmp_path, monkeypatch):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=65)).store
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM local_bundle_history").fetchone()[0] == 0
        files = db.execute(
            "SELECT entity,path FROM catalog_paths WHERE family='asset_files' ORDER BY entity"
        ).fetchall()
        events = list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id")))
    assert next(item for item in page(store).items if item.id == "bundle-000000").total_size is None
    with store.connection() as db:
        observed(db, files[0][0], files[0][1], 10, 1_700_000_000_000_000_000)
        opened(db, "bundle-000064")
    assert next(item for item in page(store).items if item.id == "bundle-000000").total_size is None
    assert page(store, sort="date_opened", order="desc", limit=1).items[0].id == "bundle-000064"
    assert page(store, sort="date_opened", order="asc", limit=1).items[0].id == "bundle-000064"
    with store.connection() as db:
        observed(db, files[1][0], files[1][1], 20, 1_700_000_000_000_000_000)
        assert list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id"))) == events
    assert page(store, sort="size", order="desc", limit=1).items[0].total_size == 30
    peer = CatalogStore(tmp_path / "peer", store.descriptor)
    exchange(store, peer)
    assert all(item.date_opened is None for item in page(peer).items)
    assert next(item for item in page(peer).items if item.id == "bundle-000000").total_size is None
    save(
        store,
        edit(store, "asset_files", files[0][0], "relative_path", "Synthetic/renamed.mp4"),
        "rename",
    )
    assert page(store, sort="size", order="desc", offset=64, limit=1).items[0].total_size is None


def test_metadata_edits_and_opening_have_separate_times(tmp_path, monkeypatch):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    initial = next(item for item in page(store).items if item.id == "bundle-000001").date_modified
    monkeypatch.setattr(
        "cairndex.replicas.catalog.local_history.utcnow", lambda: datetime(2030, 1, 1, tzinfo=UTC)
    )
    with store.connection() as db:
        opened(db, "bundle-000001")
    assert (
        next(item for item in page(store).items if item.id == "bundle-000001").date_modified
        == initial
    )
    save(store, edit(store, "asset_bundles", "bundle-000001", "rating", 4), "rating")
    changed = page(store, sort="date_modified", order="desc", limit=1).items[0]
    assert changed.id == "bundle-000001"
    assert changed.date_modified.year == 2030
    monkeypatch.setattr(
        "cairndex.replicas.catalog.local_history.utcnow", lambda: datetime(2031, 1, 1, tzinfo=UTC)
    )
    save(store, edit(store, "asset_bundles", "bundle-000001", "rating", 4), "same-rating")
    assert (
        page(store, sort="date_modified", order="desc", limit=1).items[0].date_modified
        == changed.date_modified
    )


def test_repeated_file_observation_only_writes_changes(tmp_path):
    from cairndex.persistence.sqlite_durability import connect_writable
    from cairndex.replicas.catalog.local_history import SCHEMA, observed

    with connect_writable(tmp_path / "observations.db") as db:
        db.executescript(SCHEMA)
        observed(db, "synthetic-file", "Synthetic/clip.mp4", 123, 1_000_000_000)
        before = db.total_changes
        observed(db, "synthetic-file", "Synthetic/clip.mp4", 123, 1_000_000_000)
        assert db.total_changes == before
        observed(db, "synthetic-file", "Synthetic/clip.mp4", 124, 1_000_000_000)
        assert db.total_changes == before + 1
        observed(db, "synthetic-file", "Synthetic/renamed.mp4", 124, 1_000_000_000)
        assert db.total_changes == before + 2
