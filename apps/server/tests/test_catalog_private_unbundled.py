"""Fresh private discoveries participate in ordinary Unbundled and manual choices."""

from cairndex.replicas.catalog import manual_suggestions
from cairndex.replicas.catalog.browse import CatalogUnbundledRequest, unbundled
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.private_schema import validate_schema
from tests.test_catalog_manual_sources import accept, prepare
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_media import authored


def files(root, paths):
    for path in paths:
        source = root / path
        source.parent.mkdir(exist_ok=True, parents=True)
        source.write_bytes(("synthetic observation " + path).encode())


def test_complete_private_queue_pages_and_searches_without_publishing(replicas, monkeypatch):
    store, root, _ = replicas[0]
    peer, _, _ = replicas[1]
    paths = [f"Fresh/scene-part{index:03}.mp4" for index in range(125)]
    paths += ["Distant/scene-part126.en.srt"]
    files(root, paths)
    before = authored(store)
    with peer.connection(readonly=True) as db:
        peer_total = unbundled(db, CatalogUnbundledRequest()).total
    scan(store, root)
    assert authored(store) == before

    def forbid(*_args, **_kwargs):
        raise AssertionError("Choice reads must not walk or inspect source bytes")

    monkeypatch.setattr("os.scandir", forbid)
    monkeypatch.setattr("cairndex.replicas.media.open_source", forbid)
    with store.connection(readonly=True) as db:
        first = unbundled(db, CatalogUnbundledRequest(q="Fresh/", limit=50))
        assert first.total == 125 and len(first.items) == 50
        last = unbundled(db, CatalogUnbundledRequest(q="Fresh/", offset=100, limit=50))
        assert len(last.items) == 25
        assert all(item.id is None and item.bundle_id is None for item in first.items + last.items)
        assert (
            unbundled(db, CatalogUnbundledRequest(q="PART124")).items[0].relative_path == paths[124]
        )
        selected = manual_suggestions.SeedSelection(relative_paths=[paths[0]])
        draft = manual_suggestions.draft(db, selected)
        assert draft["proposed_title"]
        additional = draft["additional"]
        assert paths[0] not in {item["relative_path"] for item in additional}
        assert all(item["file_id"] is None for item in additional)
        cross_folder = manual_suggestions.draft(
            db,
            manual_suggestions.SeedSelection(
                relative_paths=["Distant/scene-part126.mp4"],
                limit=50,
            ),
        )["additional"]
        assert "Distant/scene-part126.en.srt" in {item["relative_path"] for item in cross_folder}
        assert any(item["relative_path"].startswith("Fresh/") for item in cross_folder)
        validate_schema(db, catalog=True)
    with peer.connection(readonly=True) as db:
        assert unbundled(db, CatalogUnbundledRequest()).total == peer_total
    assert authored(store) == before


def test_manual_confirmation_consumes_private_paths_and_preserves_other_choices(replicas):
    store, root, _ = replicas[0]
    paths = ["Fresh/scene.mp4", "Fresh/scene.en.srt", "Fresh/other.mp4"]
    files(root, paths)
    scan(store, root)
    before_bytes = {path: (root / path).read_bytes() for path in paths}
    prepared = prepare(store, root, paths[:2])
    assert prepared["state"] == "succeeded", prepared["error"]
    assert accept(store, root, prepared)["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        queue = unbundled(db, CatalogUnbundledRequest(q="Fresh/")).items
        assert [item.relative_path for item in queue] == [paths[2]]
        assert queue[0].id is None
        assert (
            db.execute(
                "SELECT count(*) FROM catalog_paths WHERE family='asset_files' "
                "AND path LIKE 'Fresh/%'"
            ).fetchone()[0]
            == 2
        )
    assert {path: (root / path).read_bytes() for path in paths} == before_bytes
    changed = prepare(store, root, [paths[2]], "changed-source")
    (root / paths[2]).write_bytes(b"changed synthetic source")
    refused = accept(store, root, changed, "changed-accept")
    assert refused["state"] == "failed" and "changed" in refused["error"]


def test_running_or_failed_discovery_keeps_last_complete_queue_and_index_upgrades(replicas):
    store, root, _ = replicas[0]
    files(root, ["Fresh/scene.mp4"])
    scan(store, root)
    with store.connection() as db:
        db.execute(
            "INSERT INTO discovery_runs(id,sequence,state,phase) "
            "VALUES ('incomplete',100000,'failed','group')"
        )
        # Earlier snapshots have no derived discovery index. Recognition and
        # reopening must preserve their queue and rebuild the search index.
        for name in ("replace", "insert", "delete"):
            db.execute(f"DROP TRIGGER discovery_suggestion_{name}")
        db.execute("DROP TABLE discovery_suggestion_paths")
        validate_schema(db, catalog=True)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    with reopened.connection(readonly=True) as db:
        validate_schema(db, catalog=True)
        assert unbundled(db, CatalogUnbundledRequest(q="Fresh/")).total == 1
        assert (
            db.execute(
                "SELECT count(*) FROM discovery_suggestion_paths "
                "WHERE discovery_suggestion_paths MATCH 'scene'"
            ).fetchone()[0]
            > 0
        )
    (root / "Fresh/scene.mp4").unlink()
    scan(reopened, root)
    with reopened.connection(readonly=True) as db:
        assert unbundled(db, CatalogUnbundledRequest(q="Fresh/")).total == 0
