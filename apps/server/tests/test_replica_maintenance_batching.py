"""Media batches preserve source safety, atomic cursors and newer observations."""

import sqlite3
from contextlib import contextmanager

import pytest
from PIL import Image

from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas import maintenance
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.media_observations import MediaObservation
from cairndex.replicas.protocol import ReplicaError


@pytest.fixture
def images(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        for index in range(40):
            name = f"sample-{index:03}.png"
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    f"image-{index:03}",
                    bundle_id="bundle-000001",
                    relative_path=name,
                    original_filename=name,
                    directory_path="",
                    role="IMAGE",
                    sequence=index,
                ),
            )
    converted = prepare_disposable(fixture, format_version=3)
    for index in range(40):
        Image.new("RGB", (24, 16), "navy").save(converted.package / f"sample-{index:03}.png")
    return converted


def test_probe_batch_uses_one_durable_commit_with_bounded_source_work(images, monkeypatch):
    store = images.store
    jobs.enqueue(store, "batch", "media_maintenance", {"kind": "probe"})
    original = store.connection
    reads, writes = 0, 0

    @contextmanager
    def measured(*, readonly=False):
        nonlocal reads, writes
        reads += int(readonly)
        writes += int(not readonly)
        with original(readonly=readonly) as db:
            yield db

    monkeypatch.setattr(store, "connection", measured)
    monkeypatch.setattr(maintenance, "PASS_SECONDS", 60)
    maintenance.advance(store, images.package, "synthetic", lambda: False)
    assert writes == 1
    # Media reads share one snapshot; cancellation reuses a live reader.
    assert reads == 3
    result = jobs.job(store, "batch")
    assert result["result"]["completed"] == maintenance.BATCH
    assert result["state"] == "queued"
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM local_media").fetchone()[0] == maintenance.BATCH
    monkeypatch.setattr(maintenance, "PASS_SECONDS", 0)
    maintenance.advance(store, images.package, "synthetic", lambda: False)
    assert jobs.job(store, "batch")["result"]["completed"] == maintenance.BATCH + 1
    monkeypatch.setattr(maintenance, "PASS_SECONDS", 60)
    maintenance.advance(store, images.package, "synthetic", lambda: False)
    result = jobs.job(store, "batch")
    assert result["state"] == "succeeded"
    assert result["result"]["completed"] == 42


def test_failed_batch_rolls_back_observations_and_cursor_then_retries(images, monkeypatch):
    store = images.store
    jobs.enqueue(store, "retry", "media_maintenance", {"kind": "probe"})
    original = MediaObservation.save
    calls = 0

    def fail_second(self, db):
        nonlocal calls
        original(self, db)
        calls += 1
        if calls == 2:
            raise sqlite3.OperationalError("synthetic observation failure")

    with monkeypatch.context() as patch:
        patch.setattr(MediaObservation, "save", fail_second)
        with pytest.raises(ReplicaError, match="transaction failed"):
            maintenance.step(store, images.package, "synthetic", lambda: False, limit=4)
    assert jobs.job(store, "retry")["result"] is None
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM local_media").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM local_file_facts").fetchone()[0] == 0
    maintenance.step(store, images.package, "synthetic", lambda: False, limit=4)
    assert jobs.job(store, "retry")["result"]["completed"] == 4


def test_cancel_during_probe_does_not_commit_a_later_batch(images, monkeypatch):
    store = images.store
    jobs.enqueue(store, "cancel", "media_maintenance", {"kind": "probe"})
    original = ReplicaMedia.file

    def cancel(self, *args, **kwargs):
        asset = original(self, *args, **kwargs)
        jobs.cancel(store, "cancel")
        return asset

    monkeypatch.setattr(ReplicaMedia, "file", cancel)
    maintenance.advance(store, images.package, "synthetic", lambda: False)
    result = jobs.job(store, "cancel")
    assert result["state"] == "cancelled"
    assert result["result"] is None
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM local_media").fetchone()[0] == 0


def test_delayed_observation_cannot_replace_newer_playback_facts(images):
    store = images.store
    media = ReplicaMedia(store, images.package, "synthetic")
    pending = []
    first = media.file("image-000", inspect=True, probe=True, observations=pending)
    Image.new("RGB", (48, 32), "gold").save(images.package / "sample-000.png")
    current = media.file("image-000", inspect=True, probe=True)
    assert first.quick_fingerprint != current.quick_fingerprint
    with store.connection() as db:
        pending[0].save(db)
    retained = media.file("image-000")
    assert retained.quick_fingerprint == current.quick_fingerprint
    assert retained.tech_metadata == {"width": 48, "height": 32}
