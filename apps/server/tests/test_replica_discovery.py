"""Independent disposable replicas exercise discovery without changing source bytes"""

import json
import shutil
from uuid import uuid4

import pytest

from cairndex.devtools.discovery_fixture import create_discovery
from cairndex.registry.library_package import read_manifest
from cairndex.replicas import discovery
from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.transport import Transport


# Share only generated package/media copies; every test gets independent private authors
@pytest.fixture(scope="module")
def specimen(tmp_path_factory):
    return create_discovery(parent=tmp_path_factory.mktemp("discovery"))


# Each case starts with separate stores rather than copying private SQLite identities
@pytest.fixture
def replicas(specimen, tmp_path):
    result = []
    for label in ("A", "B"):
        root = tmp_path / label
        shutil.copytree(specimen, root)
        store = CatalogStore(tmp_path / ("private-" + label), read_manifest(root).replica)
        transport = Transport(root, store)
        for _ in range(15):
            transport.tick()
        result.append((store, root, transport))
    yield result
    for store, _, transport in result:
        discovery.close(store)
        transport.close()


# Drive the production bounded worker without introducing timing-dependent sleeps
def scan(store, root):
    operation = uuid4().hex
    state.enqueue(store, operation)
    for _ in range(100):
        discovery.tick(store, root)
        result = state.run(store, operation)
        if result["state"] != "running":
            assert result["state"] == "succeeded", result
            return result
    pytest.fail("Discovery did not finish its bounded work")


# A review never authors until its exact prepared receipt is accepted
def confirm(store, root, candidate, **overrides):
    operation = uuid4().hex
    state.prepare(store, operation, {"candidate": candidate["id"], **overrides})
    discovery.tick(store, root)
    prepared = state.review(store, operation)
    assert prepared["state"] == "ready", prepared["error"]
    state.accept(store, operation, prepared["receipt"])
    discovery.tick(store, root)
    result = state.review(store, operation)
    assert result["state"] == "applied", result
    return result


# First/repeated Update keep candidates private; reviewed grouping becomes one causal transaction
def test_discover_review_repeat(replicas):
    store, root, _ = replicas[0]
    (root / "Novel").mkdir()
    (root / "Novel/scene.mp4").write_bytes(b"synthetic scene")
    (root / "Novel/scene.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nInvented\n")
    before = store.entities("asset_files")
    scan(store, root)
    candidates = state.candidates(store)["items"]
    assert len(candidates) == 1
    assert store.entities("asset_files") == before
    scan(store, root)
    assert [c["id"] for c in state.candidates(store)["items"]] == [c["id"] for c in candidates]
    saved = confirm(store, root, candidates[0])
    assert saved["event"]
    with store.connection(readonly=True) as db:
        files = [
            json.loads(row[0])
            for row in db.execute("SELECT body FROM catalog_rows WHERE family='asset_files'")
        ]
        assert len([file for file in files if file["relative_path"].startswith("Novel/")]) == 2
    scan(store, root)
    assert state.candidates(store)["items"] == []


# External moves retain identity, attached authored metadata and the owning arrangement
def test_move_preserves_metadata_and_copy_is_new(replicas):
    store, root, _ = replicas[0]
    scan(store, root)
    before = store.entity("asset_files", "file-video")
    bundle = store.entity("asset_bundles", "bundle-000000")
    (root / "Moved").mkdir()
    original = root / "Synthetic/雪.mp4"
    destination = root / "Moved/movie.mp4"
    original.rename(destination)
    result = scan(store, root)
    assert result["repaired"] == 1
    after = store.entity("asset_files", "file-video")
    assert json.loads(after["fields"]["relative_path"]["value"]) == "Moved/movie.mp4"
    for field in ("note", "source", "cover_time"):
        assert after["fields"][field] == before["fields"][field]
    assert store.entity("asset_bundles", "bundle-000000")["fields"] == bundle["fields"]
    shutil.copy2(destination, root / "Moved/copy.mp4")
    result = scan(store, root)
    assert result["repaired"] == 0
    assert len(state.candidates(store)["items"]) == 1


