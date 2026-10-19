"""Explicit unlinked paths remain private until a guarded, revalidated commit."""

import json

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.projection import read_row
from tests.test_catalog_inspector import commit


@pytest.fixture
def fixture(tmp_path):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3), format_version=3)
    root = converted.package
    (root / "Atlas").mkdir()
    for path in (
        "scene.mp4",
        "scene.en.srt",
        "cover.jpg",
        "scene-part02.mp4",
        "scene-part02.en.srt",
    ):
        (root / "Atlas" / path).write_bytes(("synthetic " + path).encode())
    return converted.store, root


def test_earlier_format_keeps_id_bundling_and_refuses_unlinked_identity(tmp_path):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    assert converted.store.status()["browse_version"] == 12
    prepared = prepare(converted.store, converted.package, ["clip.mp4"])
    assert prepared["state"] == "failed"
    assert "discovery-capable" in prepared["error"]


def prepare(store, root, paths, operation="prepare", *, files=None, target=None):
    jobs.enqueue(
        store,
        operation,
        "preview",
        {
            "action": "bundle_files",
            "files": files or [],
            "relative_paths": paths,
            "target": target,
            "title": "Synthetic selection",
        },
    )
    jobs.run_one(store, root)
    return jobs.job(store, operation)


def accept(store, root, prepared, operation="accept"):
    jobs.enqueue(
        store,
        operation,
        "commit_preview",
        {
            "job": prepared["id"],
            "receipt": prepared["receipt"],
        },
    )
    jobs.run_one(store, root)
    return jobs.job(store, operation)


def target(prepared):
    return next(
        change["unit"].split("/")[1]
        for change in prepared["result"]["changes"]
        if change["unit"].endswith("/grouping_state")
    )


def test_unlinked_paths_create_one_confirmed_bundle_without_shared_staging(fixture):
    store, root = fixture
    paths = ["Atlas/scene.en.srt", "Atlas/scene.mp4", "Atlas/cover.jpg"]
    before = {path: (root / path).read_bytes() for path in paths}
    with store.connection(readonly=True) as db:
        original = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    prepared = prepare(store, root, paths)
    assert prepared["state"] == "succeeded", prepared["error"]
    bundle = target(prepared)
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == original
        assert read_row(db, "asset_bundles", bundle) is None
    applied = accept(store, root, prepared)
    assert applied["state"] == "succeeded", applied["error"]
    with store.connection(readonly=True) as db:
        row = read_row(db, "asset_bundles", bundle)
        assert row["grouping_state"] == "CONFIRMED"
        assert row["title"] == "Synthetic selection"
        sources = prepared["result"]["sources"]
        rows = {file["path"]: read_row(db, "asset_files", file["id"]) for file in sources}
        assert {row["bundle_id"] for row in rows.values()} == {bundle}
        assert rows["Atlas/scene.mp4"]["sequence"] < rows["Atlas/scene.en.srt"]["sequence"]
        assert row["cover_file_id"] == rows["Atlas/cover.jpg"]["id"]
        tracks = [
            json.loads(raw)
            for (raw,) in db.execute(
                "SELECT body FROM catalog_rows WHERE family='subtitle_tracks' "
                "AND json_extract(body,'$.bundle_id')=?",
                (bundle,),
            )
        ]
        assert len(tracks) == 1
        assert tracks[0]["video_file_id"] == rows["Atlas/scene.mp4"]["id"]
        assert tracks[0]["source_file_id"] == rows["Atlas/scene.en.srt"]["id"]
    assert {path: (root / path).read_bytes() for path in paths} == before
    # A lost terminal acknowledgement must not turn a committed retry into a new operation.
    (root / paths[0]).write_bytes(b"later source edit")
    with store.connection() as db:
        db.execute("UPDATE catalog_jobs SET state='queued',result=NULL WHERE id='accept'")
    jobs.run_one(store, root)
    assert jobs.job(store, "accept")["result"] == applied["result"]
    from cairndex.replicas.recovery_validation import validate_private

    with store.connection(readonly=True) as db:
        validate_private(db, store)


def test_add_unlinked_paths_appends_order_and_preserves_target_cover(fixture):
    store, root = fixture
    initial = prepare(store, root, ["Atlas/scene.mp4", "Atlas/cover.jpg"])
    assert accept(store, root, initial)["state"] == "succeeded"
    bundle = target(initial)
    with store.connection(readonly=True) as db:
        before = read_row(db, "asset_bundles", bundle)
    addition = prepare(
        store,
        root,
        ["Atlas/scene-part02.mp4", "Atlas/scene-part02.en.srt"],
        "addition",
        target=bundle,
    )
    assert addition["state"] == "succeeded", addition["error"]
    assert accept(store, root, addition, "append")["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_bundles", bundle)["cover_file_id"] == before["cover_file_id"]
        members = json.loads(store.entity("asset_bundles", bundle)["fields"]["$members"]["value"])
        assert sorted(member["sequence"] for member in members) == [0, 1, 2, 3]
        for file in addition["result"]["sources"]:
            assert read_row(db, "asset_files", file["id"])["sequence"] >= 2


