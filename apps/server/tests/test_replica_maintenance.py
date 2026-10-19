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