# Ambiguity cannot disappear merely because an earlier candidate was marked for review
def test_multiple_matching_paths_never_auto_repair(replicas):
    store, root, _ = replicas[0]
    scan(store, root)
    prior = discovery.sources.inspect(root, "Synthetic/雪.mp4")
    with store.connection() as db:
        db.execute(
            "INSERT INTO local_progress VALUES (?,?,?,?,?)",
            ("file-video", prior["generation"], 12.5, 30, 0),
        )
    old = root / "Synthetic/雪.mp4"
    shutil.copy2(old, root / "first.mp4")
    old.rename(root / "second.mp4")
    assert scan(store, root)["repaired"] == 0
    candidates = state.candidates(store)["items"]
    assert len(candidates) == 2
    assert {c["body"]["kind"] for c in candidates} == {"repair"}
    confirm(store, root, candidates[0], repair_file="file-video")
    with store.connection(readonly=True) as db:
        progress = db.execute("SELECT * FROM local_progress WHERE file_id='file-video'").fetchone()
        assert progress["position"] == 12.5
        assert (
            progress["generation"]
            == discovery.sources.inspect(root, candidates[0]["path"])["generation"]
        )
    assert (
        json.loads(store.entity("asset_files", "file-video")["fields"]["relative_path"]["value"])
        == candidates[0]["path"]
    )


# Same-path replacement requires an explicit source decision and never silently adopts content
def test_replacement_review_and_revalidation(replicas):
    store, root, _ = replicas[0]
    scan(store, root)
    file = root / "Synthetic/雪.mp4"
    file.write_bytes(b"different synthetic source")
    assert scan(store, root)["repaired"] == 0
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["kind"] == "replacement"
    operation = uuid4().hex
    state.prepare(store, operation, {"candidate": candidate["id"], "use_replacement": True})
    discovery.tick(store, root)
    prepared = state.review(store, operation)
    assert prepared["state"] == "ready", prepared
    file.write_bytes(b"changed after review")
    state.accept(store, operation, prepared["receipt"])
    discovery.tick(store, root)
    assert state.review(store, operation)["state"] == "failed"
    assert "$content" not in store.entity("asset_files", "file-video")["fields"]


# Controlled artifact copies simulate delivery while stores and filesystem observations stay private
def exchange(replicas):
    for _, _, transport in replicas:
        for _ in range(8):
            transport.tick()
    a, b = [root / ".cairndex/replica/objects" for _, root, _ in replicas]
    shutil.copytree(a, b, dirs_exist_ok=True)
    shutil.copytree(b, a, dirs_exist_ok=True)
    for _, _, transport in replicas:
        transport.close()
        for _ in range(20):
            transport.tick()


# Independent discovery of complete identical bytes converges to the same stable file identity
def test_concurrent_identical_discovery_converges(replicas):
    root_a, root_b = replicas[0][1], replicas[1][1]
    (root_a / "new.png").write_bytes(b"synthetic identical image")
    shutil.copy2(root_a / "new.png", root_b / "new.png")
    for store, root, _ in replicas:
        scan(store, root)
        confirm(store, root, state.candidates(store)["items"][0])
    exchange(replicas)
    views = []
    for store, root, _ in replicas:
        with store.connection(readonly=True) as db:
            views.append(
                list(
                    map(
                        tuple,
                        db.execute(
                            "SELECT entity,body FROM catalog_rows WHERE family='asset_files' "
                            "ORDER BY entity"
                        ),
                    )
                )
            )
            assert db.execute("SELECT COUNT(*) FROM catalog_holds").fetchone()[0] == 0
        scan(store, root)
        assert state.candidates(store)["items"] == []
    assert views[0] == views[1]


