"""Editable review uses bounded private pages without publishing discovered files."""

import pytest

from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.grouping import initialize, pages, storage, worker
from cairndex.replicas.protocol import ReplicaError
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen


def build(store, run):
    storage.open_workspace(store, run)
    for _ in range(1000):
        if storage.status(store, run)["state"] == "ready":
            return
        with store.connection() as db:
            before = db.execute("SELECT count(*) FROM grouping_files").fetchone()[0]
            initialize.step(db, run)
            assert (
                db.execute("SELECT count(*) FROM grouping_files").fetchone()[0] - before
                <= initialize.BATCH
            )
    pytest.fail("Grouping draft did not finish its bounded copy")


@pytest.fixture
def review(replicas):
    store, root, _ = replicas[0]
    for folder, names in (
        ("Shelf/Branch/First", ("one.mp4", "one.srt", "poster.jpg")),
        ("Shelf/Branch/Second", ("two.mp4", "two.srt", "other.png")),
        ("Shelf/Other", ("third.mp4",)),
    ):
        path = root / folder
        path.mkdir(parents=True)
        for name in names:
            (path / name).write_bytes(("synthetic " + folder + "/" + name).encode())
    run = scan(store, root)["id"]
    build(store, run)
    return store, root, run


def edit(store, run, operation, intent, *, revision=None):
    revision = storage.status(store, run)["revision"] if revision is None else revision
    storage.enqueue(store, run, operation, revision, intent)
    for _ in range(1000):
        worker.step(store)
        result = storage.command(store, operation)
        if result["state"] in {"succeeded", "failed"}:
            return result
    pytest.fail("Private edit did not finish")


def node_id(store, run, directory):
    with store.connection(readonly=True) as db:
        return db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND directory=?", (run, directory)
        ).fetchone()[0]


def file_id(store, run, path):
    with store.connection(readonly=True) as db:
        return db.execute(
            "SELECT id FROM grouping_files WHERE workspace=? AND path=?", (run, path)
        ).fetchone()[0]


def test_bundle_summaries_and_exact_sibling_selection_do_not_include_other_branches(review):
    store, _, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    second = node_id(store, run, "Shelf/Branch/Second")
    branch = node_id(store, run, "Shelf/Branch")
    revision = storage.status(store, run)["revision"]
    with store.connection(readonly=True) as db:
        siblings = pages.nodes(db, run, revision, branch)["items"]
        assert len(siblings) == 2
        assert all(
            row["media_counts"] == {"video": 1, "subtitle": 1, "image": 1} for row in siblings
        )
    intent = {"action": "select", "nodes": [first, second], "selected": False}
    result = edit(store, run, "skip-displayed-siblings", intent)
    assert result["state"] == "succeeded"
    assert storage.status(store, run)["selected"] == 1
    assert storage.enqueue(store, run, "skip-displayed-siblings", revision, intent) == result
    assert storage.status(store, run)["selected"] == 1
    # Invalid or structural destinations must not change even the valid first member.
    refused = edit(store, run, "bad-sibling", intent | {"nodes": [first, branch], "selected": True})
    assert refused["state"] == "failed"
    assert storage.status(store, run)["selected"] == 1
    for index, identities in enumerate(([], [first, first], [first] * 51)):
        rejected = edit(store, run, f"bad-siblings-{index}", intent | {"nodes": identities})
        assert rejected["state"] == "failed"
    with store.connection() as db:
        db.execute(
            "UPDATE grouping_nodes SET confidence=0.5 WHERE workspace=? AND id=?", (run, first)
        )
        page = pages.attention(db, run, storage.status(store, run)["revision"])
        assert next(row for row in page["items"] if row["id"] == first)["media_counts"] == {
            "video": 1,
            "subtitle": 1,
            "image": 1,
        }


