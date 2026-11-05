"""Cached Update work amortizes durable commits while retaining bounded, atomic progress."""

import hashlib
import json
from contextlib import contextmanager
from itertools import count
from types import SimpleNamespace

import pytest

from cairndex.replicas import discovery, discovery_plan
from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.recovery_validation import validate_snapshot
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen


def subjects(root):
    folder = root / "Episodes"
    folder.mkdir()
    for index in range(100):
        for suffix in ("mp4", "srt"):
            (folder / f"episode{index:03}.{suffix}").write_bytes(
                f"synthetic {index} {suffix}".encode()
            )
    return {path: path.read_bytes() for path in folder.iterdir()}


def reach_group(store, root, run, monkeypatch):
    state.enqueue(store, run)
    clock = count()
    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: next(clock)))
        for _ in range(1000):
            if state.run(store, run)["phase"] == "group":
                return
            discovery.tick(store, root)
    pytest.fail("Update did not reach its cached grouping phase")


def candidates(store, run):
    with store.connection(readonly=True) as db:
        return [
            tuple(row)
            for row in db.execute(
                "SELECT id,path,body FROM discovery_candidates WHERE run=? ORDER BY id", (run,)
            )
        ]


def test_enumeration_shares_one_read_snapshot_per_source_batch(replicas, monkeypatch):
    store, root, _ = replicas[0]
    sources = subjects(root)
    state.enqueue(store, "enumeration")
    discovery.enumerate_batch(store, root, "enumeration")
    original = store.connection
    reads, writes = 0, 0

    @contextmanager
    def measured_connection(*, readonly=False):
        nonlocal reads, writes
        reads += int(readonly)
        writes += int(not readonly)
        with original(readonly=readonly) as db:
            yield db

    with monkeypatch.context() as patch:
        patch.setattr(store, "connection", measured_connection)
        discovery.enumerate_batch(store, root, "enumeration")
    assert (reads, writes) == (1, 1)
    assert all(path.read_bytes() == content for path, content in sources.items())


def test_export_pages_preserve_complete_member_order_and_digest(replicas):
    store, root, _ = replicas[0]
    subjects(root)
    run = scan(store, root)["id"]
    with store.connection(readonly=True) as db:
        for candidate in db.execute("SELECT * FROM discovery_candidates WHERE run=?", (run,)):
            body = json.loads(candidate["body"])
            if body.get("version") != 2:
                continue
            expected = db.execute(
                "SELECT f.body,f.role,f.sequence,f.proposal FROM discovery_plan_files f "
                "JOIN discovery_plan_groups g ON g.run=f.run AND g.id=f.proposal "
                "JOIN discovery_candidate_groups c ON c.id=g.id AND c.candidate=? "
                "WHERE f.run=? ORDER BY g.directory,g.id,f.sequence,f.path",
                (candidate["id"], run),
            ).fetchall()
            exported = db.execute(
                "SELECT * FROM discovery_candidate_files WHERE candidate=? ORDER BY position",
                (candidate["id"],),
            ).fetchall()
            assert len(exported) == len(expected) == body["file_count"]
            digest = hashlib.sha256()
            for position, (actual, source) in enumerate(zip(exported, expected, strict=True)):
                member = json.loads(source["body"]) | {
                    "role": source["role"],
                    "sequence": source["sequence"],
                }
                assert actual["position"] == position
                assert actual["group_id"] == source["proposal"]
                assert json.loads(actual["body"]) == member
                digest.update(value_text([source["proposal"], member]).encode() + b"\n")
            assert digest.hexdigest() == body["files_digest"]


def test_cached_batch_rolls_back_and_retry_preserves_complete_suggestions(replicas, monkeypatch):
    store, root, _ = replicas[0]
    sources = subjects(root)
    frontier = store.frontier()
    clock = count()
    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: next(clock)))
        reference = scan(store, root)["id"]
    expected = candidates(store, reference)
    assert expected
    reach_group(store, root, "batched", monkeypatch)

    def checkpoint():
        with store.connection(readonly=True) as db:
            return {
                table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                for table in (
                    "discovery_runs",
                    "discovery_plan_files",
                    "discovery_plan_directories",
                    "discovery_plan_groups",
                    "discovery_plan_folders",
                    "discovery_candidates",
                    "discovery_candidate_groups",
                    "discovery_candidate_files",
                )
            }

    before = checkpoint()
    original = discovery_plan.tick
    calls = 0

    def interrupted(db, run):
        nonlocal calls
        result = original(db, run)
        calls += 1
        if calls == 3:
            raise RuntimeError("synthetic planning interruption")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: 0))
        patch.setattr(discovery_plan, "tick", interrupted)
        with pytest.raises(RuntimeError, match="synthetic planning interruption"):
            discovery.propose_batch(store, "batched")
    assert checkpoint() == before

    # Retry resumes from the committed cursor, with complete candidates identical
    # to the one-step schedule, including sidecars and stable identities.
    with monkeypatch.context() as patch:
        patch.setattr(discovery, "time", SimpleNamespace(monotonic=lambda: 0))
        for _ in range(30):
            discovery.propose_batch(store, "batched")
            if state.run(store, "batched")["state"] == "succeeded":
                break
        else:
            pytest.fail("Cached Update work still requires one commit per subject")
    assert candidates(store, "batched") == expected
    assert store.frontier() == frontier
    assert all(path.read_bytes() == content for path, content in sources.items())
    validate_snapshot(store.path, store.descriptor)


@pytest.mark.parametrize("expired", [False, True])
def test_cached_step_and_time_limits_yield_one_transaction_and_allow_cancel(
    replicas, monkeypatch, expired
):
    store, root, _ = replicas[0]
    subjects(root)
    reach_group(store, root, "bounded", monkeypatch)
    frontier = store.frontier()
    original_step, original_connection = discovery_plan.tick, store.connection
    steps, writes, connection_time = 0, 0, 0

    def measured_step(db, run):
        nonlocal steps
        steps += 1
        return original_step(db, run)

    @contextmanager
    def measured_connection(*, readonly=False):
        nonlocal writes, connection_time
        if not readonly:
            writes += 1
            # A slow connection must not spend the in-transaction work budget.
            connection_time += 1
        with original_connection(readonly=readonly) as db:
            yield db

    clock = count()
    with monkeypatch.context() as patch:
        patch.setattr(discovery_plan, "tick", measured_step)
        patch.setattr(store, "connection", measured_connection)
        patch.setattr(
            discovery,
            "time",
            SimpleNamespace(monotonic=lambda: connection_time + (next(clock) if expired else 0)),
        )
        discovery.propose_batch(store, "bounded")
    assert steps == (1 if expired else 32)
    assert writes == 1
    assert state.run(store, "bounded")["state"] == "running"
    state.cancel(store, "bounded")
    discovery.propose_batch(store, "bounded")
    assert state.run(store, "bounded")["state"] == "cancelled"
    assert store.frontier() == frontier
