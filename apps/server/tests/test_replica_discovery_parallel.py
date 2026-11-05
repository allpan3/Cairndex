"""SMB batches overlap bounded reads while keeping SQLite and receipts on the worker."""

import json
import os
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from cairndex.replicas import discovery
from cairndex.replicas import discovery_sources as sources
from cairndex.replicas import discovery_state as state
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen


@pytest.mark.parametrize("outcome", ["success", "failure", "cancel"])
def test_parallel_batch_bounds_handles_and_atomic_results(replicas, monkeypatch, outcome):
    store, root, _ = replicas[0]
    # Each leaf has a different parent, forcing the walker to close directories
    # while the first worker wave is still waiting to read them.
    for index in range(40):
        folder = root / f"scene{index:02}"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(bytes([index]) * (sources.SAMPLE * 8))
    expected = {}
    walker = sources.walk(root)
    try:
        for entry in walker:
            if entry and discovery.classify(entry.path):
                expected[entry.path] = sources.inspect(root, entry.path)
    finally:
        walker.close()
    frontier = store.frontier()
    state.enqueue(store, "parallel")
    real_inspect, real_dup, real_close = sources.inspect, os.dup, os.close
    real_connection = store.connection
    owner = threading.get_ident()
    lock = threading.Lock()
    ready, release = threading.Event(), threading.Event()
    active = peak = started = 0
    held = set()

    def duplicate(handle):
        copied = real_dup(handle)
        with lock:
            held.add(copied)
        return copied

    def close(handle):
        with lock:
            held.discard(handle)
        real_close(handle)

    @contextmanager
    def connection(*, readonly=False):
        assert threading.get_ident() == owner, "Inspection workers must not access SQLite"
        with real_connection(readonly=readonly) as db:
            yield db

    def inspect(root, path, cached=None, **kwargs):
        nonlocal active, peak, started
        assert threading.get_ident() != owner
        with lock:
            active += 1
            started += 1
            number = started
            peak = max(peak, active)
            if started == discovery.SMB_READERS:
                ready.set()
                if outcome != "cancel":
                    release.set()
        try:
            assert release.wait(10), "The bounded first wave did not overlap"
            if outcome == "failure" and number == 1:
                raise OSError("synthetic interrupted network read")
            return real_inspect(root, path, cached, **kwargs)
        finally:
            with lock:
                active -= 1

    def cancel():
        try:
            assert ready.wait(10)
            # Simulate the independent request handler while reads are in flight.
            with real_connection() as db:
                db.execute("UPDATE discovery_runs SET state='cancelled' WHERE id='parallel'")
        finally:
            release.set()

    canceller = threading.Thread(target=cancel) if outcome == "cancel" else None
    if canceller:
        canceller.start()
    try:
        with monkeypatch.context() as patch:
            patch.setattr(sources, "mounted_smb", lambda root: True)
            patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: 0))
            patch.setattr(sources, "inspect", inspect)
            patch.setattr(os, "dup", duplicate)
            patch.setattr(os, "close", close)
            patch.setattr(store, "connection", connection)
            discovery.tick(store, root)
    finally:
        release.set()
        if canceller:
            canceller.join(10)
    assert peak == discovery.SMB_READERS
    assert active == 0 and not held
    assert store not in discovery._walks
    assert store.frontier() == frontier
    result = state.run(store, "parallel")
    with store.connection(readonly=True) as db:
        observed = {
            row["path"]: json.loads(row["body"])
            for row in db.execute("SELECT path,body FROM discovery_entries WHERE run='parallel'")
        }
    if outcome == "success":
        assert result["phase"] == "known"
        assert observed == expected
    else:
        assert result["state"] == ("failed" if outcome == "failure" else "cancelled")
        assert result["observed"] == 0 and observed == {}
        assert scan(store, root)["observed"] == len(expected)


def test_unchanged_smb_scan_does_not_start_workers(replicas, monkeypatch):
    store, root, _ = replicas[0]
    first = scan(store, root)

    def unnecessary(*args, **kwargs):
        pytest.fail("An unchanged native generation does not need a network worker")

    with monkeypatch.context() as patch:
        patch.setattr(sources, "mounted_smb", lambda root: True)
        patch.setattr(discovery, "ThreadPoolExecutor", unnecessary)
        second = scan(store, root)
    assert first["observed"] == second["observed"]
