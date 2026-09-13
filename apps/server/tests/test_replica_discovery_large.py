"""Complete directory reviews, settled additions and collection selections use synthetic sources"""

import json
from uuid import uuid4

import pytest

from cairndex.replicas import discovery_review
from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog.model import key
from tests.test_replica_discovery import replicas as replicas
from tests.test_replica_discovery import scan
from tests.test_replica_discovery import specimen as specimen


# Drive durable phases until the requested boundary, reporting retained errors on failure
def advance(store, root, operation, wanted):
    for _ in range(5000):
        discovery_review.step(store, root)
        result = state.review(store, operation)
        assert result["state"] != "failed", result["error"]
        if result["state"] == wanted:
            return result
    pytest.fail("Review did not finish its persisted phases")


# Public review intent defaults to all members, including every source beyond the first page
def accept(store, root, candidate, **intent):
    operation = uuid4().hex
    state.prepare(store, operation, {"candidate": candidate["id"], **intent})
    ready = advance(store, root, operation, "ready")
    state.accept(store, operation, ready["receipt"])
    return advance(store, root, operation, "applied")


# Whole sets retain one bundle, order, roles and folder context across more than 128 files
@pytest.mark.parametrize("kind", ["parts", "album"])
def test_large_review_is_complete(replicas, kind):
    store, root, _ = replicas[0]
    folder = root / "Complete"
    folder.mkdir()
    for index in range(201):
        name = f"scene.part{index:03}.mp4" if kind == "parts" else f"image{index:03}.png"
        (folder / name).write_bytes(f"synthetic {index}".encode())
    scan(store, root)
    candidate = next(
        c for c in state.candidates(store)["items"] if c["body"]["title"] == "Complete"
    )
    assert candidate["body"]["file_count"] == 201
    assert len(candidate["body"]["files"]) == 50
    result = accept(store, root, candidate)
    assert result["prepared"]["file_count"] == 201
    with store.connection(readonly=True) as db:
        files = [
            json.loads(row[0])
            for row in db.execute(
                "SELECT body FROM catalog_rows WHERE family='asset_files' "
                "AND json_extract(body,'$.relative_path') LIKE 'Complete/%'"
            )
        ]
        assert len(files) == 201
        targets = {file["bundle_id"] for file in files}
        assert len(targets) == 1
        target = targets.pop()
        members = json.loads(
            db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (key("asset_bundles", target, "$members"),),
            ).fetchone()[0]
        )
        assert len(members) == 201 + (kind == "album")
        if kind == "parts":
            assert {file["role"] for file in files} == {"VIDEO_PART"}
        else:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM catalog_rows WHERE family='bundle_directory_members' "
                    "AND json_extract(body,'$.bundle_id')=?",
                    (target,),
                ).fetchone()[0]
                == 1
            )
    scan(store, root)
    assert not state.candidates(store)["items"]


# A settled directory with more than 128 owners still guides additions without regrouping old files
def test_large_settled_bundle_gets_addition(replicas):
    store, root, _ = replicas[0]
    folder = root / "Sequence"
    folder.mkdir()
    for index in range(150):
        (folder / f"feature.part{index:03}.mp4").write_bytes(f"synthetic part {index}".encode())
    scan(store, root)
    first = state.candidates(store)["items"][0]
    result = accept(store, root, first, collection="collections-child")
    target = result["prepared"]["groups"][0]["target"]
    before = store.entity("asset_bundles", target)
    (folder / "feature.part000.srt").write_text("synthetic subtitle")
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["target"] == target
    accept(store, root, candidate)
    after = store.entity("asset_bundles", target)
    assert len(json.loads(after["fields"]["$members"]["value"])) == 151
    assert before["fields"]["title"] == after["fields"]["title"]
    with store.connection(readonly=True) as db:
        assert db.execute(
            "SELECT 1 FROM catalog_rows WHERE family='asset_bundle_collections' AND entity=?",
            (target + "~collections-child",),
        ).fetchone()


