"""Explicit preparation stays private, bounded, cancellable and recoverable."""

from types import SimpleNamespace

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.replicas import maintenance
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.recovery_validation import snapshot, validate_snapshot


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3), format_version=3)
    calls = []

    def inspect(self, identity, **kwargs):
        calls.append(identity)
        return SimpleNamespace(
            availability=FileAvailability.AVAILABLE,
            media_kind=MediaKind.VIDEO if identity == "file-video" else MediaKind.OTHER,
            tech_metadata={"duration": 5},
            quick_fingerprint="synthetic-generation",
        )

    monkeypatch.setattr(ReplicaMedia, "file", inspect)
    return converted, calls


def run(converted):
    maintenance.step(converted.store, converted.package, "synthetic-library", lambda: False)


def test_enqueue_and_ordinary_exchange_never_probe_and_each_background_step_is_bounded(fixture):
    converted, calls = fixture
    store = converted.store
    frontier = store.frontier()
    queued = jobs.enqueue(store, "prepare-probes", "media_maintenance", {"kind": "probe"})
    assert jobs.enqueue(store, "prepare-probes", "media_maintenance", {"kind": "probe"}) == queued
    assert calls == []
    jobs.run_one(store, converted.package)
    assert calls == []
    run(converted)
    assert len(calls) == 1
    progress = jobs.job(store, "prepare-probes")["result"]
    assert (progress["completed"], progress["total"]) == (1, 2)
    run(converted)
    run(converted)
    result = maintenance.latest(store)
    assert result["kind"] == "probe"
    assert result["job"]["state"] == "succeeded"
    assert result["job"]["result"]["skipped"] == 1
    assert store.frontier() == frontier


def test_cancel_blocks_later_files_and_changed_retry_intent_is_refused(fixture):
    converted, calls = fixture
    store = converted.store
    jobs.enqueue(store, "cancel-pass", "media_maintenance", {"kind": "probe"})
    with pytest.raises(ReplicaError, match="already queued"):
        jobs.enqueue(store, "another-pass", "media_maintenance", {"kind": "probe"})
    with pytest.raises(ReplicaError, match="different catalog job"):
        jobs.enqueue(store, "cancel-pass", "media_maintenance", {"kind": "storyboards"})
    run(converted)
    jobs.cancel(store, "cancel-pass")
    run(converted)
    assert len(calls) == 1
    assert jobs.job(store, "cancel-pass")["state"] == "cancelled"


def test_restart_preserves_cursor_and_backup_validates_progress(fixture, tmp_path):
    converted, calls = fixture
    store = converted.store
    jobs.enqueue(store, "retained-pass", "media_maintenance", {"kind": "probe"})
    run(converted)
    restarted = CatalogStore(store.path.parent, store.descriptor)
    maintenance.step(restarted, converted.package, "synthetic-library", lambda: False)
    assert calls == ["file-subtitle", "file-video"]
    backup = tmp_path / "private-snapshot.db"
    snapshot(restarted.path, backup)
    validate_snapshot(backup, restarted.descriptor)


def test_storyboard_wait_does_not_reprobe_or_skip_the_waiting_file(fixture, monkeypatch):
    from cairndex.replicas.storyboards import StoryboardState

    converted, calls = fixture
    states = iter(["queued", "running", "ready"])
    queue = SimpleNamespace(request=lambda *args: StoryboardState(next(states)))
    monkeypatch.setattr("cairndex.replicas.storyboards.get_queue", lambda: queue)
    jobs.enqueue(converted.store, "storyboards-pass", "media_maintenance", {"kind": "storyboards"})
    run(converted)
    run(converted)
    for _ in range(3):
        run(converted)
    result = jobs.job(converted.store, "storyboards-pass")
    assert result["state"] == "succeeded"
    assert result["result"]["completed"] == 2
    assert calls == ["file-subtitle", "file-video"]


def test_failures_are_counted_without_retaining_exception_text(fixture, monkeypatch):
    converted, _ = fixture

    def unavailable(*args, **kwargs):
        raise OSError("synthetic path that must not be retained")

    monkeypatch.setattr(ReplicaMedia, "file", unavailable)
    jobs.enqueue(converted.store, "failed-files", "media_maintenance", {"kind": "probe"})
    for _ in range(3):
        run(converted)
    result = jobs.job(converted.store, "failed-files")
    assert result["result"]["failed"] == 2
    assert result["error"] is None
    assert "synthetic path" not in str(result)


