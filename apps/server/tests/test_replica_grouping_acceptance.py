"""Edited private grouping uses the existing immutable review and exact catalog receipts."""

import json

import pytest

from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import AUTHORED
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.grouping import pages, storage, worker
from cairndex.replicas.recovery_validation import validate_snapshot
from tests.test_replica_catalog import edit as field_edit
from tests.test_replica_catalog import save
from tests.test_replica_discovery import advance_review, scan
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import specimen as specimen
from tests.test_replica_discovery_staged import staged as staged
from tests.test_replica_grouping_workspace import build, edit, file_id, node_id
from tests.test_replica_grouping_workspace import review as review


def prepare(store, root, run, operation):
    result = edit(store, run, operation, {"action": "prepare"})
    assert result["state"] == "succeeded", result
    review = advance_review(store, root, operation)
    assert review["state"] == "ready", review
    return review


def accept(store, root, review):
    state.accept(store, review["id"], review["receipt"])
    result = advance_review(store, root, review["id"])
    assert result["state"] == "applied", result
    return result


def reconcile(store, run):
    for _ in range(1000):
        worker.step(store)
        status = storage.status(store, run)
        if status["state"] == "ready" and status["accepting"] is None:
            return status
    pytest.fail("Accepted private grouping did not finish reconciliation")


def test_edited_selection_accepts_exact_members_placement_and_order(review):
    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    one = file_id(store, run, "Shelf/Branch/First/one.mp4")
    two = file_id(store, run, "Shelf/Branch/Second/two.mp4")
    poster = file_id(store, run, "Shelf/Branch/First/poster.jpg")
    for operation, intent in (
        ("retitle", {"action": "rename", "node": first, "title": "Reviewed feature"}),
        ("move-file", {"action": "move_file", "node": first, "file": two, "before": one}),
        ("place", {"action": "reparent", "node": first, "collection": "collections-child"}),
        ("leave-poster", {"action": "select", "file": poster, "selected": False}),
    ):
        assert edit(store, run, operation, intent)["state"] == "succeeded"
    prepared = prepare(store, root, run, "accept-edits")
    assert prepared["prepared"]["file_count"] == 6
    validate_snapshot(store.path, store.descriptor)
    assert (
        edit(
            store,
            run,
            "edit-frozen",
            {
                "action": "rename",
                "node": first,
                "title": "Not in the displayed review",
            },
        )["state"]
        == "failed"
    )
    applied = accept(store, root, prepared)
    result = reconcile(store, run)
    assert (result["files"], result["selected"]) == (1, 0)
    assert state.accept(store, applied["id"], applied["receipt"])["event"] == applied["event"]
    with store.connection(readonly=True) as db:
        target = db.execute(
            "SELECT target FROM grouping_nodes WHERE workspace=? AND id=?", (run, first)
        ).fetchone()[0]
        assert read_row(db, "asset_bundles", target)["title"] == "Reviewed feature"
        members = [
            json.loads(row[0])
            for row in db.execute(
                "SELECT body FROM catalog_rows WHERE family='asset_files' "
                "AND json_extract(body,'$.bundle_id')=? ORDER BY json_extract(body,'$.sequence')",
                (target,),
            )
        ]
        assert [row["relative_path"] for row in members[:2]] == [
            "Shelf/Branch/Second/two.mp4",
            "Shelf/Branch/First/one.mp4",
        ]
        assert [row["role"] for row in members[:2]] == ["PRIMARY_VIDEO", "ALTERNATE_VERSION"]
        assert read_row(db, "asset_bundle_collections", target + "~collections-child")
        assert pages.files(db, run, result["revision"], first)["items"][0]["id"] == poster
    assert len(list((root / "Shelf").rglob("*.*"))) == 7
    validate_snapshot(store.path, store.descriptor)


def test_changed_sources_fail_without_catalog_writes_and_the_draft_can_unlock(review):
    store, root, run = review
    prepared = prepare(store, root, run, "changed-source")
    frontier = store.frontier()
    (root / "Shelf/Other/third.mp4").write_bytes(b"different synthetic bytes")
    state.accept(store, prepared["id"], prepared["receipt"])
    failed = advance_review(store, root, prepared["id"])
    assert failed["state"] == "failed" and store.frontier() == frontier
    assert storage.status(store, run)["accepting"] == prepared["id"]
    result = edit(
        store,
        run,
        "back-to-draft",
        {
            "action": "cancel_review",
            "review": prepared["id"],
        },
    )
    assert result["state"] == "succeeded"
    assert storage.status(store, run)["files"] == 7
    assert storage.status(store, run)["accepting"] is None