def test_fresh_sibling_order_is_natural_and_unrelated_stem_edits_keep_it(replicas):
    store, root, _ = replicas[0]
    for name in ("Gamma", "Alpha", "Delta", "Beta"):
        directory = root / "Series" / name
        directory.mkdir(parents=True)
        for extension in ("mp4", "srt"):
            (directory / f"feature.{extension}").write_bytes(
                f"synthetic {name} {extension}".encode()
            )
    renditions = root / "Renditions"
    renditions.mkdir()
    for label in ("720p", "1080p"):
        (renditions / f"scene.{label}.mp4").write_bytes(f"synthetic {label}".encode())
    run = scan(store, root)["id"]
    build(store, run)
    series = node_id(store, run, "Series")

    def names():
        with store.connection(readonly=True) as db:
            return [
                item["title"]
                for item in pages.nodes(
                    db,
                    run,
                    storage.status(store, run)["revision"],
                    series,
                )["items"]
            ]

    assert names() == ["Alpha", "Beta", "Delta", "Gamma"]
    for level in (0, 1):
        rendition = node_id(store, run, "Renditions")
        result = edit(
            store, run, f"stem-order-{level}", {"action": "stem", "node": rendition, "level": level}
        )
        assert result["state"] == "succeeded"
        assert names() == ["Alpha", "Beta", "Delta", "Gamma"]
    assert (
        edit(
            store,
            run,
            "manual-sibling-order",
            {
                "action": "reparent",
                "node": node_id(store, run, "Series/Gamma"),
                "parent": series,
                "before": node_id(store, run, "Series/Beta"),
            },
        )["state"]
        == "succeeded"
    )
    for level in (0, 1):
        result = edit(
            store,
            run,
            f"manual-stem-order-{level}",
            {
                "action": "stem",
                "node": node_id(store, run, "Renditions"),
                "level": level,
            },
        )
        assert result["state"] == "succeeded"
        assert names() == ["Alpha", "Gamma", "Beta", "Delta"]


def test_private_tree_pages_cover_unloaded_groups_and_root_stem_cursor(replicas):
    store, root, _ = replicas[0]
    for index in range(64):
        folder = root / f"Shelf/Feature{index:03}"
        folder.mkdir(parents=True)
        for suffix in ("mp4", "srt"):
            (folder / f"scene.{suffix}").write_bytes(f"synthetic {index} {suffix}".encode())
    for suffix in ("mp4", "srt"):
        (root / f"root-scene.{suffix}").write_bytes(f"synthetic root {suffix}".encode())
    run = scan(store, root)["id"]
    with store.connection(readonly=True) as db:
        before = [tuple(row) for row in db.execute("SELECT id,raw FROM events ORDER BY id")]
    build(store, run)
    status = storage.status(store, run)
    assert (status["files"], status["selected"], status["bundles"]) == (130, 130, 65)
    revision = status["revision"]
    with store.connection(readonly=True) as db:
        roots = pages.nodes(db, run, revision)["items"]
        shelf = next(node for node in roots if node["directory"] == "Shelf")
        assert (shelf["files"], shelf["selected"], shelf["bundles"], shelf["children"]) == (
            128,
            128,
            64,
            64,
        )
        collected = []
        after = -1
        while True:
            page = pages.nodes(db, run, revision, shelf["id"], after, 7)
            assert len(page["items"]) <= 7
            collected.extend(page["items"])
            if page["next_cursor"] is None:
                break
            after = page["next_cursor"]
        assert len({node["id"] for node in collected}) == 64
        assert [node["directory"] for node in collected] == [
            f"Shelf/Feature{index:03}" for index in range(64)
        ]
        files = pages.files(db, run, revision, collected[0]["id"], limit=1)
        assert files["next_cursor"] is not None
        remaining = pages.files(db, run, revision, collected[0]["id"], files["next_cursor"], 1)
        assert remaining["next_cursor"] is None
        assert files["items"][0]["id"] != remaining["items"][0]["id"]
        first = pages.stems(db, run, revision, limit=1)
        assert first["items"][0]["directory"] == ""
        assert first["next_cursor"] == ""
        second = pages.stems(db, run, revision, after=first["next_cursor"], limit=1)
        assert second["items"][0]["directory"] != ""
        assert [tuple(row) for row in db.execute("SELECT id,raw FROM events ORDER BY id")] == before
        assert (
            db.execute("SELECT count(*) FROM catalog_rows WHERE family='asset_files'").fetchone()[0]
            == 2
        )
        with pytest.raises(ReplicaError, match="draft changed"):
            pages.nodes(db, run, revision - 1)