# Different bytes at one path remain explicit alternatives with one valid local projection
def test_concurrent_different_discovery_is_identity_conflict(replicas):
    for index, (store, root, _) in enumerate(replicas):
        (root / "new.png").write_bytes(f"synthetic image {index}".encode())
        scan(store, root)
        confirm(store, root, state.candidates(store)["items"][0])
    exchange(replicas)
    for store, _, _ in replicas:
        with store.connection(readonly=True) as db:
            assert db.execute("SELECT COUNT(*) FROM catalog_holds").fetchone()[0] > 0
            assert (
                db.execute("SELECT COUNT(*) FROM catalog_paths WHERE path='new.png'").fetchone()[0]
                == 1
            )
            assert (
                db.execute(
                    "SELECT COUNT(DISTINCT unit) FROM catalog_revisions WHERE unit "
                    "LIKE '%/relative_path' AND value='\"new.png\"'"
                ).fetchone()[0]
                == 2
            )


# Competing external moves become path alternatives, never two rows or remote missing flags
def test_concurrent_repairs_keep_both_paths(replicas):
    for index, (store, root, _) in enumerate(replicas):
        scan(store, root)
        (root / "Synthetic/雪.mp4").rename(root / f"moved-{index}.mp4")
        assert scan(store, root)["repaired"] == 1
    exchange(replicas)
    for store, _, _ in replicas:
        file = store.entity("asset_files", "file-video")
        assert len(file["fields"]["relative_path"]["candidates"]) == 2
        assert file["has_conflicts"]


# A peer's old local folder is not authority to undo a newly received shared move
def test_delayed_local_delivery_cannot_revert_peer_repair(replicas):
    for store, root, _ in replicas:
        scan(store, root)
    store, root, _ = replicas[0]
    (root / "Synthetic/雪.mp4").rename(root / "moved.mp4")
    assert scan(store, root)["repaired"] == 1
    exchange(replicas)
    peer, peer_root, _ = replicas[1]
    before = peer.entity("asset_files", "file-video")
    assert scan(peer, peer_root)["repaired"] == 0
    assert peer.entity("asset_files", "file-video") == before
    candidate = state.candidates(peer)["items"][0]
    assert candidate["body"]["kind"] == "repair"
    assert not candidate["body"]["choices"][0]["automatic"]


# A cancelled walk and process restart can rediscover private candidates without duplicate events
def test_cancel_restart_and_retry(replicas):
    store, root, _ = replicas[0]
    for index in range(70):
        (root / f"frame-{index:03}.png").write_bytes(f"synthetic frame {index}".encode())
    state.enqueue(store, "cancelled-run")
    discovery.tick(store, root)
    state.cancel(store, "cancelled-run")
    discovery.tick(store, root)
    assert state.run(store)["state"] == "cancelled"
    assert state.candidates(store)["items"] == []
    state.enqueue(store, "restart-run")
    discovery.tick(store, root)
    discovery.close(store)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    for _ in range(100):
        discovery.tick(reopened, root)
        if state.run(reopened)["state"] != "running":
            break
    assert state.run(reopened)["state"] == "succeeded"
    with reopened.connection(readonly=True) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM catalog_rows WHERE family='asset_files'").fetchone()[0]
            == 2
        )
        assert (
            db.execute("SELECT COUNT(*) FROM discovery_entries WHERE run='restart-run'").fetchone()[
                0
            ]
            == 72
        )


# Local read failures and hidden/symlink paths cannot publish source absence or escaping entries
def test_hidden_symlinks_and_read_failure(replicas, monkeypatch):
    store, root, _ = replicas[0]
    (root / ".hidden.png").write_bytes(b"hidden synthetic")
    (root / "linked.png").symlink_to(root / "Synthetic/雪.mp4")
    (root / "loop").symlink_to(root, target_is_directory=True)
    scan(store, root)
    assert state.candidates(store)["items"] == []
    before = store.entities("asset_files")
    original = discovery.sources.inspect

    def denied(*args, **kwargs):
        raise PermissionError("synthetic denied read")

    monkeypatch.setattr(discovery.sources, "inspect", denied)
    state.enqueue(store, "denied")
    discovery.tick(store, root)
    assert state.run(store)["state"] == "failed"
    assert store.entities("asset_files") == before
    monkeypatch.setattr(discovery.sources, "inspect", original)
    scan(store, root)