def test_existing_collection_changes_do_not_refresh_captured_placement(review):
    store, root, run = review
    node = node_id(store, run, "Shelf/Branch/First")
    assert (
        edit(
            store,
            run,
            "place-existing",
            {
                "action": "reparent",
                "node": node,
                "collection": "collections-child",
            },
        )["state"]
        == "succeeded"
    )
    result = edit(store, run, "capture-existing", {"action": "prepare"})
    assert result["state"] == "succeeded"
    save(
        store,
        field_edit(store, "collections", "collections-child", "name", "Later collection name"),
        "later-collection",
    )
    frontier = store.frontier()
    failed = advance_review(store, root, "capture-existing")
    assert failed["state"] == "failed" and "collection changed" in failed["error"]
    assert store.frontier() == frontier
    validate_snapshot(store.path, store.descriptor)


@pytest.mark.parametrize("competing", [False, True])
def test_partial_acceptance_refreshes_only_its_own_staged_bases(staged, competing):
    from cairndex.devtools.catalog_fixture import synthetic_row

    store, root = staged
    (root / "Set/movie-part03.mp4").write_bytes(b"synthetic third part")
    with store.connection() as db:
        builder = Preview(store, db)
        row = synthetic_row(
            "asset_files",
            "staged-third",
            bundle_id="bundle-000001",
            relative_path="Set/movie-part03.mp4",
            directory_path="Set",
            original_filename="movie-part03.mp4",
            role="VIDEO_PART",
            sequence=1,
        )
        builder.create("asset_files", {field: row[field] for field in AUTHORED["asset_files"]})
        receipt = builder.receipt()
        store.save_in(
            db,
            [UnitChange.model_validate(change) for change in receipt["changes"]],
            "synthetic-extra-part",
            parents=receipt["parents"],
        )
    run = scan(store, root)["id"]
    build(store, run)
    assert (
        edit(store, run, "select-none", {"action": "select", "selected": False})["state"]
        == "succeeded"
    )
    assert (
        edit(
            store,
            run,
            "select-part",
            {
                "action": "select",
                "file": "staged-part",
                "selected": True,
            },
        )["state"]
        == "succeeded"
    )
    first = prepare(store, root, run, "partial-first")
    applied = accept(store, root, first)
    if competing:
        save(
            store,
            field_edit(store, "asset_bundles", "bundle-000001", "grouping_state", "CONFIRMED"),
            "later-confirmation",
        )
    result = reconcile(store, run)
    assert result["files"] == 4
    assert bool(result["error"]) is competing
    assert (
        edit(
            store,
            run,
            "select-third",
            {
                "action": "select",
                "file": "staged-third",
                "selected": True,
            },
        )["state"]
        == "succeeded"
    )
    exported = edit(store, run, "partial-second", {"action": "prepare"})
    assert exported["state"] == "succeeded"
    second = advance_review(store, root, "partial-second")
    if competing:
        assert second["state"] == "failed" and "identity changed" in second["error"]
    else:
        assert second["state"] == "ready", second
        accept(store, root, second)
        assert reconcile(store, run)["files"] == 3
        with store.connection(readonly=True) as db:
            owner = read_row(db, "asset_files", "staged-part")["bundle_id"]
            assert read_row(db, "asset_files", "staged-third")["bundle_id"] == owner
            assert read_row(db, "moments", "staged-moment")["file_id"] == "staged-part"
    assert state.accept(store, applied["id"], applied["receipt"])["event"] == applied["event"]
    validate_snapshot(store.path, store.descriptor)


def test_grouping_api_pages_private_edits_and_rejects_ambiguous_scope(replicas, raw_client):
    from cairndex.replicas import service

    _, root, _ = replicas[0]
    (root / "Novel").mkdir()
    (root / "Novel/scene.mp4").write_bytes(b"synthetic api observation")
    registered = raw_client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert registered.status_code == 201
    library = registered.json()["id"]
    raw_client.get(f"/api/v1/libraries/{library}/replica/status")
    for _ in range(15):
        service.exchange(library)
    store = service._handles[library][0]
    run = scan(store, root)["id"]
    base = f"/api/v1/libraries/{library}/replica/discovery/grouping"
    frontier = store.frontier()
    opened = raw_client.post(base + "/workspaces/" + run)
    assert opened.status_code == 202
    assert service.pending(library)
    for _ in range(1000):
        service.exchange(library)
        status = raw_client.get(base + "/workspaces/" + run).json()
        if status["state"] == "ready":
            break
    else:
        pytest.fail("API grouping draft did not finish")
    response = raw_client.get(
        base + "/workspaces/" + run + "/nodes", params={"revision": status["revision"], "limit": 1}
    )
    assert response.status_code == 200
    node = response.json()["items"][0]["id"]
    commands = base + "/workspaces/" + run + "/commands"
    for intent in (
        {"action": "reparent", "node": node},
        {"action": "select", "file": "unknown-file", "node": node, "selected": False},
    ):
        response = raw_client.post(
            commands,
            json={"operation": "invalid-intent", "revision": status["revision"], "intent": intent},
        )
        assert response.status_code == 422
    response = raw_client.post(
        commands,
        json={
            "operation": "api-select-none",
            "revision": status["revision"],
            "intent": {"action": "select", "selected": False},
        },
    )
    assert response.status_code == 202
    assert service.pending(library)
    for _ in range(100):
        service.exchange(library)
        command = raw_client.get(base + "/commands/api-select-none").json()
        if command["state"] != "queued":
            break
    assert command["state"] == "succeeded"
    assert storage.status(store, run)["selected"] == 0
    assert raw_client.get(base + "/workspaces").json()["available_run"] == run
    assert (
        raw_client.get(
            base + "/workspaces/" + run + "/nodes", params={"revision": status["revision"]}
        ).status_code
        == 409
    )
    assert store.frontier() == frontier
    assert not service.pending(library)