def test_private_edits_retry_exactly_and_group_selection_covers_descendants(review):
    store, _, run = review
    shelf = node_id(store, run, "Shelf")
    branch = node_id(store, run, "Shelf/Branch")
    revision = storage.status(store, run)["revision"]
    intent = {"action": "rename", "node": shelf, "title": "Reviewed shelf"}
    result = edit(store, run, "rename-shelf", intent)
    assert result["state"] == "succeeded"
    assert storage.enqueue(store, run, "rename-shelf", revision, intent) == result
    assert storage.status(store, run)["revision"] == revision + 1
    with pytest.raises(ReplicaError, match="reused"):
        storage.enqueue(store, run, "rename-shelf", revision, intent | {"title": "Different"})
    stale = edit(store, run, "old-edit", intent | {"title": "Stale"}, revision=revision)
    assert stale["state"] == "failed" and "draft changed" in stale["error"]
    assert (
        edit(store, run, "skip-branch", {"action": "select", "node": branch, "selected": False})[
            "state"
        ]
        == "succeeded"
    )
    assert storage.status(store, run)["selected"] == 1
    with store.connection(readonly=True) as db:
        current = storage.status(store, run)["revision"]
        root = next(item for item in pages.nodes(db, run, current)["items"] if item["id"] == shelf)
        assert root["title"] == "Reviewed shelf"
        assert (root["files"], root["selected"], root["bundles"]) == (7, 1, 3)
    cycle = edit(store, run, "cycle", {"action": "reparent", "node": shelf, "parent": branch})
    assert cycle["state"] == "failed" and "itself" in cycle["error"]
    omitted = edit(store, run, "no-parent", {"action": "reparent", "node": branch})
    assert omitted["state"] == "failed"
    moved = edit(store, run, "root-branch", {"action": "reparent", "node": branch, "parent": None})
    assert moved["state"] == "succeeded"
    assert storage.status(store, run)["selected"] == 1


def test_file_moves_keep_identity_selection_order_and_roles_across_restart(review):
    store, _, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    second = node_id(store, run, "Shelf/Branch/Second")
    one = file_id(store, run, "Shelf/Branch/First/one.mp4")
    two = file_id(store, run, "Shelf/Branch/Second/two.mp4")
    assert (
        edit(store, run, "skip-first", {"action": "select", "node": first, "selected": False})[
            "state"
        ]
        == "succeeded"
    )
    revision = storage.status(store, run)["revision"]
    intent = {"action": "move_file", "file": one, "node": second, "before": two}
    storage.enqueue(store, run, "move-video", revision, intent)
    worker.step(store)
    assert storage.status(store, run)["state"] == "editing"
    reopened = CatalogStore(store.path.parent, store.descriptor)
    for _ in range(100):
        worker.step(reopened)
        if storage.command(reopened, "move-video")["state"] == "succeeded":
            break
    else:
        pytest.fail("Interrupted private edit did not finish")
    assert storage.enqueue(reopened, run, "move-video", revision, intent)["state"] == "succeeded"
    from cairndex.replicas.recovery_validation import validate_snapshot

    validate_snapshot(reopened.path, reopened.descriptor)
    with reopened.connection(readonly=True) as db:
        files = pages.files(db, run, storage.status(reopened, run)["revision"], second)["items"]
        assert [file["id"] for file in files[:2]] == [one, two]
        assert [file["role"] for file in files[:2]] == ["PRIMARY_VIDEO", "ALTERNATE_VERSION"]
        assert files[0]["selected"] is False and files[1]["selected"] is True
        assert (
            db.execute("SELECT count(*) FROM grouping_files WHERE workspace=?", (run,)).fetchone()[
                0
            ]
            == 7
        )
        assert (
            db.execute("SELECT count(*) FROM catalog_rows WHERE family='asset_files'").fetchone()[0]
            == 2
        )


