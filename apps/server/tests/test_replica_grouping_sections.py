"""Separate review sections page complete populations and keep selection independent."""

from cairndex.replicas.grouping import pages, storage
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_grouping_workspace import build, edit
from tests.test_replica_grouping_workspace import review as review


def test_addition_sections_filter_before_paging_and_keep_tree_selection_separate(replicas):
    store, root, _ = replicas[0]
    for index in range(60):
        folder = root / "Shelf" / f"Feature{index:03}"
        folder.mkdir(parents=True)
        (folder / "scene.mp4").write_bytes(f"synthetic feature {index}".encode())
    run = scan(store, root)["id"]
    build(store, run)
    revision = storage.status(store, run)["revision"]
    with store.connection() as db:
        shelf = pages.nodes(db, run, revision)["items"][0]
        subjects = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND kind='bundle' "
            "ORDER BY position,id",
            (run,),
        ).fetchall()
        # Model many existing-owner additions among the same folded branch.
        # Their identities and generated source observations stay intact.
        db.executemany(
            "UPDATE grouping_nodes SET target='bundle-000000',original_target='bundle-000000',"
            "target_title='Existing feature',confidence=0.5 WHERE workspace=? AND id=?",
            ((run, row[0]) for row in subjects[:55]),
        )
        first = pages.additions(db, run, revision, limit=50)
        second = pages.additions(db, run, revision, first["next_cursor"], limit=50)
        assert len(first["items"]) == 50 and len(second["items"]) == 5
        assert second["next_cursor"] is None
        assert len({row["id"] for row in first["items"] + second["items"]}) == 55
        tree = pages.nodes(db, run, revision, exclude_additions=True)["items"]
        assert len(tree) == 1 and tree[0]["id"] == shelf["id"]
        assert (tree[0]["files"], tree[0]["selected"], tree[0]["bundles"]) == (5, 5, 5)
        assert tree[0]["children"] == 5
        children = pages.nodes(db, run, revision, shelf["id"], exclude_additions=True)
        assert len(children["items"]) == 5
        assert children["next_cursor"] is None
        assert all(row["target"] is None for row in children["items"])
        attention = pages.attention(db, run, revision, exclude_additions=True)
        assert all(row["target"] is None for row in attention["items"])
        assert len(pages.additions(db, run, revision, uncertain=True)["items"]) == 50

    result = edit(
        store,
        run,
        "uncheck-new-groups",
        {
            "action": "select",
            "node": shelf["id"],
            "selected": False,
            "exclude_additions": True,
        },
    )
    assert result["state"] == "succeeded"
    assert storage.status(store, run)["selected"] == 55
    with store.connection(readonly=True) as db:
        revision = storage.status(store, run)["revision"]
        assert pages.nodes(db, run, revision, exclude_additions=True)["items"][0]["selected"] == 0
        assert all(
            row["selected"] == row["files"] for row in pages.additions(db, run, revision)["items"]
        )

    assert (
        edit(store, run, "uncheck-all", {"action": "select", "selected": False})["state"]
        == "succeeded"
    )
    assert storage.status(store, run)["selected"] == 0


def test_addition_only_collection_is_not_an_empty_suggestion_section(review):
    store, _, run = review
    with store.connection() as db:
        db.execute(
            "UPDATE grouping_nodes SET target='bundle-000000' WHERE workspace=? AND kind='bundle'",
            (run,),
        )
        revision = storage.status(store, run)["revision"]
        assert pages.nodes(db, run, revision, exclude_additions=True)["items"] == []
        assert len(pages.additions(db, run, revision)["items"]) == 3