def test_unsupported_pass_is_rejected_before_becoming_durable(fixture):
    converted, _ = fixture
    with pytest.raises(ReplicaError, match="supported local media"):
        jobs.enqueue(converted.store, "unsupported", "media_maintenance", {"kind": "unsupported"})
    assert maintenance.latest(converted.store)["job"] is None


def test_collect_metadata_probes_indexed_audio_and_refreshes_changed_local_bytes(
    tmp_path, monkeypatch
):
    import shutil
    import wave

    from cairndex.devtools.catalog_fixture import insert_row, synthetic_row
    from cairndex.persistence.sqlite_durability import connect_writable
    from cairndex.replicas import media as local_media

    probe = local_media.run_ffprobe
    calls = []

    def observed_probe(*args, **kwargs):
        calls.append(args[0])
        return probe(*args, **kwargs)

    monkeypatch.setattr(local_media, "run_ffprobe", observed_probe)

    fixture = create_disposable(parent=tmp_path, bundles=3)
    relative = "Audio/tone.wav"
    source = fixture.source / relative
    source.parent.mkdir(exist_ok=True)

    def write_audio(path, seconds):
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 8000 * seconds)

    write_audio(source, 1)
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "file-audio",
                bundle_id="bundle-000001",
                relative_path=relative,
                directory_path="Audio",
                original_filename="tone.wav",
                display_title="Synthetic audio",
                media_kind="AUDIO",
                role="OTHER",
                size_bytes=source.stat().st_size,
                tech_metadata=None,
            ),
        )
    converted = prepare_disposable(fixture, format_version=3)
    target = converted.package / relative
    target.parent.mkdir(exist_ok=True)
    shutil.copy2(source, target)
    original = target.read_bytes()
    store = converted.store
    frontier = store.frontier()
    with store.connection(readonly=True) as db:
        before = list(map(tuple, db.execute("SELECT * FROM catalog_rows ORDER BY family,entity")))
    jobs.enqueue(store, "collect-audio", "media_maintenance", {"kind": "probe"})
    for _ in range(5):
        run(converted)
        if jobs.job(store, "collect-audio")["state"] == "succeeded":
            break
    result = jobs.job(store, "collect-audio")
    assert result["state"] == "succeeded"
    media = ReplicaMedia(store, converted.package, "synthetic-library")
    asset = media.file("file-audio", inspect=True)
    assert asset.tech_metadata is not None
    assert asset.tech_metadata["duration"] == pytest.approx(1)
    assert asset.tech_metadata["audio_codec"] == "pcm_s16le"
    assert asset.tech_metadata["audio_sample_rate"] == 8000
    assert result["result"]["failed"] == 0
    assert result["result"]["skipped"] == 2
    assert target.read_bytes() == original
    repeated = media.file("file-audio", inspect=True, probe=True)
    assert repeated.tech_metadata == asset.tech_metadata
    assert len(calls) == 1

    write_audio(target, 2)
    replacement = target.read_bytes()
    refreshed = media.file("file-audio", inspect=True, probe=True)
    assert refreshed.quick_fingerprint != asset.quick_fingerprint
    assert refreshed.tech_metadata is not None
    assert refreshed.tech_metadata["duration"] == pytest.approx(2)
    assert len(calls) == 2

    from cairndex.replicas import storyboards

    def unexpected_video_queue():
        pytest.fail("Audio must not request a video storyboard")

    monkeypatch.setattr(storyboards, "get_queue", unexpected_video_queue)
    jobs.enqueue(store, "audio-storyboards", "media_maintenance", {"kind": "storyboards"})
    for _ in range(5):
        run(converted)
        if jobs.job(store, "audio-storyboards")["state"] == "succeeded":
            break
    assert jobs.job(store, "audio-storyboards")["state"] == "succeeded"
    assert len(calls) == 2
    assert target.read_bytes() == replacement
    assert store.frontier() == frontier
    with store.connection(readonly=True) as db:
        assert (
            list(map(tuple, db.execute("SELECT * FROM catalog_rows ORDER BY family,entity")))
            == before
        )