def test_stem_edit_preserves_folder_rename_placement_selection_and_dragged_files(review):
    store, _, run = review
    branch = node_id(store, run, "Shelf/Branch")
    first = node_id(store, run, "Shelf/Branch/First")
    second = node_id(store, run, "Shelf/Branch/Second")
    one = file_id(store, run, "Shelf/Branch/First/one.mp4")
    assert (
        edit(
            store,
            run,
            "rename-branch",
            {
                "action": "rename",
                "node": branch,
                "title": "Reviewed branch",
            },
        )["state"]
        == "succeeded"
    )
    assert (
        edit(
            store,
            run,
            "move-branch",
            {
                "action": "reparent",
                "node": branch,
                "parent": None,
            },
        )["state"]
        == "succeeded"
    )
    assert (
        edit(
            store,
            run,
            "drag-out",
            {
                "action": "move_file",
                "node": second,
                "file": one,
            },
        )["state"]
        == "succeeded"
    )
    assert (
        edit(
            store,
            run,
            "unselect-sidecars",
            {
                "action": "select",
                "node": first,
                "selected": False,
            },
        )["state"]
        == "succeeded"
    )
    assert (
        edit(
            store,
            run,
            "narrow-first",
            {
                "action": "stem",
                "node": first,
                "level": 0,
            },
        )["state"]
        == "succeeded"
    )
    with store.connection(readonly=True) as db:
        folder = db.execute(
            "SELECT * FROM grouping_nodes WHERE workspace=? AND id=?", (run, branch)
        ).fetchone()
        assert folder["title"] == "Reviewed branch" and folder["parent"] is None
        assert (
            db.execute(
                "SELECT node FROM grouping_files WHERE workspace=? AND id=?", (run, one)
            ).fetchone()[0]
            == second
        )
        assert (
            db.execute(
                "SELECT count(*) FROM grouping_files WHERE workspace=? AND selected=0", (run,)
            ).fetchone()[0]
            == 2
        )
        assert (
            db.execute("SELECT count(*) FROM grouping_files WHERE workspace=?", (run,)).fetchone()[
                0
            ]
            == 7
        )


def test_collection_conversion_splits_parts_with_their_strict_sidecars_and_no_nesting(replicas):
    store, root, _ = replicas[0]
    path = root / "Serial"
    path.mkdir()
    names = [
        "episode.part1.mp4",
        "episode.part1.en.srt",
        "episode.part2.mp4",
        "episode.part2.en.srt",
    ]
    for name in names:
        (path / name).write_bytes(("synthetic " + name).encode())
    run = scan(store, root)["id"]
    build(store, run)
    folder = node_id(store, run, "Serial")
    result = edit(
        store, run, "split-parts", {"action": "kind", "node": folder, "kind": "container"}
    )
    assert result["state"] == "succeeded", result
    with store.connection(readonly=True) as db:
        children = pages.nodes(db, run, storage.status(store, run)["revision"], folder)["items"]
        assert len(children) == 2 and all(child["files"] == 2 for child in children)
        for child in children:
            files = pages.files(db, run, storage.status(store, run)["revision"], child["id"])[
                "items"
            ]
            assert files[0]["media_kind"] == "video" and files[1]["role"] == "SUBTITLE"
    rejected = edit(
        store,
        run,
        "redundant-child",
        {
            "action": "kind",
            "node": children[0]["id"],
            "kind": "container",
        },
    )
    assert rejected["state"] == "failed" and "no structure" in rejected["error"]
    assert storage.status(store, run)["state"] == "ready"
    merged = edit(store, run, "merge-parts", {"action": "kind", "node": folder, "kind": "bundle"})
    assert merged["state"] == "succeeded", merged
    with store.connection(readonly=True) as db:
        files = pages.files(db, run, storage.status(store, run)["revision"], folder)["items"]
        assert len(files) == 4
        assert [file["role"] for file in files[:2]] == ["VIDEO_PART", "VIDEO_PART"]


