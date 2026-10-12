"""Replica worker cadence: continue while work is queued, wait while idle"""

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


def test_worker_waits_briefly_only_while_work_is_queued(monkeypatch):
    queued = iter([True, True, False, True, False])
    calls: list[str] = []
    monkeypatch.setattr(service, "_handles", {"library": None})
    monkeypatch.setattr(service, "exchange", lambda library_id, **_: calls.append(library_id))
    monkeypatch.setattr(service, "pending", lambda library_id: next(queued))
    worker = service.ReplicaWorker()
    waits = Waits(passes=5)
    worker._stop = waits  # type: ignore[assignment]
    worker.run()
    worker._sources.shutdown(wait=False)
    assert calls == ["library"] * 5
    idle, busy = service.IDLE_WAIT, service.BUSY_WAIT
    assert waits.requested == [idle, busy, busy, idle, busy, idle]


def test_pending_reports_queued_jobs_and_unpublished_events(tmp_path, monkeypatch):
    store = prepare_disposable(create_disposable(parent=tmp_path, bundles=3)).store
    monkeypatch.setattr(service, "_handles", {"library": (store, None, None, "", None)})
    assert not service.pending("library")
    assert not service.pending("unknown")
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
