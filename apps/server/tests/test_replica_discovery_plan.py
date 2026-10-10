"""Complete grouping semantics are independent of the disk planner's batch boundaries"""

from uuid import uuid4

import pytest

from cairndex.grouping.suggester import FileObservation, suggest_grouping
from cairndex.replicas import discovery
from cairndex.replicas import discovery_plan as plan
from cairndex.replicas import discovery_proposals as proposals
from cairndex.replicas import discovery_state as state
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import specimen as specimen


# Stop after source repair so tests exercise the new planner without the earlier bounded proposer
def prepare_index(store, root):
    run = uuid4().hex
    state.enqueue(store, run)
    for _ in range(1000):
        if state.run(store)["phase"] == "propose":
            break
        discovery.tick(store, root)
    else:
        pytest.fail("Discovery did not reach planning")
    for known in (False, True):
        after = ""
        for _ in range(1000):
            if plan.index_batch(store, run, after, known=known):
                break
            after = state.run(store)["cursor"]
        else:
            pytest.fail("Planner indexing did not finish")
    return run


# Compare full output structure and member order against the established pure grouping semantics
@pytest.mark.parametrize(
    "shape", ["parts", "album", "collection", "nested", "folder-extras", "video-extras"]
)
def test_disk_plan_matches_complete_grouping(replicas, shape):
    store, root, _ = replicas[0]
    if shape == "parts":
        paths = [f"Parts/feature.part{i:03}.mp4" for i in range(201)]
    elif shape == "album":
        paths = [f"Album/picture{i:03}.png" for i in range(201)]
    elif shape == "collection":
        paths = [
            f"Shelf/work{i:03}.{suffix}" for i in range(70) for suffix in ("mp4", "srt", "png")
        ]
    elif shape == "nested":
        paths = [f"Shelf/Series/episode{i:03}.mp4" for i in range(5)] + ["Shelf/Feature/movie.mp4"]
    else:
        paths = ["Feature/movie.mp4", "Feature/poster.png"] + [
            f"Feature/Extras/picture{i:03}.png" for i in range(201)
        ]
        if shape == "video-extras":
            paths += [f"Feature/Extras/clip{i:03}.mp4" for i in range(2)]
    for path in paths:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(("synthetic " + path).encode())
    run = prepare_index(store, root)
    with store.connection() as db:
        observations = [
            FileObservation(
                row["file_id"],
                row["path"],
                discovery.media_kind(row["path"]),
                bool(row["owner"]),
                row["owner"],
                row["owner_title"],
            )
            for row in db.execute("SELECT * FROM discovery_plan_files WHERE run=?", (run,))
        ]
    expected = suggest_grouping(observations).proposals
    for _ in range(3000):
        with store.connection() as db:
            previous = db.execute(
                "SELECT COUNT(*) FROM discovery_plan_files WHERE run=? AND role IS NOT NULL", (run,)
            ).fetchone()[0]
            done = plan.tick(db, run)
            current = db.execute(
                "SELECT COUNT(*) FROM discovery_plan_files WHERE run=? AND role IS NOT NULL", (run,)
            ).fetchone()[0]
            assert current - previous <= plan.BATCH
        if done:
            break
    else:
        pytest.fail("Complete grouping did not finish")
    with store.connection(readonly=True) as db:
        actual = []
        for group in db.execute("SELECT * FROM discovery_plan_groups WHERE run=?", (run,)):
            files = [
                (row[0], row[1], row[2])
                for row in db.execute(
                    "SELECT file_id,role,sequence FROM discovery_plan_files WHERE run=? "
                    "AND proposal=? ORDER BY sequence",
                    (run, group["id"]),
                )
            ]
            actual.append(
                (
                    group["kind"],
                    group["directory"],
                    group["parent"],
                    group["title"],
                    group["target"],
                    files,
                )
            )
    wanted = [
        (
            p.kind.value,
            p.directory,
            p.parent_directory,
            p.title,
            p.target_bundle_id,
            [(f.asset_file_id, f.role.name, f.sequence) for f in p.files],
        )
        for p in expected
    ]
    assert sorted(actual, key=lambda p: (p[1], p[3], p[0])) == sorted(
        wanted, key=lambda p: (p[1], p[3], p[0])
    )
    for _ in range(3000):
        with store.connection() as db:
            if proposals.tick(db, run):
                break
    else:
        pytest.fail("Candidate export did not finish")
    with store.connection(readonly=True) as db:
        for candidate in db.execute("SELECT * FROM discovery_candidates WHERE run=?", (run,)):
            assert candidate["state"] == "pending"
            page = proposals.display(db, candidate)["body"]
            assert len(page["files"]) <= 50
            members = list(page["files"])
            after = page["files_next"]
            while after is not None:
                next_page = proposals.files(db, candidate["id"], after)
                members.extend(next_page["items"])
                after = next_page["next_cursor"]
            assert len(members) == page["file_count"]
            assert len({member["path"] for member in members}) == len(members)