@pytest.mark.parametrize("cancel", [False, True])
def test_grouping_retains_explicit_complete_verification_and_cancellation(replicas, cancel):
    from cairndex.replicas import discovery, discovery_verification

    store, root, _ = replicas[0]
    (root / "Large").mkdir()
    (root / "Large/feature.mp4").write_bytes(b"synthetic complete content\n" * 14000)
    run = scan(store, root)["id"]
    build(store, run)
    frontier = store.frontier()
    storage.enqueue(
        store,
        run,
        "verify-grouping",
        storage.status(store, run)["revision"],
        {
            "action": "prepare",
            "verify_content": True,
        },
    )
    for _ in range(1000):
        worker.step(store)
        command = storage.command(store, "verify-grouping")
        if command["phase"] == "verification":
            break
    else:
        pytest.fail("Grouping did not queue explicit verification")
    assert command["result"]["verification"] == "verify-grouping"
    if cancel:
        discovery_verification.cancel(store, "verify-grouping")
        worker.step(store)
        assert storage.command(store, "verify-grouping")["state"] == "failed"
        assert storage.status(store, run)["state"] == "ready"
        assert storage.status(store, run)["files"] == 1
        assert store.frontier() == frontier
        validate_snapshot(store.path, store.descriptor)
        return
    for _ in range(1000):
        discovery.tick(store, root)
        worker.step(store)
        command = storage.command(store, "verify-grouping")
        if command["state"] == "succeeded":
            break
    else:
        pytest.fail("Verified grouping did not finish exporting its review")
    prepared = advance_review(store, root, "verify-grouping")
    assert prepared["state"] == "ready", prepared
    assert prepared["intent"]["verification"] == "verify-grouping"
    accept(store, root, prepared)
    assert reconcile(store, run)["files"] == 0
    with store.connection(readonly=True) as db:
        file = db.execute(
            "SELECT entity FROM catalog_paths WHERE path='Large/feature.mp4'"
        ).fetchone()[0]
        content = db.execute(
            "SELECT value FROM catalog_units WHERE unit=?", (f"asset_files/{file}/$content",)
        ).fetchone()[0]
        assert json.loads(content)["algorithm"] == "sha256"
    validate_snapshot(store.path, store.descriptor)


@pytest.mark.parametrize("running", [False, True])
def test_recovery_pauses_grouping_edits_until_exact_explicit_resume(review, tmp_path, running):
    from cairndex.replicas import recovery
    from cairndex.replicas.binding import location
    from cairndex.replicas.recovery_validation import open_store

    store, root, run = review
    first = node_id(store, run, "Shelf/Branch/First")
    source = file_id(store, run, "Shelf/Branch/Second/two.mp4")
    storage.enqueue(
        store,
        run,
        "retained-edit",
        storage.status(store, run)["revision"],
        {"action": "move_file", "file": source, "node": first},
    )
    if running:
        worker.step(store)
        assert storage.command(store, "retained-edit")["phase"] == "roles"
    base = tmp_path / "backup-source"
    source_directory, _ = location(base, store.descriptor)
    source_directory.mkdir(parents=True)
    recovery.snapshot(store.path, source_directory / "replica.db")
    backup = tmp_path / "backup"
    recovery.backup(root, base, backup)
    destination = base
    prepared = recovery.prepare(root, destination, backup)
    assert prepared["state"] == "prepared"
    recovery.activate(root, destination, prepared["id"], prepared["receipt"])
    directory, _ = location(destination, store.descriptor)
    recovered = open_store(directory, store.descriptor)
    assert storage.command(recovered, "retained-edit")["state"] == "paused"
    assert storage.status(recovered, run)["command"] == "retained-edit"
    frontier = recovered.frontier()
    for _ in range(4):
        assert not worker.step(recovered)
    assert recovered.frontier() == frontier
    validate_snapshot(recovered.path, recovered.descriptor)
    assert storage.retry(recovered, "retained-edit")["state"] == "queued"
    for _ in range(1000):
        worker.step(recovered)
        command = storage.command(recovered, "retained-edit")
        if command["state"] == "succeeded":
            break
    else:
        pytest.fail("Exact retained edit did not resume")
    with recovered.connection(readonly=True) as db:
        assert (
            db.execute(
                "SELECT node FROM grouping_files WHERE workspace=? AND id=?", (run, source)
            ).fetchone()[0]
            == first
        )
    assert storage.retry(recovered, "retained-edit")["state"] == "succeeded"
    assert recovered.frontier() == frontier
    validate_snapshot(recovered.path, recovered.descriptor)