# Sampling stays bounded; same samples in independent large files never imply shared identity
def test_large_file_sample_identity_is_private(replicas, monkeypatch):
    store, root, _ = replicas[0]
    data = b"synthetic segment" * 100_000
    (root / "large.mp4").write_bytes(data)
    sizes = []
    original = discovery.sources.os.pread

    def measured(fd, length, offset):
        sizes.append(length)
        return original(fd, length, offset)

    monkeypatch.setattr(discovery.sources.os, "pread", measured)
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["files"][0]["evidence"]["algorithm"] == "sample-sha256-v1"
    assert max(sizes) == 64 * 1024
    identity = candidate["body"]["files"][0]["id"]
    scan(store, root)
    assert state.candidates(store)["items"][0]["body"]["files"][0]["id"] == identity
    peer, peer_root, _ = replicas[1]
    shutil.copy2(root / "large.mp4", peer_root / "large.mp4")
    scan(peer, peer_root)
    assert state.candidates(peer)["items"][0]["body"]["files"][0]["id"] != identity


# The supported API and recovery command preserve pending private choices across activation
def test_api_backup_restore_requires_revalidation(specimen, tmp_path, raw_client):
    from cairndex.core.config import get_settings
    from cairndex.replicas import recovery, service

    root = tmp_path / "api-root"
    shutil.copytree(specimen, root)
    (root / "discovered.png").write_bytes(b"synthetic recovery candidate")
    response = raw_client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert response.status_code == 201
    identity = response.json()["id"]
    base = f"/api/v1/libraries/{identity}"
    raw_client.get(base + "/replica/status")
    for _ in range(20):
        service.exchange(identity)
    assert (
        raw_client.post(
            base + "/replica/discovery/runs", json={"operation": "recovery-scan"}
        ).status_code
        == 202
    )
    for _ in range(20):
        service.exchange(identity)
    candidate = raw_client.get(base + "/replica/discovery/candidates").json()["items"][0]
    assert (
        raw_client.post(
            base + "/replica/discovery/reviews",
            json={"operation": "recovery-review", "candidate": candidate["id"]},
        ).status_code
        == 202
    )
    service.exchange(identity)
    prepared = raw_client.get(base + "/replica/discovery/reviews/recovery-review").json()
    assert prepared["state"] == "ready"
    private = get_settings().data_dir.resolve()
    report = recovery.backup(root, private, tmp_path / "backup")
    assert report
    restored = recovery.prepare(root, private, tmp_path / "backup")
    assert raw_client.post(base + "/ownership/release").status_code == 200
    recovery.activate(root, private, restored["id"], restored["receipt"])
    assert raw_client.post(base + "/ownership/reopen").status_code == 200
    pending = raw_client.get(base + "/replica/discovery/reviews/recovery-review").json()
    assert pending["state"] == "failed"
    assert pending["intent"] == prepared["intent"]
    assert (
        raw_client.post(
            base + "/replica/discovery/reviews/recovery-review/accept",
            json={"receipt": prepared["receipt"]},
        ).status_code
        == 409
    )
    assert (
        raw_client.get(base + "/replica/discovery/candidates").json()["items"][0]["id"]
        == candidate["id"]
    )


