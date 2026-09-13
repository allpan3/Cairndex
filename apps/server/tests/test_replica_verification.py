"""Explicit full reads prove large identity without changing source media or authored history"""

import hashlib
import shutil
from uuid import uuid4

from cairndex.replicas import discovery, discovery_state
from cairndex.replicas import discovery_verification as verification
from cairndex.replicas.media import ReplicaMedia
from tests.test_replica_discovery import confirm, exchange, scan
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import specimen as specimen


# Verification is opt-in per retained candidate and advances through the production worker
def start(store, root, name="large.mp4"):
    (root / name).write_bytes(b"synthetic large content\n" * (1024 * 1024))
    scan(store, root)
    candidate = next(c for c in discovery_state.candidates(store)["items"] if c["path"] == name)
    operation = uuid4().hex
    verification.enqueue(store, operation, candidate["id"])
    return operation, candidate


# Every test bounds waiting by worker steps and reports the actual failed state
def finish(store, root, operation):
    for _ in range(50):
        discovery.tick(store, root)
        state = verification.status(store, operation)
        if state["state"] not in ("queued", "running"):
            return state
    raise AssertionError("Verification did not finish")


# Full evidence is durable while the catalog remains untouched until reviewed acceptance
def test_complete_hash_is_explicit_bounded_and_private(replicas):
    store, root, _ = replicas[0]
    operation, candidate = start(store, root)
    before = store.entities("asset_files")
    discovery.tick(store, root)
    progress = verification.status(store, operation)
    assert 0 < progress["bytes_read"] <= verification.STEP_BYTES
    assert progress["state"] == "running"
    assert finish(store, root, operation)["state"] == "succeeded"
    with store.connection(readonly=True) as db:
        upgraded = verification.verified_file(db, root, candidate["body"]["files"][0])
    assert upgraded["evidence"] == {
        "algorithm": "sha256",
        "size": (root / "large.mp4").stat().st_size,
        "digest": hashlib.sha256((root / "large.mp4").read_bytes()).hexdigest(),
    }
    assert upgraded["sample"]["algorithm"] == "sample-sha256-v1"
    assert store.entities("asset_files") == before


# Matching samples cannot hide different bytes between the sampled regions
def test_full_hash_distinguishes_matching_large_samples(replicas):
    results = []
    samples = []
    for index, (store, root, _) in enumerate(replicas):
        (root / "large.mp4").write_bytes(b"z" * (24 * 1024 * 1024))
        if index:
            with (root / "large.mp4").open("r+b") as source:
                source.seek(2 * 1024 * 1024)
                source.write(b"different")
        scan(store, root)
        candidate = next(
            c for c in discovery_state.candidates(store)["items"] if c["path"] == "large.mp4"
        )
        samples.append(candidate["body"]["files"][0]["evidence"])
        operation = uuid4().hex
        verification.enqueue(store, operation, candidate["id"])
        assert finish(store, root, operation)["state"] == "succeeded"
        with store.connection(readonly=True) as db:
            results.append(verification.verified_file(db, root, candidate["body"]["files"][0]))
    assert samples[0] == samples[1]
    assert results[0]["evidence"] != results[1]["evidence"]


# Cancelling never stores partial evidence; retry retains intent and restarts the interrupted file
def test_cancel_and_restart_discard_incomplete_hash_accumulator(replicas):
    store, root, _ = replicas[0]
    operation, candidate = start(store, root)
    discovery.tick(store, root)
    verification.cancel(store, operation)
    discovery.tick(store, root)
    assert verification.status(store, operation)["state"] == "cancelled"
    with store.connection(readonly=True) as db:
        assert not db.execute("SELECT 1 FROM discovery_verified").fetchone()
    verification.enqueue(store, operation, candidate["id"])
    discovery.tick(store, root)
    discovery.close(store)
    discovery.tick(store, root)
    assert verification.status(store, operation)["bytes_read"] <= verification.STEP_BYTES
    assert finish(store, root, operation)["state"] == "succeeded"


# Mutating unread bytes invalidates the pinned generation instead of producing a mixed hash
def test_source_mutation_during_hash_retains_ambiguity(replicas):
    store, root, _ = replicas[0]
    operation, _ = start(store, root)
    discovery.tick(store, root)
    with (root / "large.mp4").open("r+b") as source:
        source.seek(10 * 1024 * 1024)
        source.write(b"replacement")
    result = finish(store, root, operation)
    assert result["state"] == "failed"
    assert "changed" in result["error"]
    with store.connection(readonly=True) as db:
        assert not db.execute("SELECT 1 FROM discovery_verified").fetchone()


# Independent full verification gives playable multi-megabyte media the same portable identity
def test_verified_large_playable_discovery_converges(replicas):
    from cairndex.media.ffmpeg_exec import ffmpeg_exe, run_ffmpeg

    root = replicas[0][1]
    run_ffmpeg(
        [
            ffmpeg_exe(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=20",
            "-t",
            "20",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(root / "large.mp4"),
        ],
        timeout=30,
        stderr_limit=200,
    )
    assert (root / "large.mp4").stat().st_size > 2 * 1024 * 1024
    shutil.copy2(root / "large.mp4", replicas[1][1] / "large.mp4")
    identities = []
    for store, directory, _ in replicas:
        scan(store, directory)
        candidate = next(
            c for c in discovery_state.candidates(store)["items"] if c["path"] == "large.mp4"
        )
        operation = uuid4().hex
        verification.enqueue(store, operation, candidate["id"])
        assert finish(store, directory, operation)["state"] == "succeeded"
        result = confirm(store, directory, candidate, verification=operation)
        identity = result["prepared"]["files"][0]["id"]
        identities.append(identity)
        media = ReplicaMedia(store, directory, "synthetic").file(identity, inspect=True, probe=True)
        assert media.size_bytes > 2 * 1024 * 1024
        assert media.tech_metadata["duration"] >= 19
    assert identities[0] == identities[1]
    exchange(replicas)
    for store, directory, _ in replicas:
        assert not store.entity("asset_files", identities[0])["has_conflicts"]
        scan(store, directory)
        assert not discovery_state.candidates(store)["items"]


# A fully verified move is found through its retained sample and verified again
def test_verified_file_move_requires_matching_complete_evidence(replicas):
    store, root, _ = replicas[0]
    operation, candidate = start(store, root)
    assert finish(store, root, operation)["state"] == "succeeded"
    accepted = confirm(store, root, candidate, verification=operation)
    identity = accepted["prepared"]["files"][0]["id"]
    (root / "large.mp4").rename(root / "moved.mp4")
    scan(store, root)
    candidate = discovery_state.candidates(store)["items"][0]
    assert candidate["body"]["kind"] == "repair"
    operation = uuid4().hex
    verification.enqueue(store, operation, candidate["id"])
    assert finish(store, root, operation)["state"] == "succeeded"
    accepted = confirm(store, root, candidate, verification=operation, repair_file=identity)
    assert accepted["prepared"]["files"][0]["id"] == identity
