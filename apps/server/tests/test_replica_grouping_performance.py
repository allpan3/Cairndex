"""Small-subject conversions batch private planning without changing authored data."""

from types import SimpleNamespace

from cairndex.replicas.grouping import regroup, storage, worker
from cairndex.replicas.recovery_validation import validate_snapshot
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_grouping_workspace import build, edit


def test_many_subject_conversion_keeps_selection_and_avoids_per_subject_commits(
    replicas, monkeypatch
):
    store, root, _ = replicas[0]
    folder = root / "Episodes"
    folder.mkdir()
    for index in range(120):
        for suffix in ("mp4", "srt"):
            (folder / f"episode{index:04}.{suffix}").write_bytes(
                f"synthetic {index} {suffix}".encode()
            )
    run = scan(store, root)["id"]
    build(store, run)
    frontier = store.frontier()
    source_bytes = {path.name: path.read_bytes() for path in folder.iterdir()}
    with store.connection(readonly=True) as db:
        group = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND directory='Episodes' "
            "AND kind='container'",
            (run,),
        ).fetchone()[0]
        unchecked = db.execute(
            "SELECT id FROM grouping_files WHERE workspace=? ORDER BY path LIMIT 1", (run,)
        ).fetchone()[0]
    assert (
        edit(
            store,
            run,
            "leave-one",
            {
                "action": "select",
                "file": unchecked,
                "selected": False,
            },
        )["state"]
        == "succeeded"
    )
    assert (
        edit(store, run, "merge", {"action": "kind", "node": group, "kind": "bundle"})["state"]
        == "succeeded"
    )
    with store.connection(readonly=True) as db:
        before = [
            tuple(row)
            for row in db.execute(
                "SELECT id,path,selected FROM grouping_files WHERE workspace=? ORDER BY id", (run,)
            )
        ]
    storage.enqueue(
        store,
        run,
        "split",
        storage.status(store, run)["revision"],
        {"action": "kind", "node": group, "kind": "container"},
    )
    worker.step(store)
    # With time available, one pass copies several cached pages. The visible
    # graph remains intact until the later atomic splice.
    with monkeypatch.context() as patch:
        patch.setattr(regroup, "time", SimpleNamespace(monotonic=lambda: 0))
        worker.step(store)
    with store.connection(readonly=True) as db:
        assert (
            db.execute(
                "SELECT count(*) FROM discovery_plan_files WHERE run=?", (regroup.scratch("split"),)
            ).fetchone()[0]
            == 240
        )
        assert (
            db.execute(
                "SELECT kind FROM grouping_nodes WHERE workspace=? AND id=?", (run, group)
            ).fetchone()[0]
            == "bundle"
        )
    steps = 2
    while storage.command(store, "split")["state"] in {"queued", "running"}:
        worker.step(store)
        steps += 1
        assert steps < 80, "A small-subject split must batch its durable planning writes"
    assert storage.command(store, "split")["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        after = [
            tuple(row)
            for row in db.execute(
                "SELECT id,path,selected FROM grouping_files WHERE workspace=? ORDER BY id", (run,)
            )
        ]
        assert after == before
        assert (
            db.execute(
                "SELECT count(*) FROM grouping_nodes WHERE workspace=? AND parent=?", (run, group)
            ).fetchone()[0]
            == 120
        )
    validate_snapshot(store.path, store.descriptor)
    assert store.frontier() == frontier
    assert source_bytes == {path.name: path.read_bytes() for path in folder.iterdir()}