def test_changed_source_refuses_the_exact_review_without_catalog_changes(fixture):
    store, root = fixture
    prepared = prepare(store, root, ["Atlas/scene.mp4"])
    assert prepared["state"] == "succeeded"
    (root / "Atlas/scene.mp4").write_bytes(b"changed synthetic source")
    applied = accept(store, root, prepared)
    assert applied["state"] == "failed"
    assert "changed" in applied["error"]
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_bundles", target(prepared)) is None


@pytest.mark.parametrize(
    "path",
    [
        "../outside.mp4",
        "/outside.mp4",
        ".hidden.mp4",
        "Atlas",
        "Atlas/document.txt",
        "Atlas/link.mp4",
    ],
)
def test_unsafe_or_unsupported_selection_does_not_author_metadata(fixture, tmp_path, path):
    store, root = fixture
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"outside synthetic data")
    (root / "Atlas/link.mp4").symlink_to(outside)
    with store.connection(readonly=True) as db:
        before = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    prepared = prepare(store, root, [path])
    assert prepared["state"] == "failed"
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == before


def test_mixed_staged_identity_and_new_subtitle_keep_existing_file(fixture):
    store, root = fixture
    commit(store, preview(store, {"action": "dissolve", "ids": ["bundle-000000"]}), "dissolve")
    with store.connection(readonly=True) as db:
        old = read_row(db, "asset_files", "file-video")
    source = root / old["relative_path"]
    source.parent.mkdir(exist_ok=True)
    source.write_bytes(b"synthetic existing video")
    from cairndex.replicas.catalog.file_browser import list_directory
    from cairndex.replicas.media import ReplicaMedia

    listing = list_directory(
        ReplicaMedia(store, root, "synthetic-library"), old["relative_path"].rpartition("/")[0]
    )
    assert next(file for file in listing.entries if file.file_id == "file-video").unbundled
    prepared = prepare(store, root, ["Atlas/scene.en.srt"], files=["file-video"])
    assert prepared["state"] == "succeeded", prepared["error"]
    assert accept(store, root, prepared)["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_files", "file-video")["bundle_id"] == target(prepared)
        assert read_row(db, "asset_files", "file-video")["note"] == old["note"]


def test_mixed_selection_cannot_discard_staging_bundle_metadata(fixture):
    from tests.test_replica_catalog import edit, save

    store, root = fixture
    initial = prepare(store, root, ["Atlas/scene.mp4"])
    assert accept(store, root, initial)["state"] == "succeeded"
    commit(store, preview(store, {"action": "dissolve", "ids": ["bundle-000000"]}), "dissolve")
    with store.connection(readonly=True) as db:
        old = read_row(db, "asset_files", "file-video")
    source = root / old["relative_path"]
    source.parent.mkdir(exist_ok=True)
    source.write_bytes(b"synthetic existing video")
    save(
        store,
        edit(store, "asset_bundles", old["bundle_id"], "notes", '["Retain synthetic note"]'),
        "note",
    )
    prepared = prepare(
        store, root, ["Atlas/scene.en.srt"], "mixed", files=["file-video"], target=target(initial)
    )
    assert prepared["state"] == "failed"
    assert "metadata or memberships" in prepared["error"]
    with store.connection(readonly=True) as db:
        assert (
            read_row(db, "asset_bundles", old["bundle_id"])["notes"] == '["Retain synthetic note"]'
        )
        assert read_row(db, "asset_files", "file-video")["bundle_id"] == old["bundle_id"]


def test_recovery_retains_a_source_preview_and_requires_exact_commit_retry(fixture, tmp_path):
    from cairndex.replicas import recovery
    from cairndex.replicas.catalog.store import CatalogStore
    from cairndex.replicas.recovery_cli import inspect, retry_job
    from tests.test_replica_recovery import deliver, restored

    seed, root = fixture
    base = tmp_path / "server"
    store = CatalogStore(base / "replicas" / seed.descriptor.library_uuid, seed.descriptor)
    deliver(seed, store)
    prepared = prepare(store, root, ["Atlas/scene.mp4", "Atlas/scene.en.srt"])
    assert prepared["state"] == "succeeded"
    jobs.enqueue(
        store,
        "pending-commit",
        "commit_preview",
        {
            "job": prepared["id"],
            "receipt": prepared["receipt"],
        },
    )
    backup = tmp_path / "backup"
    recovery.backup(root, base, backup)
    destination = tmp_path / "destination"
    review = recovery.prepare(root, destination, backup)
    recovered = restored(root, destination, review)
    assert jobs.job(recovered, "prepare")["result"] == prepared["result"]
    assert jobs.job(recovered, "pending-commit")["state"] == "failed"
    jobs.run_one(recovered, root)
    with recovered.connection(readonly=True) as db:
        assert read_row(db, "asset_bundles", target(prepared)) is None
    entry = next(
        item
        for item in inspect(destination, review["id"], "jobs", "", 50)["items"]
        if item["id"] == "pending-commit"
    )
    retry_job(root, destination, "pending-commit", entry["intent_receipt"])
    jobs.run_one(recovered, root)
    assert jobs.job(recovered, "pending-commit")["state"] == "succeeded"
    with recovered.connection(readonly=True) as db:
        assert read_row(db, "asset_bundles", target(prepared))["grouping_state"] == "CONFIRMED"
