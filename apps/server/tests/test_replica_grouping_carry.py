"""A new Update's draft keeps the owner's earlier choices on files that are still there."""

import os

import pytest

from cairndex.replicas import discovery_state as state
from cairndex.replicas.grouping import initialize, storage, validation
from tests.test_replica_discovery import advance_review, scan
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_grouping_acceptance import accept, prepare
from tests.test_replica_grouping_workspace import edit, file_id, node_id
from tests.test_replica_grouping_workspace import review as review


def build(store, run):
    """Build a draft page by page, checking the whole private graph after every page."""
    storage.open_workspace(store, run)
    for _ in range(2000):
        if storage.status(store, run)["state"] == "ready":
            return
        with store.connection() as db:
            initialize.step(db, run)
            validation.validate(db)
    pytest.fail("Grouping draft did not finish its bounded copy")


def update(store, root):
    run = scan(store, root)["id"]
    build(store, run)
    return run


def placement(store, run, path):
    with store.connection(readonly=True) as db:
        return tuple(
            db.execute(
                "SELECT n.id,n.title,n.parent,f.sequence,f.selected FROM grouping_files f "
                "JOIN grouping_nodes n ON n.workspace=f.workspace AND n.id=f.node "
                "WHERE f.workspace=? AND f.path=?",
                (run, path),
            ).fetchone()
        )


def carried(store, run):
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT intent,result FROM grouping_commands WHERE id=?", ("carry:" + run,)
        ).fetchone()
        return tuple(row) if row else None