@pytest.mark.parametrize("level", [0, 1, 2])
def test_stem_levels_match_established_subject_groups(replicas, level):
    from cairndex.grouping import suggester as rules
    from cairndex.replicas.discovery import media_kind

    store, root, _ = replicas[0]
    names = [
        "a-one.1080p.mp4",
        "a-one.720p.mp4",
        "a-one.en.srt",
        "a-two.mp4",
        "a-two.en.srt",
        "other.png",
    ]
    folder = root / "Batch"
    folder.mkdir()
    for name in names:
        (folder / name).write_bytes(("synthetic " + name).encode())
    run = scan(store, root)["id"]
    build(store, run)
    with store.connection(readonly=True) as db:
        node = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND directory='Batch' "
            "AND kind='container'",
            (run,),
        ).fetchone()[0]
    result = edit(store, run, "set-stem", {"action": "stem", "node": node, "level": level})
    assert result["state"] == "succeeded", result
    observed = [rules.FileObservation(name, "Batch/" + name, media_kind(name)) for name in names]
    expected_groups = rules._bundle_groups(observed, level)
    expected = sorted(sorted(file.relative_path for file in group) for group in expected_groups)
    expected_confidence = {
        tuple(sorted(file.relative_path for file in group)): rules._bundle_proposal(
            group,
            "Batch",
            None,
            owns_directory=False,
            stem_level=level,
        ).confidence
        for group in expected_groups
    }
    with store.connection(readonly=True) as db:
        actual = []
        confidence = {}
        for group in db.execute(
            "SELECT id,confidence FROM grouping_nodes WHERE workspace=? AND directory='Batch' "
            "AND kind='bundle'",
            (run,),
        ):
            paths = sorted(
                row[0]
                for row in db.execute(
                    "SELECT path FROM grouping_files WHERE workspace=? AND node=?",
                    (run, group[0]),
                )
            )
            actual.append(paths)
            confidence[tuple(paths)] = group["confidence"]
    assert sorted(actual) == expected
    assert confidence == expected_confidence


def test_existing_collection_placement_is_shared_readonly_and_pruned(review):
    from cairndex.replicas.recovery_validation import validate_snapshot

    store, _, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    second = node_id(store, run, "Shelf/Branch/Second")
    for index, node in enumerate((first, second)):
        result = edit(
            store,
            run,
            "place-" + str(index),
            {
                "action": "reparent",
                "node": node,
                "collection": "collections-child",
            },
        )
        assert result["state"] == "succeeded", result
    with store.connection(readonly=True) as db:
        context = db.execute(
            "SELECT id FROM grouping_nodes WHERE workspace=? AND context=1", (run,)
        ).fetchall()
        assert len(context) == 2
        children = db.execute(
            "SELECT parent FROM grouping_nodes WHERE workspace=? AND id IN (?,?)",
            (run, first, second),
        ).fetchall()
        assert children[0][0] == children[1][0]
    assert (
        edit(
            store,
            run,
            "rename-context",
            {
                "action": "rename",
                "node": context[0][0],
                "title": "Do not rename a live collection",
            },
        )["state"]
        == "failed"
    )
    assert (
        edit(
            store,
            run,
            "uncheck-existing-context",
            {
                "action": "select",
                "node": context[0][0],
                "selected": False,
            },
        )["state"]
        == "succeeded"
    )
    assert storage.status(store, run)["selected"] == 1
    assert (
        edit(
            store,
            run,
            "check-existing-context",
            {
                "action": "select",
                "node": context[0][0],
                "selected": True,
            },
        )["state"]
        == "succeeded"
    )
    assert storage.status(store, run)["selected"] == 7
    validate_snapshot(store.path, store.descriptor)
    for index, node in enumerate((first, second)):
        assert (
            edit(
                store,
                run,
                "unplace-" + str(index),
                {
                    "action": "reparent",
                    "node": node,
                    "parent": None,
                },
            )["state"]
            == "succeeded"
        )
    with store.connection(readonly=True) as db:
        assert not db.execute(
            "SELECT 1 FROM grouping_nodes WHERE workspace=? AND context=1", (run,)
        ).fetchone()
    validate_snapshot(store.path, store.descriptor)


def test_recovery_detects_a_missing_private_grouping_choice(review, tmp_path):
    from cairndex.persistence.sqlite_durability import connect_writable
    from cairndex.replicas.recovery import previous_gaps, snapshot
    from cairndex.replicas.recovery_validation import validate_snapshot

    store, _, run = review
    previous, prepared = tmp_path / "previous.db", tmp_path / "prepared.db"
    snapshot(store.path, previous)
    snapshot(store.path, prepared)
    with connect_writable(prepared) as db:
        db.execute("DELETE FROM grouping_files WHERE rowid=(SELECT min(rowid) FROM grouping_files)")
    assert previous_gaps(previous, prepared, "synthetic")["grouping_files"] == 1
    with pytest.raises(ReplicaError, match="selection counts"):
        validate_snapshot(prepared, store.descriptor)
    validate_snapshot(previous, store.descriptor)