# A changed same-path source cannot silently inherit a catalog identity in the shared viewer
def test_content_replacement_blocks_playback_until_review(replicas):
    from cairndex.core.errors import NotFoundError
    from cairndex.replicas.media import ReplicaMedia

    store, root, _ = replicas[0]
    scan(store, root)
    (root / "Synthetic/雪.mp4").write_bytes(b"different synthetic playback source")
    with pytest.raises(NotFoundError, match="Different local content"):
        ReplicaMedia(store, root, "synthetic").file("file-video", inspect=True)
    scan(store, root)
    confirm(store, root, state.candidates(store)["items"][0], use_replacement=True)
    assert ReplicaMedia(store, root, "synthetic").file("file-video", inspect=True).size_bytes > 0


# Reviewed additions append to settled ordering without clearing existing cover/subtitle metadata
def test_addition_and_unrelated_authored_edit(replicas):
    from cairndex.replicas.catalog.commands import Preview
    from cairndex.replicas.catalog.protocol import UnitChange

    store, root, _ = replicas[0]
    scan(store, root)
    before = store.entity("asset_bundles", "bundle-000000")["fields"]
    (root / "Synthetic/雪.en.srt").write_text(
        "1\n00:00:00,000 --> 00:00:01,000\nInvented addition\n"
    )
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["target"] == "bundle-000000"
    state.prepare(store, "addition", {"candidate": candidate["id"]})
    discovery.tick(store, root)
    prepared = state.review(store, "addition")
    assert prepared["state"] == "ready", prepared["error"]
    with store.connection() as db:
        builder = Preview(store, db)
        builder.put("asset_bundles/bundle-000000/notes", '["edited while reviewing"]')
        receipt = builder.receipt()
        store.save_in(
            db,
            [UnitChange.model_validate(c) for c in receipt["changes"]],
            "notes-during-update",
            parents=receipt["parents"],
        )
    state.accept(store, "addition", prepared["receipt"])
    discovery.tick(store, root)
    assert state.review(store, "addition")["state"] == "applied"
    after = store.entity("asset_bundles", "bundle-000000")["fields"]
    assert after["notes"]["value"] == json.dumps('["edited while reviewing"]')
    assert after["cover_file_id"]["value"] == before["cover_file_id"]["value"]
    old_members = json.loads(before["$members"]["value"])
    new_members = json.loads(after["$members"]["value"])
    assert new_members[: len(old_members)] == old_members
    assert len(new_members) == len(old_members) + 1
    assert not store.entity("asset_bundles", "bundle-000000")["has_conflicts"]


# A review prepared offline retains its bases even when another device confirms a different owner
@pytest.mark.parametrize("arrives_before", [True, False])
def test_competing_grouping_acceptance_retains_valid_arrangement(replicas, arrives_before):
    roots = [root for _, root, _ in replicas]
    (roots[0] / "addition.png").write_bytes(b"synthetic competing ownership")
    shutil.copy2(roots[0] / "addition.png", roots[1] / "addition.png")
    for index, (store, root, _) in enumerate(replicas):
        scan(store, root)
        candidate = state.candidates(store)["items"][0]
        state.prepare(
            store,
            "competing-review",
            {"candidate": candidate["id"], "target": f"bundle-{index:06}"},
        )
        discovery.tick(store, root)
        assert state.review(store, "competing-review")["state"] == "ready"
    a, root_a, _ = replicas[0]
    state.accept(a, "competing-review", state.review(a, "competing-review")["receipt"])
    discovery.tick(a, root_a)
    if arrives_before:
        exchange(replicas)
    b, root_b, _ = replicas[1]
    prepared = state.review(b, "competing-review")["prepared"]
    state.accept(b, "competing-review", state.review(b, "competing-review")["receipt"])
    discovery.tick(b, root_b)
    assert state.review(b, "competing-review")["state"] == (
        "failed" if arrives_before else "applied"
    )
    assert state.review(b, "competing-review")["prepared"] == prepared
    exchange(replicas)
    for store, _, _ in replicas:
        with store.connection(readonly=True) as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM catalog_paths WHERE path='addition.png'"
                ).fetchone()[0]
                == 1
            )
            held = db.execute("SELECT COUNT(*) FROM catalog_holds").fetchone()[0]
            assert (held == 0) if arrives_before else (held > 0)
            assert db.execute(
                "SELECT COUNT(*) FROM events WHERE operation LIKE 'discover_%' "
                "AND operation IS NOT NULL"
            ).fetchone()[0] == (1 if arrives_before else 2)


