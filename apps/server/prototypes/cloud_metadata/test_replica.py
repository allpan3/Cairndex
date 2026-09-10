"""Executable acceptance cases for the proposed protocol, exclusively synthetic"""

import random
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from .harness import Pair, deliver
from .merge import heads
from .protocol import Invalid, encode, make_event
from .replica import Replica, initialize


# Keep the two independent SQLite connections open for every delivery scenario
@pytest.fixture
def pair() -> Iterator[Pair]:
    replicas = Pair()
    try:
        yield replicas
    finally:
        replicas.close()


# Require semantic convergence, including every unresolved candidate and causal writer
def assert_converged(pair: Pair) -> None:
    assert pair.a.view() == pair.b.view()
    assert set(pair.a.events()) == set(pair.b.events())


# Alternate saves while both servers remain open and continuously usable
def test_both_open_alternating_edits(pair: Pair) -> None:
    for index in range(12):
        active = pair.a if index % 2 else pair.b
        active.edit({"entity/bundle/title": f"Synthetic title {index}"})
        pair.sync()
        assert_converged(pair)
        assert pair.a.display()["entity/bundle/title"] == f"Synthetic title {index}"
    assert not pair.a.view().conflicts


# Separate fields of the same object combine without discarding either author's work
def test_offline_disjoint_same_entity(pair: Pair) -> None:
    pair.a.edit({"entity/bundle/title": "Amber title"})
    pair.b.edit({"entity/bundle/note": "Blue note", "entity/bundle/rating": 7})
    pair.sync()
    assert_converged(pair)
    assert not pair.a.view().conflicts
    assert pair.a.display()["entity/bundle/title"] == "Amber title"
    assert pair.a.display()["entity/bundle/note"] == "Blue note"
    assert pair.a.display()["entity/bundle/rating"] == 7


# Same-field choices preserve both complete branches and keep unrelated edits active
def test_conflict_resolution_and_recovery(pair: Pair) -> None:
    a = pair.a.edit({"entity/bundle/title": "Amber title", "entity/bundle/note": "Amber note"})
    b = pair.b.edit({"entity/bundle/title": "Blue title", "entity/bundle/rating": 8})
    pair.sync()
    assert_converged(pair)
    assert set(pair.a.view().conflicts) == {"entity/bundle/title"}
    assert pair.a.display()["entity/bundle/title"] == "Amber title"
    assert pair.b.display()["entity/bundle/title"] == "Blue title"
    with pytest.raises(Invalid, match="explicit conflict"):
        pair.a.edit({"entity/bundle/title": "Accidental winner"})
    pair.a.resolve({"entity/bundle/title": "Blue title"}, heads(pair.a.events()), "choose-blue")
    pair.sync()
    assert_converged(pair)
    assert not pair.a.view().conflicts
    assert pair.a.display()["entity/bundle/note"] == "Amber note"
    assert pair.a.display()["entity/bundle/rating"] == 8
    assert pair.a.recover(a).values["entity/bundle/title"] == "Amber title"
    assert pair.a.recover(b).values["entity/bundle/note"] == "Seed note"
    pair.a.edit({"entity/bundle/title": pair.a.recover(a).values["entity/bundle/title"]})
    pair.sync()
    assert pair.b.display()["entity/bundle/title"] == "Amber title"


# Equal concurrent values need no user choice but retain both causal writers
# A later differing edit must still conflict if it did not observe the other branch
def test_equal_values_and_late_divergence(pair: Pair) -> None:
    first = pair.a.edit({"entity/bundle/title": "Same"})
    pair.b.edit({"entity/bundle/title": "Same"})
    pair.sync()
    assert not pair.a.view().conflicts
    pair.a.edit({"entity/bundle/title": "Later"}, parents=[first])
    pair.sync()
    assert "entity/bundle/title" in pair.a.view().conflicts
    assert_converged(pair)