def test_uncertain_pages_and_search_cover_folded_and_unloaded_branches(review):
    store, _, run = review
    with store.connection() as db:
        db.execute("UPDATE grouping_nodes SET confidence=0.5 WHERE workspace=?", (run,))
    status = storage.status(store, run)
    assert status["uncertain"] == 3
    with store.connection(readonly=True) as db:
        roots = pages.nodes(db, run, status["revision"])["items"]
        assert len(roots) == 1 and roots[0]["kind"] == "container"
        after, found = "", []
        while True:
            page = pages.attention(db, run, status["revision"], after, 1)
            assert len(page["items"]) == 1
            found.append(page["items"][0])
            if page["next_cursor"] is None:
                break
            after = page["next_cursor"]
        assert len({item["id"] for item in found}) == 3
        assert all(item["kind"] == "bundle" and item["files"] for item in found)
        targets = pages.destinations(db, run, status["revision"], "bundle", "sEcOnD", limit=1)
        assert len(targets["items"]) == 1
        assert targets["items"][0]["directory"] == "Shelf/Branch/Second"
        assert targets["next_cursor"] is None
        with pytest.raises(ReplicaError, match="draft changed"):
            pages.attention(db, run, status["revision"] - 1)


def test_visible_file_pages_respect_unloaded_collapsed_folders(review):
    store, _, run = review
    shelf = node_id(store, run, "Shelf")
    assert (
        edit(store, run, "one-large-bundle", {"action": "kind", "node": shelf, "kind": "bundle"})[
            "state"
        ]
        == "succeeded"
    )
    revision = storage.status(store, run)["revision"]
    with store.connection() as db:
        db.executemany(
            "INSERT INTO grouping_folders(workspace,path,node,expanded) VALUES (?,?,?,0)",
            (
                (run, path, shelf)
                for path in (
                    "Shelf/Branch",
                    "Shelf/Branch/First",
                    "Shelf/Branch/Second",
                    "Shelf/Other",
                )
            ),
        )
    with store.connection(readonly=True) as db:
        all_files = pages.files(db, run, revision, shelf)["items"]
        assert len(all_files) == 7
        folders = pages.folders(db, run, revision, shelf, limit=1, visible_only=True)
        assert folders["items"] and folders["next_cursor"] is not None
        assert pages.files(db, run, revision, shelf, visible_only=True)["items"] == []
        first = folders["items"][0]["path"]
    assert (
        edit(
            store,
            run,
            "show-first-folder",
            {"action": "folder", "node": shelf, "folder": first, "expanded": True},
        )["state"]
        == "succeeded"
    )
    revision = storage.status(store, run)["revision"]
    with store.connection(readonly=True) as db:
        visible = pages.files(db, run, revision, shelf, visible_only=True)["items"]
        collapsed = pages.folders(db, run, revision, shelf, visible_only=True)["items"]
        assert all(
            not file["path"].startswith(folder["path"] + "/")
            for file in visible
            for folder in collapsed
            if not folder["expanded"]
        )


def test_file_change_category_filters_before_candidate_paging(review):
    from cairndex.replicas.catalog.model import value_text
    from cairndex.replicas.discovery_state import candidates

    store, _, run = review
    with store.connection() as db:
        for index in range(56):
            body = {
                "kind": "repair" if index == 55 else "new",
                "files": [],
                "title": "Synthetic choice",
                "target": None,
                "reason": "synthetic",
            }
            db.execute(
                "INSERT INTO discovery_candidates(id,run,path,body,state) "
                "VALUES (?,?,?,?,'pending')",
                (f"{index:064x}", run, f"invented/{index}", value_text(body)),
            )
    page = candidates(store, limit=1, file_changes=True)
    assert page["items"][0]["body"]["kind"] == "repair"
    assert page["next_cursor"] is None
