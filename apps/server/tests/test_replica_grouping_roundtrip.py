"""Conversion keeps same-named subjects in separate physical folders."""

from cairndex.replicas.grouping import pages, storage, worker
from cairndex.replicas.recovery_validation import validate_snapshot
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_grouping_workspace import build, edit


def test_multifolder_conversion_keeps_sidecars_titles_and_selection_after_retry(replicas):
    store, root, _ = replicas[0]
    originals = {}
    for index in range(12):
        folder = root / "Series" / f"Feature{index:03}"
        folder.mkdir(parents=True)
        for name in ("episode.mp4", "episode.en.srt", "poster.png"):
            path = folder / name
            path.write_bytes(f"synthetic {index} {name}".encode())
            originals[path.relative_to(root).as_posix()] = path.read_bytes()
    run = scan(store, root)["id"]
    build(store, run)
    frontier = store.frontier()
    with store.connection(readonly=True) as db:
        header = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND directory='Series' "
            "AND kind='container'",
            (run,),
        ).fetchone()[0]
        unchecked = db.execute(
            "SELECT id FROM grouping_files WHERE workspace=? ORDER BY path LIMIT 1", (run,)
        ).fetchone()[0]
    assert (
        edit(store, run, "leave-one", {"action": "select", "file": unchecked, "selected": False})[
            "state"
        ]
        == "succeeded"
    )
    assert (
        edit(store, run, "merge-folders", {"action": "kind", "node": header, "kind": "bundle"})[
            "state"
        ]
        == "succeeded"
    )
    with store.connection(readonly=True) as db:
        before = list(
            db.execute(
                "SELECT id,path,selected FROM grouping_files WHERE workspace=? ORDER BY id", (run,)
            )
        )
    storage.enqueue(
        store,
        run,
        "split-folders",
        storage.status(store, run)["revision"],
        {"action": "kind", "node": header, "kind": "container"},
    )
    for _ in range(50):
        worker.step(store)
        if storage.command(store, "split-folders")["phase"] == "plan":
            break
    else:
        raise AssertionError("The split must finish its bounded source copy")
    worker.step(store)
    with store.connection() as db:
        storage.pause_recovered(db)
    validate_snapshot(store.path, store.descriptor)
    storage.retry(store, "split-folders")
    for _ in range(100):
        if storage.command(store, "split-folders")["state"] == "succeeded":
            break
        worker.step(store)
    else:
        raise AssertionError("The retained split must finish after retry")
    revision = storage.status(store, run)["revision"]
    with store.connection(readonly=True) as db:
        after = list(
            db.execute(
                "SELECT id,path,selected FROM grouping_files WHERE workspace=? ORDER BY id", (run,)
            )
        )
        assert [tuple(row) for row in after] == [tuple(row) for row in before]
        children = pages.nodes(db, run, revision, header)["items"]
        assert len(children) == 12
        assert {child["title"] for child in children} == {
            f"Feature{index:03}" for index in range(12)
        }
        for child in children:
            assert child["kind"] == "bundle" and child["files"] == 3
            assert child["directory"] == "Series/" + child["title"]
            files = pages.files(db, run, revision, child["id"])["items"]
            assert {file["path"].rsplit("/", 1)[0] for file in files} == {child["directory"]}
            assert (
                next(file for file in files if file["path"].endswith(".srt"))["role"] == "SUBTITLE"
            )
    validate_snapshot(store.path, store.descriptor)
    assert store.frontier() == frontier
    assert all((root / path).read_bytes() == content for path, content in originals.items())