# Metadata deletion and edits remain recoverable; unrelated entities continue to merge
@pytest.mark.parametrize("keep", [True, False])
def test_delete_edit_conflict(pair: Pair, keep: bool) -> None:
    deleted = pair.a.edit({"entity/bundle/alive": False, "order/bundle": None})
    edited = pair.b.edit({"entity/bundle/note": "Offline note"})
    pair.b.edit({"entity/image/title": "Independent image title"})
    pair.sync()
    assert "entity/bundle/alive" in pair.a.view().conflicts
    choices: dict[str, Any] = {"entity/bundle/alive": keep}
    if keep:
        choices["order/bundle"] = pair.a.recover(edited).values["order/bundle"]
    pair.a.resolve(choices, heads(pair.a.events()), "choose-life")
    pair.sync()
    assert_converged(pair)
    assert pair.a.display()["entity/bundle/alive"] is keep
    assert pair.a.display()["entity/image/title"] == "Independent image title"
    assert pair.a.recover(edited).values["entity/bundle/note"] == "Offline note"
    assert pair.a.recover(deleted).values["entity/bundle/alive"] is False
    if not keep:
        with pytest.raises(Invalid, match="explicit recovery"):
            pair.b.edit({"entity/bundle/note": "Implicit resurrection"})


# Deleting a referenced node requires a reviewed detach in the same transaction
def test_delete_referenced_node_and_concurrent_membership(pair: Pair) -> None:
    with pytest.raises(Invalid, match="relationship"):
        pair.a.edit({"entity/amber/alive": False})
    tree = {"root": ["blue"], "blue": []}
    pair.a.edit({"entity/amber/alive": False, "tree/collections": tree})
    pair.b.edit({"member/bundle/amber": True})
    pair.sync()
    assert "entity/amber/alive" in pair.a.view().conflicts
    assert "member/bundle/amber" in pair.a.view().references
    assert "member/bundle/amber" not in pair.a.display()
    pair.a.resolve(
        {"entity/amber/alive": False, "member/bundle/amber": False},
        heads(pair.a.events()),
        "delete-and-detach",
    )
    pair.sync()
    assert_converged(pair)
    assert not pair.a.view().conflicts and not pair.a.view().references


# Two independently valid tree edits are never merged into a cycle
def test_hierarchy_conflict_and_independent_rename(pair: Pair) -> None:
    amber_parent = {"root": ["amber"], "amber": ["blue"], "blue": []}
    blue_parent = {"root": ["blue"], "blue": ["amber"], "amber": []}
    pair.a.edit({"tree/collections": amber_parent})
    pair.b.edit({"tree/collections": blue_parent, "entity/blue/title": "Blue renamed"})
    pair.sync()
    assert set(pair.a.view().conflicts) == {"tree/collections"}
    assert pair.a.display()["tree/collections"] == amber_parent
    assert pair.b.display()["tree/collections"] == blue_parent
    pair.a.resolve({"tree/collections": amber_parent}, heads(pair.a.events()), "tree-choice")
    pair.sync()
    assert_converged(pair)
    assert pair.b.display()["entity/blue/title"] == "Blue renamed"


# Ordered membership is an atomic unit, not independently merged sequence numbers
def test_order_conflict(pair: Pair) -> None:
    pair.a.edit({"order/bundle": ["video", "image"]})
    pair.b.edit({"order/bundle": ["image"]})
    pair.sync()
    assert "order/bundle" in pair.a.view().conflicts
    pair.b.resolve({"order/bundle": ["image"]}, heads(pair.b.events()), "order-choice")
    pair.sync()
    assert_converged(pair)
    assert pair.a.display()["order/bundle"] == ["image"]


# Different membership edges combine; opposite intent on the same edge requires a choice
def test_membership_granularity(pair: Pair) -> None:
    pair.a.edit({"member/bundle/amber": True})
    pair.b.edit({"member/bundle/blue": True})
    pair.sync()
    assert not pair.a.view().conflicts
    pair.a.edit({"member/bundle/amber": False})
    pair.b.edit({"member/bundle/amber": True})
    pair.sync()
    assert "member/bundle/amber" in pair.a.view().conflicts
    assert pair.a.display()["member/bundle/blue"] is True