# Accepting one descendant carries its ancestors and leaves the remaining collection reviewable
def test_collection_selection_preserves_siblings_and_existing_placement(replicas):
    store, root, _ = replicas[0]
    folder = root / "Shelf" / "Series"
    folder.mkdir(parents=True)
    for index in range(3):
        (folder / f"chapter{index}.mp4").write_bytes(f"synthetic chapter {index}".encode())
    scan(store, root)
    candidates = state.candidates(store)["items"]
    collection = next(
        c for c in candidates if c["body"]["kind"] == "collection" and c["body"]["title"] == "Shelf"
    )
    child = next(c for c in candidates if c["body"]["kind"] == "new")
    accept(store, root, child)
    assert any(c["id"] == collection["id"] for c in state.candidates(store)["items"])
    result = accept(store, root, collection, collection="collections-child")
    assert result["prepared"]["file_count"] == 2
    with store.connection(readonly=True) as db:
        rows = [
            json.loads(row[0])
            for row in db.execute("SELECT body FROM catalog_rows WHERE family='collections'")
        ]
        assert any(
            row["name"] == "Shelf" and row["parent_id"] == "collections-child" for row in rows
        )
        assert len([row for row in rows if row["name"] == "Series"]) == 2
        assert (
            db.execute(
                "SELECT COUNT(*) FROM catalog_paths WHERE family='asset_files' AND path LIKE "
                "'Shelf/%'"
            ).fetchone()[0]
            == 3
        )
    assert not state.candidates(store)["items"]


# Reopening a partial album appends remaining sources without duplicating folder ownership
def test_partial_album_reuses_settled_bundle_and_keeps_order(replicas):
    store, root, _ = replicas[0]
    folder = root / "Album"
    folder.mkdir()
    for index in range(30):
        (folder / f"frame{index:03}.png").write_bytes(f"synthetic frame {index}".encode())
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    files = candidate["body"]["files"]
    first = accept(
        store,
        root,
        candidate,
        exclude_files=[files[-1]["id"]],
        moves=[{"file": files[2]["id"], "before": files[1]["id"]}],
    )
    assert [file["id"] for file in first["prepared"]["files"][:3]] == [
        files[i]["id"] for i in (0, 2, 1)
    ]
    remaining = state.candidates(store)["items"][0]
    assert sum(file["accepted"] for file in remaining["body"]["files"]) == 29
    second = accept(store, root, remaining)
    assert second["prepared"]["file_count"] == 1
    assert second["prepared"]["groups"][0]["target"] == first["prepared"]["groups"][0]["target"]
    assert not state.candidates(store)["items"]


# Every missing identity stays selectable even when matching evidence spans more than 128 originals
def test_missing_identity_choices_are_complete_and_paged(replicas):
    from cairndex.replicas.discovery_choices import page
    from cairndex.replicas.discovery_validation import validate

    store, root, _ = replicas[0]
    folder = root / "Copies"
    folder.mkdir()
    for index in range(150):
        (folder / f"frame{index:03}.png").write_bytes(b"synthetic identical source")
    scan(store, root)
    accept(store, root, state.candidates(store)["items"][0])
    for source in folder.iterdir():
        source.unlink()
    (root / "moved.png").write_bytes(b"synthetic identical source")
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    assert candidate["body"]["choices_total"] == 150
    assert len(candidate["body"]["choices"]) == 50
    chosen = candidate["body"]["choices"]
    after = candidate["body"]["choices_next"]
    with store.connection(readonly=True) as db:
        while after:
            part = page(db, candidate["id"], after)
            chosen.extend(part["items"])
            after = part["next_cursor"]
        validate(db, store)
    assert len({item["file_id"] for item in chosen}) == 150
    result = accept(store, root, candidate, repair_file=chosen[-1]["file_id"])
    assert result["prepared"]["files"][0]["id"] == chosen[-1]["file_id"]
