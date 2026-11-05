"""Repeat Update preserves identity checks without repeated reads or tiny commits."""

from itertools import count
from types import SimpleNamespace

import pytest

from cairndex.replicas import discovery, discovery_plan, discovery_sources
from cairndex.replicas import discovery_state as state
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen


def reach_known(store, root, run):
    state.enqueue(store, run)
    for _ in range(100):
        discovery.tick(store, root)
        if state.run(store, run)["phase"] == "known":
            return
    pytest.fail("Update did not reach catalog checks")


def checkpoint(store):
    with store.connection(readonly=True) as db:
        return {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY rowid")]
            for table in (
                "discovery_runs",
                "discovery_progress",
                "discovery_entries",
                "discovery_baselines",
                "discovery_candidates",
                "discovery_missing",
                "local_file_facts",
                "local_media",
            )
        }


def test_unchanged_update_checks_sources_without_content_reads_or_grouping(replicas, monkeypatch):
    store, root, _ = replicas[0]
    first = scan(store, root)
    before = checkpoint(store)
    frontier = store.frontier()
    original = discovery_sources.inspect
    inspected = []

    def inspect(root, path, cached=None, **kwargs):
        inspected.append(path)
        assert cached is not None
        return original(root, path, cached, **kwargs)

    def unnecessary(*args, **kwargs):
        pytest.fail("An unchanged settled library needs neither content reads nor grouping")

    with monkeypatch.context() as patch:
        patch.setattr(discovery_sources, "inspect", inspect)
        patch.setattr(discovery_sources.os, "pread", unnecessary)
        patch.setattr(discovery_plan, "index_batch", unnecessary)
        result = scan(store, root)
    assert result["observed"] == first["observed"] == len(inspected) > 0
    assert len(set(inspected)) == len(inspected)
    assert result["repaired"] == 0
    assert state.candidates(store)["items"] == []
    after = checkpoint(store)
    for table in ("discovery_baselines", "local_file_facts", "local_media"):
        assert after[table] == before[table]
    assert store.frontier() == frontier


def test_catalog_batch_rollback_retains_cursor_and_all_observations(replicas, monkeypatch):
    store, root, _ = replicas[0]
    scan(store, root)
    reach_known(store, root, "retry-batch")
    before = checkpoint(store)
    original = discovery.baseline
    calls = 0

    def interrupted(db, identity, observation):
        nonlocal calls
        original(db, identity, observation)
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic catalog interruption")

    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: 0))
        patch.setattr(discovery, "baseline", interrupted)
        with pytest.raises(RuntimeError, match="synthetic catalog interruption"):
            discovery.known_batch(store, root, "retry-batch", "")
    assert checkpoint(store) == before
    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: 0))
        discovery.known_batch(store, root, "retry-batch", "")
    progress = state.run(store, "retry-batch")
    assert progress["completed"] == progress["total"] > 1
    after = checkpoint(store)
    # An outdated worker cursor cannot repeat a committed page.
    discovery.known_batch(store, root, "retry-batch", "")
    assert checkpoint(store) == after


def test_slow_catalog_batch_yields_at_processed_cursor_and_honors_cancel(replicas, monkeypatch):
    store, root, _ = replicas[0]
    reach_known(store, root, "bounded-checks")
    clock = count()
    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: next(clock)))
        discovery.known_batch(store, root, "bounded-checks", "")
    progress = state.run(store, "bounded-checks")
    assert progress["completed"] == 1 < progress["total"]
    assert progress["cursor"]
    state.cancel(store, "bounded-checks")
    before = checkpoint(store)
    discovery.known_batch(store, root, "bounded-checks", progress["cursor"])
    assert checkpoint(store) == before


def test_cancel_during_source_batch_discards_uncommitted_observations(replicas, monkeypatch):
    store, root, _ = replicas[0]
    state.enqueue(store, "cancel-sources")
    original = discovery_sources.inspect

    def cancel(root, path, cached=None, **kwargs):
        observation = original(root, path, cached, **kwargs)
        state.cancel(store, "cancel-sources")
        return observation

    with monkeypatch.context() as patch:
        patch.setattr(discovery_sources, "inspect", cancel)
        discovery.enumerate_batch(store, root, "cancel-sources")
    result = state.run(store, "cancel-sources")
    assert result["state"] == "cancelled" and result["observed"] == 0
    assert not checkpoint(store)["discovery_entries"]
    assert store not in discovery._walks
    assert scan(store, root)["observed"] > 0


def test_hidden_entries_also_consume_source_time_budget(replicas, monkeypatch):
    store, root, _ = replicas[0]
    state.enqueue(store, "hidden-budget")
    consumed = 0

    def hidden(root):
        nonlocal consumed
        for _ in range(discovery.SCAN_BATCH * 2):
            consumed += 1
            yield None

    clock = count()
    with monkeypatch.context() as patch:
        patch.setattr(discovery_sources, "walk", hidden)
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: next(clock)))
        discovery.enumerate_batch(store, root, "hidden-budget")
    assert consumed == 1
    result = state.run(store, "hidden-budget")
    assert result["phase"] == "walk" and result["observed"] == 0