# A local draft survives import and its stale save cannot overwrite unseen remote intent
def test_unsaved_work_and_stale_resolution(pair: Pair) -> None:
    draft = pair.a.draft({"entity/bundle/title": "Unsaved amber"})
    pair.b.edit({"entity/bundle/title": "Saved blue"})
    pair.sync()
    pair.a.save_draft(draft)
    assert "entity/bundle/title" in pair.a.view().conflicts
    expected = heads(pair.a.events())
    pair.b.edit({"entity/bundle/note": "More remote work"})
    pair.sync()
    with pytest.raises(Invalid, match="stale"):
        pair.a.resolve({"entity/bundle/title": "Saved blue"}, expected, "stale-choice")
    assert pair.a.db.execute("SELECT count(*) FROM drafts").fetchone()[0] == 1
    assert pair.a.display()["entity/bundle/note"] == "More remote work"


# Independent offline resolutions themselves conflict; neither silently wins
def test_concurrent_resolutions(pair: Pair) -> None:
    pair.a.edit({"entity/bundle/title": "Amber"})
    pair.b.edit({"entity/bundle/title": "Blue"})
    pair.sync()
    pair.a.resolve({"entity/bundle/title": "Amber"}, heads(pair.a.events()), "resolution-A")
    pair.b.resolve({"entity/bundle/title": "Blue"}, heads(pair.b.events()), "resolution-B")
    pair.sync()
    assert_converged(pair)
    assert "entity/bundle/title" in pair.a.view().conflicts


# The receiver can discover a manifest first and wait without changing its good state
def test_missing_dependency_and_manifest_first(pair: Pair) -> None:
    parent = pair.a.edit({"entity/bundle/title": "First"})
    child = pair.a.edit({"entity/bundle/title": "Second"})
    pair.a.publish()
    event = pair.a.events()[child]
    base = pair.b.display()
    commits = pair.b.root / "transport" / "commits"
    payloads = pair.b.root / "transport" / "payloads"
    (commits / "provider-copy.json").write_bytes(encode(event.manifest))
    assert "waiting for complete payload" in pair.b.receive().values()
    assert pair.b.display() == base
    (payloads / "provider-renamed.json").write_bytes(encode(event.changes))
    assert "waiting for ancestry" in pair.b.receive().values()
    assert pair.b.display() == base and parent not in pair.b.events()
    deliver(pair.a, pair.b)
    pair.b.receive()
    assert pair.b.display()["entity/bundle/title"] == "Second"
    assert_converged(pair)


