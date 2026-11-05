"""Replica worker cadence: continue while work is queued, wait while idle"""

import threading
import time
from types import SimpleNamespace

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas import service
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.protocol import canonical


# Records each requested wait and stops the loop after a fixed number of passes
class Waits:
    def __init__(self, passes: int) -> None:
        self.passes = passes
        self.requested: list[float] = []

    def wait(self, timeout: float) -> bool:
        self.requested.append(timeout)
        return self.is_set()

    def is_set(self) -> bool:
        return len(self.requested) > self.passes

    def set(self) -> None:
        self.passes = len(self.requested)

    def clear(self) -> None:
        pass


def test_worker_waits_briefly_only_while_work_is_queued(monkeypatch):
    queued = iter([True, True, False, True, False])
    calls: list[str] = []
    monkeypatch.setattr(service, "_handles", {"library": None})
    monkeypatch.setattr(service, "exchange", lambda library_id, **_: calls.append(library_id))
    monkeypatch.setattr(service, "pending", lambda library_id: next(queued))
    worker = service.ReplicaWorker()
    waits = Waits(passes=5)
    worker._stop = worker._wake = waits  # type: ignore[assignment]
    worker.run()
    worker._sources.shutdown(wait=False)
    assert calls == ["library"] * 5
    idle, busy = service.IDLE_WAIT, service.BUSY_WAIT
    assert waits.requested == [idle, busy, busy, idle, busy, idle]


def test_queued_work_starts_a_pass_without_the_idle_wait(monkeypatch):
    passes = threading.Event()
    monkeypatch.setattr(service, "IDLE_WAIT", 60.0)
    monkeypatch.setattr(service, "_handles", {"library": None})
    monkeypatch.setattr(service, "exchange", lambda library_id, **_: passes.set())
    monkeypatch.setattr(service, "pending", lambda library_id: False)
    service._wake.clear()  # an earlier worker's stop leaves it set
    worker = service.ReplicaWorker()
    worker._thread.start()
    try:
        assert not passes.wait(0.2)
        service.wake()
        assert passes.wait(5)
    finally:
        worker.stop()
    assert not worker._thread.is_alive()


def test_one_pass_runs_review_edit_steps_for_a_bounded_time(monkeypatch):
    from cairndex.replicas.grouping import worker as grouping

    steps = iter([True, True, True, False])
    calls: list[int] = []

    def step(store) -> bool:
        calls.append(1)
        return next(steps)

    monkeypatch.setattr(grouping, "step", step)
    service.advance_grouping(None)  # type: ignore[arg-type]
    assert len(calls) == 4

    def slow(store) -> bool:
        calls.append(1)
        time.sleep(0.05)
        return True

    calls.clear()
    monkeypatch.setattr(grouping, "step", slow)
    monkeypatch.setattr(service, "GROUPING_SECONDS", 0.12)
    service.advance_grouping(None)  # type: ignore[arg-type]
    assert 2 <= len(calls) <= 4


def test_update_pass_yields_at_step_time_and_completion_boundaries(monkeypatch):
    from itertools import count

    from cairndex.replicas import discovery, discovery_state

    calls = []
    monkeypatch.setattr(discovery, "tick", lambda *_: calls.append(1))
    monkeypatch.setattr(discovery_state, "run", lambda *_: {"state": "running"})
    monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: 0))
    service.advance_discovery(None, None)
    assert len(calls) == 32
    calls.clear()
    clock = count()
    monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: next(clock)))
    service.advance_discovery(None, None)
    assert len(calls) == 1
    calls.clear()
    monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: 0))
    monkeypatch.setattr(discovery_state, "run", lambda *_: {"state": "succeeded"})
    service.advance_discovery(None, None)
    assert len(calls) == 1


def test_pending_reports_queued_jobs_and_unpublished_events(tmp_path, monkeypatch):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    monkeypatch.setattr(service, "_handles", {"library": (store, None, None, "", None)})
    assert not service.pending("library")
    assert not service.pending("unknown")
    # Maintenance has its own loop; it must not accelerate unrelated history polling.
    jobs.enqueue(store, "local-media", "media_maintenance", {"kind": "probe"})
    assert not service.pending("library")
    jobs.cancel(store, "local-media")
    entity = store.entity("asset_bundles", "bundle-000000")
    body = {
        "changes": [
            {
                "unit": entity["fields"][name]["unit"],
                "value": canonical(value).decode(),
                "basis": entity["fields"][name]["basis"],
                "cohort": None,
            }
            for name, value in (("title", "Queued title"), ("$alive", True))
        ],
        "parents": entity["parents"],
        "resolve": False,
        "recover": False,
    }
    jobs.enqueue(store, "queued-save", "save", body)
    assert service.pending("library")
    jobs.run_one(store)
    # The completed save is a local event that the transport has not published yet
    assert jobs.job(store, "queued-save")["state"] == "succeeded"
    assert service.pending("library")
    with store.connection() as db:
        db.execute("UPDATE events SET published=1 WHERE local=1")
    assert not service.pending("library")
    # A blocked store does no job or discovery work until recovery, so it is idle
    jobs.enqueue(store, "waiting-save", "save", body)
    assert service.pending("library")
    with store.connection() as db:
        db.execute("INSERT OR REPLACE INTO config VALUES ('blocked', 'Synthetic block')")
    assert not service.pending("library")


def test_media_pass_advances_while_transport_lock_is_busy(tmp_path, monkeypatch):
    from cairndex.domain.enums import FileAvailability, MediaKind
    from cairndex.replicas.media import ReplicaMedia

    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    store = converted.store
    transport_lock = threading.Lock()
    transport_lock.acquire()
    monkeypatch.setattr(
        service,
        "_handles",
        {
            "media-library": (
                store,
                SimpleNamespace(root=converted.package),
                transport_lock,
                store.descriptor.model_dump_json(),
                None,
            )
        },
    )
    calls = []

    def inspect(self, identity, **kwargs):
        calls.append(identity)
        return SimpleNamespace(
            availability=FileAvailability.AVAILABLE,
            media_kind=MediaKind.IMAGE,
            tech_metadata={"width": 12, "height": 8},
            quick_fingerprint="synthetic",
        )

    monkeypatch.setattr(ReplicaMedia, "file", inspect)
    jobs.enqueue(store, "independent-media", "media_maintenance", {"kind": "probe"})
    worker = service.ReplicaWorker()
    try:
        worker.run_sources("media-library")
        assert jobs.job(store, "independent-media")["state"] == "succeeded"
        assert calls == ["file-subtitle", "file-video"]
        assert transport_lock.locked()
    finally:
        transport_lock.release()
        worker._sources.shutdown(wait=True)