# Failed enumeration makes no authored change; a newly available root can be retried explicitly
def test_unavailable_root_retry(replicas, tmp_path):
    store, root, _ = replicas[0]
    before = store.entities("asset_files")
    state.enqueue(store, "unavailable")
    parked = tmp_path / "parked"
    root.rename(parked)
    discovery.tick(store, root)
    assert state.run(store)["state"] == "failed"
    assert store.entities("asset_files") == before
    parked.rename(root)
    scan(store, root)


# An interrupted commit retries the saved review once, with source bytes and IDs unchanged
def test_abrupt_process_exit_during_review_commit(replicas):
    import subprocess
    import sys

    store, root, _ = replicas[0]
    (root / "crash.png").write_bytes(b"synthetic crash candidate")
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    state.prepare(store, "crash-review", {"candidate": candidate["id"]})
    discovery.tick(store, root)
    state.accept(store, "crash-review", state.review(store, "crash-review")["receipt"])
    code = """
import os,sys
from pathlib import Path
from cairndex.registry.library_package import read_manifest
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery import tick
root=Path(sys.argv[1])
store=CatalogStore(Path(sys.argv[2]),read_manifest(root).replica,
 fault=lambda point: os._exit(73) if point=='discovery_before_commit' else None)
tick(store,root)
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(root), str(store.path.parent)], check=False
    )
    assert result.returncode == 73
    assert state.review(store, "crash-review")["state"] == "apply_queued"
    discovery.tick(store, root)
    assert state.review(store, "crash-review")["state"] == "applied"
    with store.connection(readonly=True) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM catalog_paths WHERE path='crash.png'").fetchone()[0]
            == 1
        )
    assert (root / "crash.png").read_bytes() == b"synthetic crash candidate"


# Completed scans supersede outdated suggestions without destroying their saved preview bytes
def test_superseded_candidates_and_exact_review_retry(replicas):
    store, root, _ = replicas[0]
    file = root / "new.png"
    file.write_bytes(b"first synthetic choice")
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    intent = {"candidate": candidate["id"]}
    state.prepare(store, "retained", intent)
    discovery.tick(store, root)
    prepared = state.review(store, "retained")["prepared"]
    file.write_bytes(b"second synthetic choice")
    scan(store, root)
    current = state.candidates(store)["items"]
    assert len(current) == 1 and current[0]["id"] != candidate["id"]
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT * FROM discovery_candidates WHERE id=?", (candidate["id"],)
        ).fetchone()
        assert row["state"] == "superseded"
        from cairndex.replicas.discovery_proposals import display

        assert display(db, row)["body"] == candidate["body"]
    state.accept(store, "retained", state.review(store, "retained")["receipt"])
    discovery.tick(store, root)
    assert state.review(store, "retained")["state"] == "failed"
    state.prepare(store, "retained", intent)
    discovery.tick(store, root)
    assert state.review(store, "retained")["state"] == "failed"
    assert state.review(store, "retained")["prepared"] == prepared
    confirm(store, root, current[0])


# A fresh traversal discards pre-crash observations of files that disappeared during downtime
def test_restart_discards_stale_walk_entries(replicas):
    store, root, _ = replicas[0]
    for index in range(80):
        (root / f"temporary-{index:03}.png").write_bytes(b"synthetic temporary observation")
    state.enqueue(store, "interrupted")
    discovery.tick(store, root)
    with store.connection(readonly=True) as db:
        removed = db.execute(
            "SELECT path FROM discovery_entries WHERE run='interrupted' AND path LIKE 'temporary-%'"
        ).fetchall()
    assert removed
    for (path,) in removed:
        (root / path).unlink()
    discovery.close(store)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    for _ in range(100):
        discovery.tick(reopened, root)
        if state.run(reopened)["state"] != "running":
            break
    assert state.run(reopened)["state"] == "succeeded"
    with reopened.connection(readonly=True) as db:
        for (path,) in removed:
            assert not db.execute(
                "SELECT 1 FROM discovery_entries WHERE run='interrupted' AND path=?", (path,)
            ).fetchone()
        assert state.run(reopened)["observed"] == 82 - len(removed)


# Corrupt private evidence and saved selection references are rejected before recovery activation
@pytest.mark.parametrize("damage", ["identity", "candidate", "preview"])
def test_recovery_rejects_invalid_discovery_state(replicas, damage):
    from cairndex.replicas.discovery_validation import validate
    from cairndex.replicas.protocol import ReplicaError

    store, root, _ = replicas[0]
    (root / "validation.png").write_bytes(b"synthetic recovery validation")
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    state.prepare(store, "validation-review", {"candidate": candidate["id"]})
    discovery.tick(store, root)
    with store.connection() as db:
        validate(db, store)
        if damage == "identity":
            db.execute("UPDATE discovery_identities SET file_id='wrong-identity'")
        elif damage == "candidate":
            body = candidate["body"]
            body["files"][0]["path"] = "../escaped.png"
            db.execute("UPDATE discovery_candidates SET body=?", (json.dumps(body),))
        else:
            prepared = state.review(store, "validation-review")["prepared"]
            prepared["files"][0]["path"] = "different.png"
            db.execute("UPDATE discovery_reviews SET prepared=?", (json.dumps(prepared),))
        with pytest.raises(ReplicaError):
            validate(db, store)


# Samples propose a manual identity choice across physical files but never carry resume implicitly
def test_large_ambiguous_repair_requires_explicit_identity_choice(replicas):
    store, root, _ = replicas[0]
    source = root / "large.mp4"
    source.write_bytes(b"synthetic segment" * 100_000)
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    identity = candidate["body"]["files"][0]["id"]
    confirm(store, root, candidate)
    prior = discovery.sources.inspect(root, "large.mp4")
    with store.connection() as db:
        db.execute(
            "INSERT INTO local_progress VALUES (?,?,?,?,?)",
            (identity, prior["generation"], 5, 10, 0),
        )
    shutil.copy2(source, root / "possible.mp4")
    source.unlink()
    assert scan(store, root)["repaired"] == 0
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["kind"] == "repair"
    assert "cannot prove complete equality" in candidate["body"]["reason"]
    confirm(store, root, candidate, repair_file=identity)
    with store.connection(readonly=True) as db:
        assert (
            db.execute(
                "SELECT generation FROM local_progress WHERE file_id=?", (identity,)
            ).fetchone()[0]
            == prior["generation"]
        )
    assert (
        json.loads(store.entity("asset_files", identity)["fields"]["relative_path"]["value"])
        == "possible.mp4"
    )


# Competing replacement evidence keeps both source choices without losing the existing file row
def test_concurrent_replacement_preserves_both_content_choices(replicas):
    for index, (store, root, _) in enumerate(replicas):
        scan(store, root)
        (root / "Synthetic/雪.mp4").write_bytes(f"synthetic competing content {index}".encode())
        scan(store, root)
        confirm(store, root, state.candidates(store)["items"][0], use_replacement=True)
    exchange(replicas)
    for store, _, _ in replicas:
        field = store.entity("asset_files", "file-video")["fields"]["$content"]
        assert field["held"] and len(field["candidates"]) == 2
        assert (
            json.loads(
                store.entity("asset_files", "file-video")["fields"]["relative_path"]["value"]
            )
            == "Synthetic/雪.mp4"
        )