# Truncated payloads, truncated manifests and corruption cannot replace valid local values
@pytest.mark.parametrize(
    "damage", ["partial-body", "partial-manifest", "corrupt-body", "wrong-size"]
)
def test_incomplete_and_corrupt_delivery(pair: Pair, damage: str) -> None:
    event_id = pair.a.edit({"entity/bundle/title": "Complete future value"})
    event = pair.a.events()[event_id]
    raw, body = encode(event.manifest), encode(event.changes)
    if damage == "partial-body":
        body = body[: len(body) // 2]
    elif damage == "partial-manifest":
        raw = raw[: len(raw) // 2]
    elif damage == "corrupt-body":
        body = body.replace(b"future", b"broken")
    else:
        raw = encode({**event.manifest, "size": len(body) + 1})
    (pair.b.root / "transport/payloads/delivery.json").write_bytes(body)
    (pair.b.root / "transport/commits/delivery.json").write_bytes(raw)
    previous = pair.b.display()
    report = pair.b.receive()
    assert "accepted" not in report.values()
    assert pair.b.display() == previous
    assert event_id not in pair.b.events()
    pair.a.publish()
    deliver(pair.a, pair.b)
    pair.b.receive()
    assert pair.b.display()["entity/bundle/title"] == "Complete future value"


# Repeated and renamed conflict copies deduplicate by content identity, not filename
# Random schedules exercise transitive ancestry and independence across several frontiers
@pytest.mark.parametrize("schedule", range(8))
def test_delivery_permutations(pair: Pair, schedule: int) -> None:
    for index in range(4):
        pair.a.edit({"entity/bundle/title": f"Amber {index}"})
        pair.b.edit({"entity/bundle/note": f"Blue {index}"})
    pair.a.publish()
    pair.b.publish()
    rng = random.Random(schedule)
    for source, target in ((pair.a, pair.b), (pair.b, pair.a)):
        paths = list((source.root / "transport").glob("*/*.json"))
        rng.shuffle(paths)
        for path in paths:
            dest = target.root / "transport" / path.parent.name / path.name
            shutil.copyfile(path, dest)
            shutil.copyfile(path, dest.with_name("duplicate-" + dest.name))
            target.receive()
    assert_converged(pair)
    assert not pair.a.view().conflicts
    assert pair.a.display()["entity/bundle/title"] == "Amber 3"
    assert pair.a.display()["entity/bundle/note"] == "Blue 3"
    previous = pair.a.display()
    pair.sync()
    pair.sync()
    assert pair.a.display() == previous


# A disconnected replica can return arbitrarily late because no age-based deletion exists
# Removing provider files never purges locally accepted recovery history
def test_stale_replica_and_transport_deletion(pair: Pair) -> None:
    old = pair.b.edit({"entity/bundle/note": "Sleeping draft"})
    pair.b.close()
    for index in range(10):
        pair.a.edit({"entity/bundle/title": f"Awake {index}"})
    pair.b = Replica(pair.b.root, "replica-B")
    pair.sync()
    assert_converged(pair)
    for path in (pair.a.root / "transport").glob("*/*.json"):
        path.unlink()
    pair.a.receive()
    assert pair.a.recover(old).values["entity/bundle/note"] == "Sleeping draft"
    assert pair.a.display()["entity/bundle/title"] == "Awake 9"
    pair.a.publish()
    assert len(list((pair.a.root / "transport/commits").glob("*.json"))) == 11
    assert pair.a.recover(old).values["entity/bundle/note"] == "Sleeping draft"


# Unknown identities and schema versions leave both active values and local drafts intact
@pytest.mark.parametrize(
    "field,value",
    [
        ("library", "foreign-library"),
        ("epoch", "different-epoch"),
        ("format", 2),
    ],
)
def test_identity_and_schema_quarantine(pair: Pair, field: str, value: Any) -> None:
    event_id = pair.a.edit({"entity/bundle/title": "Foreign candidate"})
    event = pair.a.events()[event_id]
    raw = encode({**event.manifest, field: value})
    (pair.b.root / "transport/commits/unknown.json").write_bytes(raw)
    (pair.b.root / "transport/payloads/unknown.json").write_bytes(encode(event.changes))
    draft = pair.b.draft({"entity/bundle/note": "Keep this unsaved"})
    previous = pair.b.display()
    report = pair.b.receive()
    assert any("incompatible" in status or "foreign" in status for status in report.values())
    assert pair.b.display() == previous
    assert pair.b.db.execute("SELECT body FROM drafts WHERE id=?", (draft,)).fetchone()
    assert pair.b.db.execute("SELECT count(*) FROM quarantine").fetchone()[0] == 1
    if field == "format":
        with pytest.raises(Invalid, match="draft retained"):
            pair.b.save_draft(draft)


# Duplicate operation identities with different bytes cannot quietly become another edit
def test_identity_fork_and_retry(pair: Pair) -> None:
    event_id = pair.a.edit({"entity/bundle/title": "Original"}, operation="stable-operation")
    assert (
        pair.a.edit({"entity/bundle/title": "Original"}, operation="stable-operation") == event_id
    )
    with pytest.raises(Invalid, match="reused"):
        pair.a.edit({"entity/bundle/title": "Different"}, operation="stable-operation")
    pair.sync()
    original = pair.a.events()[event_id]
    fork = make_event(
        pair.a.library,
        pair.a.epoch,
        pair.a.replica,
        "stable-operation",
        original.parents,
        {"entity/bundle/title": "Fork", "entity/bundle/alive": True},
    )
    (pair.b.root / "transport/commits/fork.json").write_bytes(encode(fork.manifest))
    (pair.b.root / "transport/payloads/fork.json").write_bytes(encode(fork.changes))
    assert "operation identity fork" in pair.b.receive().values()
    assert pair.b.display()["entity/bundle/title"] == "Original"


# A manifest collision cannot switch a replica to an unrelated history root
def test_pinned_genesis(pair: Pair, tmp_path: Path) -> None:
    initialize(tmp_path / "replica")
    replica = Replica(tmp_path / "replica", "replica-C", genesis=pair.genesis)
    try:
        other = make_event(
            replica.library,
            replica.epoch,
            "replica-X",
            "another-root",
            [],
            {"entity/new/title": "Other root", "entity/new/alive": True},
        )
        (replica.root / "transport/commits/root.json").write_bytes(encode(other.manifest))
        (replica.root / "transport/payloads/root.json").write_bytes(encode(other.changes))
        assert "unrelated genesis" in replica.receive().values()
        assert not replica.events()
        deliver(pair.a, replica)
        replica.receive()
        assert pair.genesis in replica.events()
    finally:
        replica.close()


# An unhydrated source is neither a metadata tombstone nor a reason to drop the bundle
def test_missing_media_and_idle_open_are_not_authored_edits(pair: Pair) -> None:
    previous = set(pair.a.events())
    assert not (pair.a.root / "media/synthetic-video.mp4").exists()
    for _ in range(6):
        pair.a.view()
        pair.b.view()
        pair.sync()
    assert set(pair.a.events()) == previous
    assert pair.a.display()["entity/video/path"] == "synthetic-video.mp4"
    assert pair.a.display()["entity/video/alive"] is True
    with pytest.raises(Invalid):
        pair.a.edit({"entity/video/path": "../outside.mp4"})


# Invalid structures and unsupported runtime fields fail before changing durable metadata
@pytest.mark.parametrize(
    "changes",
    [
        {"tree/collections": {"root": [], "amber": ["blue"], "blue": ["amber"]}},
        {"tree/collections": {"root": ["amber"]}},
        {"order/bundle": ["image", "image"]},
        {"order/bundle": ["missing"]},
        {"progress/video": 90},
        {"entity/video/path": "/absolute.mp4"},
    ],
)
def test_schema_and_relationship_rejection(pair: Pair, changes: dict[str, Any]) -> None:
    previous = pair.a.display()
    with pytest.raises(Invalid):
        pair.a.edit(changes)
    assert pair.a.display() == previous


# Existing non-synthetic directories and private identities cannot be repurposed
def test_sandbox_boundary(pair: Pair, tmp_path: Path) -> None:
    (tmp_path / "unrelated.txt").write_text("Synthetic unrelated file")
    with pytest.raises(Invalid, match="empty"):
        initialize(tmp_path)
    with pytest.raises(Invalid, match="identity mismatch"):
        Replica(pair.a.root, "different-replica")


# A field-level resolution cannot implicitly resolve a concurrent deletion
# Choosing to keep the object is a separate, visible choice with its affected references
def test_lifetime_choice_cannot_hide_in_field_resolution(pair: Pair) -> None:
    pair.a.edit({"entity/bundle/alive": False, "order/bundle": None})
    pair.b.edit({"entity/bundle/note": "Keep note"})
    pair.sync()
    with pytest.raises(Invalid):
        pair.b.resolve({"entity/bundle/note": "Keep note"}, heads(pair.b.events()), "hidden-life")


# Concurrent new file identities sharing a path require review, even with disjoint IDs
def test_source_identity_collision(pair: Pair) -> None:
    pair.a.edit({"entity/newA/title": "First identity", "entity/newA/path": "new.png"})
    pair.b.edit({"entity/newB/title": "Second identity", "entity/newB/path": "new.png"})
    pair.sync()
    assert pair.a.view().references == {"entity/newA/path", "entity/newB/path"}
    assert_converged(pair)
    assert "entity/newB/path" not in pair.a.display()


# Kill a disposable writer at an exact durability boundary, without normal Python cleanup
def crash_worker(replica: Replica, phase: str, action: str, changes: dict[str, Any]) -> None:
    root, identity = replica.root, replica.replica
    replica.close()
    script = """
import json, os, sys
from pathlib import Path
from prototypes.cloud_metadata.replica import Replica
from prototypes.cloud_metadata.merge import heads
root, identity, phase, action, changes = sys.argv[1:]
r = Replica(Path(root), identity, fault=lambda point: os._exit(73) if point == phase else None)
if action == "publish":
    r.publish()
elif action == "import":
    r.receive()
elif action == "resolve":
    r.resolve(json.loads(changes), heads(r.events()), "crash-operation")
else:
    r.edit(json.loads(changes), operation="crash-operation")
raise AssertionError("failpoint did not execute")
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(root),
            identity,
            phase,
            action,
            encode(changes).decode(),
        ],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 73, result.stderr


# A killed local commit either saves the whole authored transaction or saves none of it
@pytest.mark.parametrize("phase", ["local_before_commit", "local_after_commit"])
def test_crash_during_local_save(pair: Pair, phase: str) -> None:
    changes = {"entity/bundle/title": "Durable title", "entity/bundle/note": "Durable note"}
    previous = pair.a.display()
    crash_worker(pair.a, phase, "edit", changes)
    pair.a = Replica(pair.a.root, "replica-A")
    if phase == "local_before_commit":
        assert pair.a.display() == previous
    else:
        assert pair.a.display()["entity/bundle/title"] == "Durable title"
        assert pair.a.display()["entity/bundle/note"] == "Durable note"
    event_id = pair.a.edit(changes, operation="crash-operation")
    assert (
        sum(event.manifest["operation"] == "crash-operation" for event in pair.a.events().values())
        == 1
    )
    pair.sync()
    assert event_id in pair.b.events()
    assert_converged(pair)


# A killed publisher resumes the original outbox instead of fabricating a new edit identity
@pytest.mark.parametrize(
    "phase",
    [
        "publish_body_temp",
        "publish_body_renamed",
        "publish_manifest_temp",
        "publish_manifest_renamed",
        "publish_before_mark",
    ],
)
def test_crash_during_publish(pair: Pair, phase: str) -> None:
    event = pair.a.edit({"entity/bundle/title": "Published once"})
    crash_worker(pair.a, phase, "publish", {})
    pair.a = Replica(pair.a.root, "replica-A")
    deliver(pair.a, pair.b)
    pair.b.receive()
    assert pair.b.display()["entity/bundle/title"] in {"Synthetic bundle", "Published once"}
    pair.sync()
    assert_converged(pair)
    assert event in pair.b.events()
    assert len(pair.b.events()) == 2


# Import archive and visible state either both commit or both roll back after SIGKILL-like exit
@pytest.mark.parametrize("phase", ["import_before_commit", "import_after_commit"])
def test_crash_during_import(pair: Pair, phase: str) -> None:
    event = pair.a.edit(
        {"entity/bundle/title": "Imported title", "entity/bundle/note": "Imported note"}
    )
    pair.a.publish()
    deliver(pair.a, pair.b)
    previous = pair.b.display()
    crash_worker(pair.b, phase, "import", {})
    pair.b = Replica(pair.b.root, "replica-B")
    if phase == "import_before_commit":
        assert event not in pair.b.events()
        assert pair.b.display() == previous
    else:
        assert event in pair.b.events()
        assert pair.b.display()["entity/bundle/title"] == "Imported title"
        assert pair.b.display()["entity/bundle/note"] == "Imported note"
    pair.b.receive()
    assert_converged(pair)


# Resolution is another durable operation; crashes never erase a losing version
@pytest.mark.parametrize("phase", ["local_before_commit", "local_after_commit"])
def test_crash_during_resolution(pair: Pair, phase: str) -> None:
    rejected = pair.a.edit({"entity/bundle/title": "Amber"})
    pair.b.edit({"entity/bundle/title": "Blue"})
    pair.sync()
    crash_worker(pair.a, phase, "resolve", {"entity/bundle/title": "Blue"})
    pair.a = Replica(pair.a.root, "replica-A")
    assert bool(pair.a.view().conflicts) == (phase == "local_before_commit")
    pair.a.resolve({"entity/bundle/title": "Blue"}, heads(pair.a.events()), "crash-operation")
    pair.sync()
    assert_converged(pair)
    assert pair.b.recover(rejected).values["entity/bundle/title"] == "Amber"


# An incomplete prototype descriptor remains fenced by the production package reader
# Historical legacy-parser behavior is recorded separately in the prototype validation record
def test_incomplete_descriptor_rejected(tmp_path: Path) -> None:
    from cairndex.registry.library_package import read_manifest
    from cairndex.replicas.protocol import PackageFormatError

    marker = tmp_path / ".cairndex"
    marker.mkdir()
    (marker / "manifest.json").write_bytes(
        encode(
            {
                "format": "cairndex.replica-library",
                "format_version": 1,
                "library_uuid": "synthetic-library",
                "display_name": "Synthetic library",
            }
        )
    )
    with pytest.raises(PackageFormatError, match="format"):
        read_manifest(tmp_path)
    assert not (marker / "library.db").exists()


# A conflicting source order also holds the target of a concurrent cross-bundle transfer
# Otherwise partial materialization could assign one file to two bundles
def test_transfer_and_concurrent_order_preserve_unique_membership(pair: Pair) -> None:
    pair.a.edit({"entity/second/title": "Second bundle"})
    pair.sync()
    pair.a.edit({"order/bundle": ["video"], "order/second": ["image"]})
    pair.b.edit({"order/bundle": ["video", "image"]})
    pair.sync()
    assert "order/bundle" in pair.a.view().conflicts
    assert pair.a.view().references == {"order/bundle", "order/second"}
    assert "order/second" not in pair.b.display()
    pair.a.resolve({"order/bundle": ["video"]}, heads(pair.a.events()), "keep-transfer")
    pair.sync()
    assert_converged(pair)
    assert not pair.a.view().references
    assert pair.b.display()["order/second"] == ["image"]
    assert pair.b.display()["order/bundle"] == ["video"]


# Metadata reconciliation neither resolves a provider's media conflict nor changes source bytes
def test_source_path_conflict_never_mutates_media(pair: Pair) -> None:
    sources = [replica.root / "media/synthetic-video.mp4" for replica in (pair.a, pair.b)]
    for path in sources:
        path.write_bytes(b"synthetic placeholder bytes, not a playable video")
    before = [path.read_bytes() for path in sources]
    pair.a.edit({"entity/video/path": "amber-video.mp4"})
    pair.b.edit({"entity/video/path": "blue-video.mp4"})
    pair.sync()
    assert "entity/video/path" in pair.a.view().conflicts
    assert [path.read_bytes() for path in sources] == before
    sources[0].unlink()  # Simulate one provider replica losing local availability
    pair.sync()
    assert pair.a.display()["entity/video/alive"] is True
    assert sources[1].read_bytes() == before[1]
    assert_converged(pair)