def test_titles_selection_order_and_placement_carry_to_present_files(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    one = file_id(store, run, "Shelf/Branch/First/one.mp4")
    two = file_id(store, run, "Shelf/Branch/Second/two.mp4")
    poster = file_id(store, run, "Shelf/Branch/First/poster.jpg")
    for operation, intent in (
        ("retitle", {"action": "rename", "node": first, "title": "Reviewed feature"}),
        ("move-file", {"action": "move_file", "node": first, "file": two, "before": one}),
        ("leave-poster", {"action": "select", "file": poster, "selected": False}),
        ("to-top", {"action": "reparent", "node": first, "parent": None}),
    ):
        assert edit(store, run, operation, intent)["state"] == "succeeded"
    # Between Updates a file arrives, one leaves and one changes generation
    (root / "Fresh").mkdir()
    (root / "Fresh" / "arrival.mp4").write_bytes(b"synthetic arrival")
    (root / "Shelf/Other/third.mp4").unlink()
    changed = root / "Shelf/Branch/First/one.mp4"
    os.utime(changed, (changed.stat().st_atime, changed.stat().st_mtime + 10))

    later = update(store, root)
    assert placement(store, later, "Shelf/Branch/Second/two.mp4") == (
        first,
        "Reviewed feature",
        None,
        0,
        1,
    )
    # The changed file keeps the owner's decision; acceptance still checks it afresh
    assert placement(store, later, "Shelf/Branch/First/one.mp4")[:4] == (
        first,
        "Reviewed feature",
        None,
        1,
    )
    assert placement(store, later, "Shelf/Branch/First/poster.jpg")[4] == 0
    assert placement(store, later, "Fresh/arrival.mp4")[1:] == ("Fresh", None, 0, 1)
    with store.connection(readonly=True) as db:
        # The left-behind sidecars stay in their own bundle; the gone file's is removed
        second = db.execute(
            "SELECT count(*) FROM grouping_files f JOIN grouping_nodes n ON "
            "n.workspace=f.workspace AND n.id=f.node WHERE f.workspace=? "
            "AND n.directory='Shelf/Branch/Second'",
            (later,),
        ).fetchone()[0]
        assert second == 2
        assert not db.execute(
            "SELECT 1 FROM grouping_nodes WHERE workspace=? AND directory='Shelf/Other'",
            (later,),
        ).fetchone()
    assert carried(store, later) is not None
    status = storage.status(store, later)
    assert (status["state"], status["revision"]) == ("ready", 1)

    # A carried draft is itself the latest choice, so the next Update keeps it too
    final = update(store, root)
    assert placement(store, final, "Shelf/Branch/Second/two.mp4")[1] == "Reviewed feature"


def test_a_merged_collection_carries_beside_the_fresh_split(review):
    store, root, run = review
    branch = node_id(store, run, "Shelf/Branch")
    result = edit(store, run, "merge", {"action": "kind", "node": branch, "kind": "bundle"})
    assert result["state"] == "succeeded"
    later = update(store, root)
    merged = {
        placement(store, later, path)[0]
        for path in ("Shelf/Branch/First/one.mp4", "Shelf/Branch/Second/two.mp4")
    }
    assert len(merged) == 1
    with store.connection(readonly=True) as db:
        kinds = {
            row[0]
            for row in db.execute(
                "SELECT kind FROM grouping_nodes WHERE workspace=? "
                "AND directory LIKE 'Shelf/Branch%'",
                (later,),
            )
        }
    # The fresh First and Second bundles and the Branch collection emptied and were removed
    assert kinds == {"bundle"}


def test_no_edit_leaves_the_fresh_draft(review):
    store, root, _ = review
    later = update(store, root)
    assert carried(store, later) is None


def test_a_refused_acceptance_carries_its_choices_into_the_next_update(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    result = edit(store, run, "retitle", {"action": "rename", "node": first, "title": "Kept"})
    assert result["state"] == "succeeded"
    prepared = prepare(store, root, run, "accept-before-change")
    changed = root / "Shelf/Branch/First/one.mp4"
    os.utime(changed, (changed.stat().st_atime, changed.stat().st_mtime + 10))
    state.accept(store, prepared["id"], prepared["receipt"])
    refused = advance_review(store, root, prepared["id"])
    assert refused["state"] == "failed"
    assert "run Update" in refused["error"]

    later = update(store, root)
    assert placement(store, later, "Shelf/Branch/First/one.mp4")[1] == "Kept"
    accept(store, root, prepare(store, root, later, "accept-after-update"))


def test_a_prepared_review_in_progress_is_not_carried(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    result = edit(store, run, "retitle", {"action": "rename", "node": first, "title": "Held"})
    assert result["state"] == "succeeded"
    prepare(store, root, run, "still-deciding")
    later = update(store, root)
    assert carried(store, later) is None
    assert placement(store, later, "Shelf/Branch/First/one.mp4")[1] != "Held"


def test_an_existing_collection_placement_carries_with_its_captured_basis(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    intent = {"action": "reparent", "node": first, "collection": "collections-child"}
    assert edit(store, run, "place", intent)["state"] == "succeeded"
    later = update(store, root)
    parent = placement(store, later, "Shelf/Branch/First/one.mp4")[2]
    with store.connection(readonly=True) as db:
        earlier, now = (
            db.execute(
                "SELECT collection,collection_basis,context FROM grouping_nodes "
                "WHERE workspace=? AND id=(SELECT parent FROM grouping_nodes "
                "WHERE workspace=? AND id=?)",
                (workspace, workspace, first),
            ).fetchone()
            for workspace in (run, later)
        )
    assert parent is not None
    assert tuple(now) == tuple(earlier)
    assert now["collection"] == "collections-child"
    accept(store, root, prepare(store, root, later, "accept-placed"))


def test_a_large_carry_runs_in_bounded_pages(replicas):
    store, root, _ = replicas[0]
    folder = root / "Episodes"
    folder.mkdir()
    for index in range(120):
        for suffix in ("mp4", "srt"):
            (folder / f"episode{index:04}.{suffix}").write_bytes(f"synthetic {index}".encode())
    run = update(store, root)
    with store.connection(readonly=True) as db:
        episodes = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND directory='Episodes' "
            "AND kind='container'",
            (run,),
        ).fetchone()[0]
    for operation, intent in (
        ("none", {"action": "select", "selected": False}),
        ("retitle", {"action": "rename", "node": episodes, "title": "Season"}),
    ):
        assert edit(store, run, operation, intent)["state"] == "succeeded"
    later = scan(store, root)["id"]
    storage.open_workspace(store, later)
    pages = 0
    for _ in range(2000):
        if storage.status(store, later)["state"] == "ready":
            break
        with store.connection() as db:
            phase = db.execute(
                "SELECT phase FROM grouping_workspaces WHERE id=?", (later,)
            ).fetchone()[0]
            before = db.total_changes
            initialize.step(db, later)
            if phase == "carry":
                pages += 1
                # A page copies at most one batch of files with their short ancestor chains
                assert db.total_changes - before <= 8 * initialize.BATCH
    assert pages > 240 // initialize.BATCH
    status = storage.status(store, later)
    assert (status["files"], status["selected"]) == (240, 0)
    assert placement(store, later, "Episodes/episode0000.mp4")[2] == episodes
    with store.connection(readonly=True) as db:
        title = db.execute(
            "SELECT title FROM grouping_nodes WHERE workspace=? AND id=?", (later, episodes)
        ).fetchone()[0]
    assert title == "Season"


def test_a_placement_in_a_deleted_collection_moves_to_the_nearest_ancestor(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    intent = {"action": "reparent", "node": first, "collection": "collections-child"}
    assert edit(store, run, "place", intent)["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        earlier = db.execute(
            "SELECT p.parent FROM grouping_nodes n JOIN grouping_nodes p ON "
            "p.workspace=n.workspace AND p.id=n.parent WHERE n.workspace=? AND n.id=?",
            (run, first),
        ).fetchone()[0]
    # A catalog deletion needs its whole reference cascade; naming a collection
    # the catalog does not have is the same absence as far as the carry can see.
    with store.connection() as db:
        db.execute(
            "UPDATE grouping_nodes SET collection='collections-gone' "
            "WHERE workspace=? AND collection='collections-child'",
            (run,),
        )
    later = update(store, root)
    assert placement(store, later, "Shelf/Branch/First/one.mp4")[2] == earlier
    accept(store, root, prepare(store, root, later, "accept-moved-up"))
