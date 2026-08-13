"""Grouping plan review/apply API (ADR-0009 phase 3)."""

from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import event, select, update
from sqlalchemy.orm import Session, sessionmaker

from cairndex.api.schemas.grouping import ProposalKindUpdate
from cairndex.api.v1 import grouping as grouping_api
from cairndex.domain.enums import DEFAULT_STEM_LEVEL, GroupingState, ProposalKind
from cairndex.grouping import plan_store
from cairndex.grouping.service import gather_observations
from cairndex.grouping.suggester import suggest_grouping
from cairndex.persistence.models import AssetBundle, AssetFile, Collection
from cairndex.persistence.models import GroupingPlan as GroupingPlanRow
from cairndex.scanning.scanner import scan_library

# The level at which ``Duo``'s two files below meet. Their names differ only in
# their last segment and are five segments long, so comparing four segments
# (``max - level + 1``, i.e. one rung above the default) merges them.
_MERGES_DUO = 2


def _seed(session: Session, root: Path) -> None:
    (root / "Cosmos").mkdir()
    (root / "Cosmos" / "cosmos.mp4").write_text("v")
    (root / "Cosmos" / "poster.jpg").write_text("i")
    (root / "Cosmos" / "cosmos.en.srt").write_text("s")
    scan_library(session, root)


def test_generate_get_and_apply_plan(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"

    created = client.post(f"{base}/plans")
    assert created.status_code == 201
    plan = created.json()
    assert plan["status"] == "open"
    bundle_proposals = [p for p in plan["proposals"] if p["kind"] == "bundle"]
    assert len(bundle_proposals) == 1
    assert len(bundle_proposals[0]["files"]) == 3

    plan_id = plan["id"]
    fetched = client.get(f"{base}/plans/{plan_id}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == plan_id

    proposal_id = bundle_proposals[0]["id"]
    renamed = client.patch(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}",
        json={"title": "  Renamed Cosmos  "},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Renamed Cosmos"

    original_ids = [file["asset_file_id"] for file in bundle_proposals[0]["files"]]
    reviewed_ids = [*original_ids[1:], original_ids[0]]
    moved = client.put(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}/files/{original_ids[0]}/move",
        json={"target_proposal_id": proposal_id, "target_index": len(original_ids)},
    )
    assert moved.status_code == 200
    edited_proposal = moved.json()[0]
    assert [file["asset_file_id"] for file in edited_proposal["files"]] == reviewed_ids
    assert [file["sequence"] for file in edited_proposal["files"]] == [0, 1, 2]

    listed = client.get(f"{base}/plans")
    assert listed.status_code == 200
    assert any(p["id"] == plan_id for p in listed.json())

    applied = client.post(f"{base}/plans/{plan_id}/apply")
    assert applied.status_code == 200
    result = applied.json()
    assert result["bundles_confirmed"] == 1
    assert result["subtitles_linked"] == 1
    assert result["conflicts"] == []

    bundle = session.scalars(select(AssetBundle)).one()
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.title == "Renamed Cosmos"
    applied_ids = list(
        session.scalars(
            select(AssetFile.id)
            .where(AssetFile.bundle_id == bundle.id)
            .order_by(AssetFile.sequence)
        )
    )
    assert applied_ids == reviewed_ids

    closed_edit = client.patch(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}", json={"title": "Too late"}
    )
    assert closed_edit.status_code == 409
    closed_move = client.put(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}/files/{original_ids[0]}/move",
        json={"target_proposal_id": proposal_id, "target_index": 0},
    )
    assert closed_move.status_code == 409


# Repeated manual generation must use the same confirmed-bundle boundary as Update
def test_regenerate_plan_does_not_reopen_confirmed_bundles(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    first_plan = client.post(f"{base}/plans").json()
    assert client.post(f"{base}/plans/{first_plan['id']}/apply").status_code == 200

    bundle = session.scalars(select(AssetBundle)).one()
    original_file_ids = {file.id for file in bundle.files}
    regenerated = client.post(f"{base}/plans")

    assert regenerated.status_code == 201
    assert regenerated.json()["proposals"] == []
    session.refresh(bundle)
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert {file.id for file in bundle.files} == original_file_ids


# The stem level is a durable input to each generated review snapshot
def test_generate_plan_persists_per_directory_stem_levels(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"

    created = client.post(f"{base}/plans", json={"stem_levels": {"Cosmos": 2}})

    assert created.status_code == 201
    assert created.json()["stem_levels"]["Cosmos"]["level"] == 2
    fetched = client.get(f"{base}/plans/{created.json()['id']}")
    assert fetched.json()["stem_levels"]["Cosmos"]["level"] == 2
    invalid = client.post(f"{base}/plans", json={"stem_levels": {"Cosmos": -1}})
    assert invalid.status_code == 422


# Persist an addition candidate's reversible destination through the public API
def test_switch_addition_destination_and_rename_the_new_bundle(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    initial = client.post(f"{base}/plans").json()
    assert client.post(f"{base}/plans/{initial['id']}/apply").status_code == 200
    (library_root / "Cosmos" / "sequel.mp4").write_text("v2")
    (library_root / "Cosmos" / "sequel.jpg").write_text("i2")
    scan_library(session, library_root)
    plan = client.post(f"{base}/plans").json()
    addition = next(proposal for proposal in plan["proposals"] if proposal["target_bundle_id"])

    assert addition["title"] == "sequel"
    assert addition["target_bundle_title"] == "Cosmos"
    assert addition["create_new_bundle"] is False
    switched = client.put(
        f"{base}/plans/{plan['id']}/proposals/{addition['id']}/destination",
        json={"create_new_bundle": True},
    )
    assert switched.status_code == 200
    assert switched.json()["create_new_bundle"] is True
    assert [file["proposed_role"] for file in switched.json()["files"]] == [
        "primary_video",
        "cover",
    ]
    renamed = client.patch(
        f"{base}/plans/{plan['id']}/proposals/{addition['id']}",
        json={"title": "Sequel Cut"},
    )
    assert renamed.status_code == 200

    restored = client.put(
        f"{base}/plans/{plan['id']}/proposals/{addition['id']}/destination",
        json={"create_new_bundle": False},
    )
    assert restored.status_code == 200
    assert restored.json()["title"] == "Sequel Cut"
    assert restored.json()["create_new_bundle"] is False
    fetched = client.get(f"{base}/plans/{plan['id']}").json()
    persisted = next(
        proposal for proposal in fetched["proposals"] if proposal["id"] == addition["id"]
    )
    assert persisted["title"] == "Sequel Cut"
    assert persisted["target_bundle_title"] == "Cosmos"


# Reject a drag position outside the target bundle suggestion
def test_file_move_rejects_invalid_target_index(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    proposal = next(p for p in plan["proposals"] if p["kind"] == "bundle")

    asset_file_id = proposal["files"][0]["asset_file_id"]
    response = client.put(
        f"{base}/plans/{plan['id']}/proposals/{proposal['id']}/files/{asset_file_id}/move",
        json={"target_proposal_id": proposal["id"], "target_index": 99},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# Collection titles and bundle parents remain editable until apply
def test_rename_collection_and_reparent_bundle_proposal(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Movies" / "Waves").mkdir()
    (library_root / "Movies" / "Waves" / "waves.mp4").write_text("v")
    (library_root / "Loose").mkdir()
    (library_root / "Loose" / "loose.mp4").write_text("v")
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    container = next(p for p in plan["proposals"] if p["kind"] == "container")
    loose = next(p for p in plan["proposals"] if p["title"] == "Loose")

    renamed = client.patch(
        f"{base}/plans/{plan['id']}/proposals/{container['id']}",
        json={"title": "Films"},
    )
    reparented = client.put(
        f"{base}/plans/{plan['id']}/proposals/{loose['id']}/parent",
        json={"parent_proposal_id": container["id"]},
    )

    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Films"
    assert reparented.status_code == 200
    moved = next(
        proposal for proposal in reparented.json()["proposals"] if proposal["id"] == loose["id"]
    )
    assert moved["parent_proposal_id"] == container["id"]

    applied = client.post(f"{base}/plans/{plan['id']}/apply")
    assert applied.status_code == 200
    collection = session.scalar(select(Collection).where(Collection.name == "Films"))
    assert collection is not None
    collection_bundles = session.scalars(
        select(AssetBundle).join(AssetBundle.collections).where(Collection.id == collection.id)
    ).all()
    assert {bundle.title for bundle in collection_bundles} == {"Cosmos", "Waves", "Loose"}


# A placement can target a collection created after the grouping plan snapshot
def test_reparent_bundle_into_current_persisted_collection(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    (library_root / "Incoming").mkdir()
    (library_root / "Incoming" / "sample.mp4").write_text("v")
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    bundle_proposal = next(p for p in plan["proposals"] if p["kind"] == "bundle")

    ambiguous = client.put(
        f"{base}/plans/{plan['id']}/proposals/{bundle_proposal['id']}/parent",
        json={
            "parent_proposal_id": bundle_proposal["id"],
            "target_collection_id": "01K00000000000000000000000",
        },
    )
    assert ambiguous.status_code == 422

    root = Collection(name="Current Archive")
    destination = Collection(name="Current Series", parent=root)
    session.add_all([root, destination])
    session.flush()

    response = client.put(
        f"{base}/plans/{plan['id']}/proposals/{bundle_proposal['id']}/parent",
        json={"target_collection_id": destination.id},
    )

    assert response.status_code == 200
    updated = response.json()
    contexts = {
        proposal["target_collection_id"]: proposal
        for proposal in updated["proposals"]
        if proposal["target_collection_id"] is not None
    }
    moved = next(
        proposal for proposal in updated["proposals"] if proposal["id"] == bundle_proposal["id"]
    )
    assert contexts[root.id]["parent_proposal_id"] is None
    assert contexts[destination.id]["parent_proposal_id"] == contexts[root.id]["id"]
    assert moved["parent_proposal_id"] == contexts[destination.id]["id"]

    root_response = client.put(
        f"{base}/plans/{plan['id']}/proposals/{bundle_proposal['id']}/parent",
        json={"target_collection_id": root.id},
    )
    assert root_response.status_code == 200
    root_contexts = {
        proposal["target_collection_id"]: proposal
        for proposal in root_response.json()["proposals"]
        if proposal["target_collection_id"] is not None
    }
    assert set(root_contexts) == {root.id}

    response = client.put(
        f"{base}/plans/{plan['id']}/proposals/{bundle_proposal['id']}/parent",
        json={"target_collection_id": destination.id},
    )
    assert response.status_code == 200

    applied = client.post(
        f"{base}/plans/{plan['id']}/apply",
        json={"proposal_ids": [bundle_proposal["id"]]},
    )
    assert applied.status_code == 200
    assert applied.json()["collections_created"] == 0
    confirmed = session.scalar(select(AssetBundle).where(AssetBundle.title == "Incoming"))
    assert confirmed is not None
    assert destination in confirmed.collections


# Existing broader-scope plans remain safely editable after the scope is retired
def test_legacy_plan_file_move_applies_across_confirmed_bundles(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    for name in ("Alpha", "Beta"):
        (library_root / name).mkdir()
        (library_root / name / f"{name.lower()}.mp4").write_text("v")
        (library_root / name / "poster.jpg").write_text("i")
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    first_plan = client.post(f"{base}/plans").json()
    assert client.post(f"{base}/plans/{first_plan['id']}/apply").status_code == 200

    original_bundles = {
        bundle.title: bundle.id for bundle in session.scalars(select(AssetBundle)).all()
    }
    legacy_observations = [
        replace(observation, grouping_confirmed=False)
        for observation in gather_observations(session)
    ]
    legacy_plan = plan_store.persist_plan(session, suggest_grouping(legacy_observations))
    plan = client.get(f"{base}/plans/{legacy_plan.id}").json()
    alpha = next(proposal for proposal in plan["proposals"] if proposal["title"] == "Alpha")
    beta = next(proposal for proposal in plan["proposals"] if proposal["title"] == "Beta")
    alpha_poster = next(
        file for file in alpha["files"] if file["relative_path"] == "Alpha/poster.jpg"
    )

    moved = client.put(
        f"{base}/plans/{plan['id']}/proposals/{alpha['id']}/files/{alpha_poster['asset_file_id']}/move",
        json={"target_proposal_id": beta["id"], "target_index": len(beta["files"])},
    )
    applied = client.post(f"{base}/plans/{plan['id']}/apply")

    assert moved.status_code == 200
    assert applied.status_code == 200
    assert applied.json()["conflicts"] == []
    alpha_bundle = session.get(AssetBundle, original_bundles["Alpha"])
    beta_bundle = session.get(AssetBundle, original_bundles["Beta"])
    assert alpha_bundle is not None and beta_bundle is not None
    assert {file.relative_path for file in alpha_bundle.files} == {"Alpha/alpha.mp4"}
    assert {file.relative_path for file in beta_bundle.files} == {
        "Beta/beta.mp4",
        "Beta/poster.jpg",
        "Alpha/poster.jpg",
    }
    assert alpha_bundle.cover_file_id is None


def test_get_unknown_plan_is_404(client: TestClient, library_id: str) -> None:
    resp = client.get(f"/api/v1/libraries/{library_id}/grouping/plans/nope")
    assert resp.status_code == 404


def test_apply_plan_accepts_selected_proposals(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Movies" / "Waves").mkdir()
    (library_root / "Movies" / "Waves" / "waves.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    selected = [
        p["id"] for p in plan["proposals"] if p["kind"] == "container" or p["title"] == "Cosmos"
    ]

    applied = client.post(f"{base}/plans/{plan['id']}/apply", json={"proposal_ids": selected})

    assert applied.status_code == 200
    result = applied.json()
    assert result["bundles_confirmed"] == 1
    assert result["bundles_added_to_collections"] == 1


def test_apply_plan_rejects_empty_selection(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()

    resp = client.post(f"{base}/plans/{plan['id']}/apply", json={"proposal_ids": []})

    assert resp.status_code == 409


# --- Bundle <-> collection conversion ----------------------------------------
def _seed_mixed_folder(session: Session, root: Path) -> None:
    """A folder the suggester is certain is one bundle, but the owner is not.

    Explicit part markers make ``_is_multipart`` true, so the whole folder
    becomes a single bundle at *every* stem sensitivity — Narrow cannot break it
    up. That is exactly the case the owner has no way out of today: three
    recordings that happen to be named as parts, each with its own subtitle,
    which they want as a collection of three bundles.
    """
    folder = root / "Trip"
    folder.mkdir()
    for index in (1, 2, 3):
        (folder / f"Trip.part{index}.mp4").write_text("v")
        (folder / f"Trip.part{index}.srt").write_text("s")
    scan_library(session, root)


def _proposal_tree(plan: dict) -> dict[str | None, list[dict]]:
    tree: dict[str | None, list[dict]] = {}
    for proposal in plan["proposals"]:
        tree.setdefault(proposal["parent_proposal_id"], []).append(proposal)
    return tree


def test_bundle_converts_to_a_collection_of_bundles(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed_mixed_folder(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]

    bundles = [p for p in plan["proposals"] if p["kind"] == "bundle"]
    target = max(bundles, key=lambda p: len(p["files"]))
    file_count = len(target["files"])

    converted = client.put(
        f"{base}/plans/{plan_id}/proposals/{target['id']}/kind", json={"kind": "container"}
    )
    assert converted.status_code == 200, converted.text
    plan = converted.json()

    by_id = {p["id"]: p for p in plan["proposals"]}
    assert by_id[target["id"]]["kind"] == "container"
    # A container holds no files of its own; its members are its children.
    assert by_id[target["id"]]["files"] == []

    children = _proposal_tree(plan).get(target["id"], [])
    assert len(children) > 1, "converting should split the folder into several bundles"
    assert all(c["kind"] == "bundle" for c in children)
    # Every file survives the split exactly once.
    moved = [f["asset_file_id"] for c in children for f in c["files"]]
    assert len(moved) == file_count
    assert len(set(moved)) == file_count

    # Each subtitle stayed with its own video rather than becoming its own
    # bundle — the reason the split reuses the suggester's grouping.
    for child in children:
        paths = [f["relative_path"] for f in child["files"]]
        assert any(p.endswith(".mp4") for p in paths), paths


# New collection suggestions can be placed explicitly without allowing cycles
def test_new_collection_proposal_can_move_between_parent_and_top_level(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed_mixed_folder(session, library_root)
    for name in ("Alpha", "Beta"):
        folder = library_root / "Shelf" / name
        folder.mkdir(parents=True)
        (folder / f"{name}.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    shelf = next(
        proposal
        for proposal in plan["proposals"]
        if proposal["kind"] == "container" and proposal["title"] == "Shelf"
    )
    trip = max(
        (proposal for proposal in plan["proposals"] if proposal["kind"] == "bundle"),
        key=lambda proposal: len(proposal["files"]),
    )
    converted = client.put(
        f"{base}/plans/{plan['id']}/proposals/{trip['id']}/kind",
        json={"kind": "container"},
    ).json()
    trip = next(proposal for proposal in converted["proposals"] if proposal["id"] == trip["id"])

    nested = client.put(
        f"{base}/plans/{plan['id']}/proposals/{trip['id']}/parent",
        json={"parent_proposal_id": shelf["id"]},
    )
    assert nested.status_code == 200, nested.text
    nested_trip = next(
        proposal for proposal in nested.json()["proposals"] if proposal["id"] == trip["id"]
    )
    assert nested_trip["parent_proposal_id"] == shelf["id"]

    cycle = client.put(
        f"{base}/plans/{plan['id']}/proposals/{shelf['id']}/parent",
        json={"parent_proposal_id": trip["id"]},
    )
    assert cycle.status_code == 422
    assert cycle.json()["code"] == "validation_error"

    root = client.put(
        f"{base}/plans/{plan['id']}/proposals/{trip['id']}/parent",
        json={"parent_proposal_id": None},
    )
    assert root.status_code == 200, root.text
    root_trip = next(
        proposal for proposal in root.json()["proposals"] if proposal["id"] == trip["id"]
    )
    assert root_trip["parent_proposal_id"] is None


def test_converted_collection_applies_as_a_real_collection(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed_mixed_folder(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    target = max(
        (p for p in plan["proposals"] if p["kind"] == "bundle"), key=lambda p: len(p["files"])
    )

    plan = client.put(
        f"{base}/plans/{plan_id}/proposals/{target['id']}/kind", json={"kind": "container"}
    ).json()
    child_count = len(_proposal_tree(plan).get(target["id"], []))

    applied = client.post(f"{base}/plans/{plan_id}/apply")
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["collections_created"] >= 1
    assert result["bundles_added_to_collections"] == child_count

    session.expire_all()
    collection = session.scalar(select(Collection).where(Collection.name == "Trip"))
    assert collection is not None
    members = session.scalars(
        select(AssetBundle).where(AssetBundle.collections.any(Collection.id == collection.id))
    ).all()
    assert len(members) == child_count


def test_collection_converts_back_into_one_bundle(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """The conversion is reversible, so a misclick is not a one-way door."""
    _seed_mixed_folder(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    target = max(
        (p for p in plan["proposals"] if p["kind"] == "bundle"), key=lambda p: len(p["files"])
    )
    original_files = {f["asset_file_id"] for f in target["files"]}

    client.put(f"{base}/plans/{plan_id}/proposals/{target['id']}/kind", json={"kind": "container"})
    back = client.put(
        f"{base}/plans/{plan_id}/proposals/{target['id']}/kind", json={"kind": "bundle"}
    )
    assert back.status_code == 200, back.text
    plan = back.json()

    by_id = {p["id"]: p for p in plan["proposals"]}
    assert by_id[target["id"]]["kind"] == "bundle"
    assert {f["asset_file_id"] for f in by_id[target["id"]]["files"]} == original_files
    # The child bundles the split created are gone, not orphaned.
    assert _proposal_tree(plan).get(target["id"], []) == []


def test_converting_to_the_same_kind_is_rejected(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    bundle = next(p for p in plan["proposals"] if p["kind"] == "bundle")
    resp = client.put(
        f"{base}/plans/{plan['id']}/proposals/{bundle['id']}/kind", json={"kind": "bundle"}
    )
    assert resp.status_code == 422


def test_addition_suggestion_cannot_become_a_collection(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """An addition targets an existing confirmed bundle; a collection cannot."""
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]
    client.post(f"{base}/plans/{plan_id}/apply")

    # A new sibling file next to the now-confirmed bundle becomes an addition.
    (library_root / "Cosmos" / "cosmos.extra.mp4").write_text("v2")
    scan_library(session, library_root)
    plan = client.post(f"{base}/plans").json()
    addition = next(
        (p for p in plan["proposals"] if p["target_bundle_id"] and not p["create_new_bundle"]),
        None,
    )
    assert addition is not None, "expected an addition suggestion"

    resp = client.put(
        f"{base}/plans/{plan['id']}/proposals/{addition['id']}/kind", json={"kind": "container"}
    )
    assert resp.status_code == 422


# --- In-place per-directory stem adjustment -----------------------------------
def _seed_three_folders(session: Session, root: Path) -> None:
    """Trip (multipart), Duo (two subjects that Widen merges), Solo (one file)."""
    _seed_mixed_folder(session, root)  # Trip/
    duo = root / "Duo"
    duo.mkdir()
    (duo / "City Tour - Part One - Morning.mp4").write_text("v")
    (duo / "City Tour - Part One - Evening.mp4").write_text("v")
    (root / "Solo").mkdir()
    (root / "Solo" / "Solo.mp4").write_text("v")
    scan_library(session, root)


def test_stem_level_change_preserves_every_other_row_and_edit(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """The reported bug, at the root: adjusting one folder must not rebuild the
    plan. Rows outside the folder keep their ids, so renames, conversions, and
    the client's selection survive structurally."""
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]

    # Owner edits outside Duo: convert Trip to a collection, rename Solo.
    trip = next(p for p in plan["proposals"] if p["title"] == "Trip")
    solo = next(p for p in plan["proposals"] if p["title"] == "Solo")
    plan = client.put(
        f"{base}/plans/{plan_id}/proposals/{trip['id']}/kind", json={"kind": "container"}
    ).json()
    client.patch(f"{base}/plans/{plan_id}/proposals/{solo['id']}", json={"title": "My Solo"})

    before = {p["id"]: p for p in client.get(f"{base}/plans/{plan_id}").json()["proposals"]}
    duo_ids = {pid for pid, p in before.items() if p["directory"] == "Duo"}
    kept_ids = set(before) - duo_ids
    duo_bundles_before = [
        p for p in before.values() if p["directory"] == "Duo" and p["kind"] == "bundle"
    ]
    assert len(duo_bundles_before) == 2, "the default level should propose two Duo bundles"

    adjusted = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Duo", "level": _MERGES_DUO}
    )
    assert adjusted.status_code == 200, adjusted.text
    after = adjusted.json()

    # Same plan, same rows everywhere except Duo.
    assert after["id"] == plan_id
    assert after["stem_levels"]["Duo"]["level"] == _MERGES_DUO
    after_by_id = {p["id"]: p for p in after["proposals"]}
    assert kept_ids <= set(after_by_id), "rows outside Duo must keep their identity"
    assert after_by_id[trip["id"]]["kind"] == "container"
    assert after_by_id[solo["id"]]["title"] == "My Solo"
    trip_children = [p for p in after["proposals"] if p["parent_proposal_id"] == trip["id"]]
    assert len(trip_children) == 3, "the conversion's children survive too"

    # Duo itself genuinely regenerated: one widened bundle (no container needed
    # around a single group), new ids.
    duo_after = [p for p in after["proposals"] if p["directory"] == "Duo"]
    assert [p["kind"] for p in duo_after] == ["bundle"]
    assert len(duo_after[0]["files"]) == 2
    assert not duo_ids & {p["id"] for p in duo_after}


def test_stem_level_back_to_the_default_clears_the_override(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]

    widened = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Duo", "level": _MERGES_DUO}
    ).json()
    assert widened["stem_levels"]["Duo"]["level"] == _MERGES_DUO
    duo_widened = [p for p in widened["proposals"] if p["directory"] == "Duo"]
    assert [p["kind"] for p in duo_widened] == ["bundle"]

    restored = client.put(
        f"{base}/plans/{plan_id}/stem-levels",
        json={"directory": "Duo", "level": DEFAULT_STEM_LEVEL},
    ).json()
    # Back at the default the override is gone, not stored as the default value:
    # a plan carrying `{"Duo": 1}` would pin Duo if the default ever moved.
    assert restored["stem_levels"]["Duo"]["level"] == DEFAULT_STEM_LEVEL
    with Session(session.get_bind()) as fresh:
        stored = fresh.scalar(
            select(GroupingPlanRow.stem_level_overrides).where(GroupingPlanRow.id == plan_id)
        )
    assert stored == {}
    duo_restored = [p for p in restored["proposals"] if p["directory"] == "Duo"]
    assert sorted(p["kind"] for p in duo_restored) == ["bundle", "bundle", "container"]


def test_stem_level_change_requires_an_open_plan(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]
    client.post(f"{base}/plans/{plan_id}/apply")
    resp = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Cosmos", "level": 0}
    )
    assert resp.status_code == 409


# Each folder's dial reports where it is and how far it goes, per folder
def test_plan_reports_a_stem_dial_for_every_folder_it_shows(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """The maximum is folder-specific, so the client has to be told it.

    ``Duo``'s names are five segments long and ``Solo``'s is one, so their dials
    are genuinely different lengths — a single shared "wide" end could not
    describe both, and the client cannot work either out without reimplementing
    the suggester's normalization.
    """
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"

    dials = client.post(f"{base}/plans").json()["stem_levels"]

    assert dials["Duo"] == {"level": DEFAULT_STEM_LEVEL, "max": 5}
    # Nothing to widen in a folder whose one name is a single segment: the dial
    # ends where it starts, and the client renders Widen as spent rather than
    # offering a step that would change nothing.
    assert dials["Solo"] == {"level": DEFAULT_STEM_LEVEL, "max": DEFAULT_STEM_LEVEL}
    # Every folder with files, not only the overridden ones.
    assert set(dials) == {"Duo", "Solo", "Trip"}


# A level past the end of a folder's dial lands on the end, not an error
def test_stem_level_above_a_folder_maximum_is_clamped(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]

    adjusted = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Duo", "level": 99}
    )

    assert adjusted.status_code == 200, adjusted.text
    assert adjusted.json()["stem_levels"]["Duo"] == {"level": 5, "max": 5}


# A plan open across the upgrade still carries the three names it used to store
def test_a_stem_mode_stored_by_a_previous_release_reads_as_a_level(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """``wide`` meant "as wide as this folder goes", which is now the maximum.

    The column is JSON, so the additive-column machinery that patches new columns
    into an existing library does not apply here — nothing rewrites these values,
    and a plan the owner left open across the upgrade would otherwise read as an
    unknown mode.
    """
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]
    session.execute(
        update(GroupingPlanRow)
        .where(GroupingPlanRow.id == plan_id)
        .values(stem_level_overrides={"Duo": "wide", "Trip": "narrow", "Solo": "balanced"})
    )
    session.commit()

    dials = client.get(f"{base}/plans/{plan_id}").json()["stem_levels"]

    assert dials["Duo"] == {"level": 5, "max": 5}
    assert dials["Trip"]["level"] == 0
    assert dials["Solo"]["level"] == DEFAULT_STEM_LEVEL


def test_stem_level_change_does_not_reclaim_a_dragged_out_file(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A file the owner moved out of the directory must not come back in the
    fresh rows — a plan holding the same file twice would bundle it twice."""
    _seed_three_folders(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]

    duo = [p for p in plan["proposals"] if p["directory"] == "Duo" and p["kind"] == "bundle"]
    solo = next(p for p in plan["proposals"] if p["title"] == "Solo")
    moved_file = duo[0]["files"][0]["asset_file_id"]
    client.put(
        f"{base}/plans/{plan_id}/proposals/{duo[0]['id']}/files/{moved_file}/move",
        json={"target_proposal_id": solo["id"], "target_index": 1},
    )

    after = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Duo", "level": 0}
    ).json()

    holders = [
        p["id"]
        for p in after["proposals"]
        if any(f["asset_file_id"] == moved_file for f in p["files"])
    ]
    assert holders == [solo["id"]], "the dragged file must stay only where the owner put it"


def test_stem_level_change_relinks_subdirectory_children(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Replacing a directory's container must not orphan bundles from its
    subdirectories — they follow the container to its successor."""
    show = library_root / "Show"
    (show / "A").mkdir(parents=True)
    (show / "B").mkdir()
    (show / "A" / "a.mp4").write_text("v")
    (show / "B" / "b.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    container = next(
        p for p in plan["proposals"] if p["kind"] == "container" and p["directory"] == "Show"
    )
    child_ids = {p["id"] for p in plan["proposals"] if p["parent_proposal_id"] == container["id"]}
    assert len(child_ids) == 2

    after = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Show", "level": 0}
    ).json()

    fresh_container = next(
        p for p in after["proposals"] if p["kind"] == "container" and p["directory"] == "Show"
    )
    assert fresh_container["id"] != container["id"]
    for child_id in child_ids:
        child = next(p for p in after["proposals"] if p["id"] == child_id)
        assert child["parent_proposal_id"] == fresh_container["id"]


def test_stem_change_refuses_to_wipe_a_hand_merged_cross_directory_bundle(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Merging a collection whose bundles live in subfolders leaves one row whose
    ``directory`` is the parent — a folder the suggester proposes nothing for.
    Splicing it would delete the row and put nothing back, dropping the files out
    of the plan; refuse instead. The UI also stops offering the control there."""
    show = library_root / "Show"
    (show / "A").mkdir(parents=True)
    (show / "B").mkdir()
    (show / "A" / "a.mp4").write_text("v")
    (show / "B" / "b.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    container = next(
        p for p in plan["proposals"] if p["kind"] == "container" and p["directory"] == "Show"
    )
    merged = client.put(
        f"{base}/plans/{plan_id}/proposals/{container['id']}/kind", json={"kind": "bundle"}
    ).json()
    row = next(p for p in merged["proposals"] if p["directory"] == "Show")
    assert len(row["files"]) == 2

    refused = client.put(
        f"{base}/plans/{plan_id}/stem-levels", json={"directory": "Show", "level": 0}
    )
    assert refused.status_code == 422, refused.text

    # The merged row and both files are untouched.
    after = client.get(f"{base}/plans/{plan_id}").json()
    kept = [p for p in after["proposals"] if p["directory"] == "Show"]
    assert [p["kind"] for p in kept] == ["bundle"]
    assert len(kept[0]["files"]) == 2


def test_folder_named_bundle_converts_to_a_named_collection(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """The owner-reported case: one release in a folder named for something else.

    A folder holding a single release plus its cover is suggested as one bundle
    named after the folder. The owner wants the folder to be a collection with the
    release inside it under its own name. The old positional bound refused this
    whenever the row already sat in a collection for its folder; the rename test
    allows it, because the child is named by the files' shared stem rather than by
    the folder (owner-reported, 2026-08-13).
    """
    folder = library_root / "Studio Beta"
    folder.mkdir()
    (folder / "n0203 - a long release name.mp4").write_text("v")
    (folder / "n0203.jpg").write_text("i")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    bundle = next(
        p for p in plan["proposals"] if p["kind"] == "bundle" and p["title"] == "Studio Beta"
    )

    converted = client.put(
        f"{base}/plans/{plan_id}/proposals/{bundle['id']}/kind", json={"kind": "container"}
    )
    assert converted.status_code == 200, converted.text

    proposals = converted.json()["proposals"]
    collection = next(p for p in proposals if p["id"] == bundle["id"])
    assert collection["kind"] == "container"
    assert collection["title"] == "Studio Beta"

    # The release inside is named by the shortest prefix its files share — the
    # release's own identifier — rather than by the video's whole filename or the
    # folder's name (owner-reported, 2026-08-13).
    children = [p for p in proposals if p["parent_proposal_id"] == bundle["id"]]
    assert len(children) == 1
    assert children[0]["title"] == "n0203"
    assert children[0]["title"] != collection["title"]
    assert len(children[0]["files"]) == 2

    # And it is reversible.
    back = client.put(
        f"{base}/plans/{plan_id}/proposals/{bundle['id']}/kind", json={"kind": "bundle"}
    )
    assert back.status_code == 200, back.text


def test_single_item_bundle_converts_once_then_stops(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A single subject may become a collection, until doing so renames nothing.

    What made this nest without limit was that the child of a conversion could be
    converted again, each click repeating the same name one level deeper
    (owner-reported, 2026-07-30). The bound used to be positional — refuse any row
    already inside a collection for its own folder — but that also refused the
    case the owner wants: a folder holding one release today becoming a collection
    with the release named by its own stem inside it (owner-reported, 2026-08-13).

    The bound is now whether the new layer changes a name. Here the folder and its
    one file share the name "Solo", so the child would be called "Solo" inside a
    collection called "Solo" — nothing gained, refused. `test_folder_named_bundle_
    converts_to_a_named_collection` covers the case that is now allowed.
    """
    (library_root / "Solo").mkdir()
    (library_root / "Solo" / "Solo.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    plan_id = plan["id"]
    solo = next(p for p in plan["proposals"] if p["title"] == "Solo")

    # Folder "Solo" holding "Solo.mp4": the child would be called "Solo" too, so
    # the collection adds no structure and is refused at the first attempt.
    again = client.put(
        f"{base}/plans/{plan_id}/proposals/{solo['id']}/kind",
        json={"kind": "container"},
    )
    assert again.status_code == 422, again.text


def test_converted_bundle_and_collection_apply_immediately(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """The conversion response's collection and child ids must be accepted by
    the very next request, without a plan refresh in between."""
    folder = library_root / "Synthetic Set"
    folder.mkdir()
    (folder / "Synthetic Clip.mp4").write_text("v")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    source = next(p for p in plan["proposals"] if p["kind"] == "bundle")
    converted = client.put(
        f"{base}/plans/{plan['id']}/proposals/{source['id']}/kind",
        json={"kind": "container"},
    )
    assert converted.status_code == 200, converted.text
    proposals = converted.json()["proposals"]
    selected = [
        p["id"]
        for p in proposals
        if p["id"] == source["id"] or p["parent_proposal_id"] == source["id"]
    ]
    assert len(selected) == 2

    applied = client.post(
        f"{base}/plans/{plan['id']}/apply",
        json={"proposal_ids": selected},
    )

    assert applied.status_code == 200, applied.text
    assert applied.json()["collections_created"] == 1
    assert applied.json()["bundles_confirmed"] == 1
    assert applied.json()["bundles_added_to_collections"] == 1


def test_conversion_response_ids_are_durable_before_the_response_returns(
    library_root: Path,
    session: Session,
    session_factory: sessionmaker[Session],
) -> None:
    """A second request can start as soon as the client receives the response.

    On a slow library database, relying on the request dependency's teardown to
    commit leaves a window where the response names new child proposals that a
    concurrent apply session cannot see yet.
    """
    folder = library_root / "Durable Set"
    folder.mkdir()
    (folder / "Durable Clip.mp4").write_text("v")
    scan_library(session, library_root)
    session.commit()

    with session_factory() as writer:
        plan = plan_store.generate_plan(writer)
        writer.commit()
        source = next(p for p in plan.proposals if p.kind is ProposalKind.BUNDLE)
        response = grouping_api.convert_proposal_kind(
            plan.id,
            source.id,
            ProposalKindUpdate(kind=ProposalKind.CONTAINER),
            writer,
        )
        selected = {
            p.id
            for p in response.proposals
            if p.id == source.id or p.parent_proposal_id == source.id
        }
        assert len(selected) == 2

        with session_factory() as reader:
            persisted = plan_store.get_plan(reader, plan.id)
            assert selected <= {p.id for p in persisted.proposals}


def test_one_video_with_sidecars_stays_one_bundle_when_divided(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Dividing keeps a video's sidecars with it rather than splitting per file."""
    _seed(session, library_root)  # Cosmos: one video + poster + subtitle
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    cosmos = next(p for p in plan["proposals"] if p["kind"] == "bundle")
    assert len(cosmos["files"]) == 3

    converted = client.put(
        f"{base}/plans/{plan['id']}/proposals/{cosmos['id']}/kind", json={"kind": "container"}
    )
    assert converted.status_code == 200, converted.text
    children = [p for p in converted.json()["proposals"] if p["parent_proposal_id"] == cosmos["id"]]
    # One subject in, one bundle out — all three files together, not one each.
    assert len(children) == 1
    assert len(children[0]["files"]) == 3


def test_image_only_bundle_divides_per_file(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """With no video to centre a bundle on, a photo dump divides per file — the
    one case where the per-file split is the right reading."""
    shots = library_root / "Shots"
    shots.mkdir()
    for name in ("a", "b", "c"):
        (shots / f"{name}.jpg").write_text("i")
    scan_library(session, library_root)

    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    # The suggester already splits an image folder per file, so merge first to
    # get a single multi-image bundle to divide.
    container = next(p for p in plan["proposals"] if p["kind"] == "container")
    merged = client.put(
        f"{base}/plans/{plan['id']}/proposals/{container['id']}/kind", json={"kind": "bundle"}
    ).json()
    row = next(p for p in merged["proposals"] if p["kind"] == "bundle")
    assert len(row["files"]) == 3

    divided = client.put(
        f"{base}/plans/{plan['id']}/proposals/{row['id']}/kind", json={"kind": "container"}
    )
    assert divided.status_code == 200, divided.text
    children = [p for p in divided.json()["proposals"] if p["parent_proposal_id"] == row["id"]]
    assert len(children) == 3
    assert all(len(c["files"]) == 1 for c in children)


def _count_statements(session: Session) -> tuple[list[str], object]:
    """Record every SQL statement issued on this session's connection."""
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        statements.append(statement)

    bind = session.get_bind()
    event.listen(bind, "before_cursor_execute", record)
    return statements, record


def test_reading_a_plan_costs_the_same_number_of_queries_at_any_size(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A plan read must not issue a query per suggestion.

    ``plan.proposals`` and ``proposal.files`` both load lazily, and the response
    carries the whole plan — so serializing it walked the files one proposal at a
    time. Local SSD hid that at a fraction of a millisecond per round trip; a
    NAS-mounted library pays network latency for every one, which is what turned a
    conversion in a large library into a stall (owner-reported, 2026-07-30).

    The assertion is on *round trips*, not seconds, because that is the thing that
    scales with the plan and the thing a network filesystem multiplies.
    """
    for index in range(12):
        folder = library_root / f"Set{index:02d}"
        folder.mkdir()
        (folder / f"clip{index}.mp4").write_text("v")
        (folder / f"clip{index}.jpg").write_text("i")
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan_id = client.post(f"{base}/plans").json()["id"]

    statements, listener = _count_statements(session)
    try:
        big = client.get(f"{base}/plans/{plan_id}")
        assert big.status_code == 200
        assert len(big.json()["proposals"]) >= 12
        for_many = len(statements)

        statements.clear()
        listed = client.get(f"{base}/plans")
        assert listed.status_code == 200
        assert listed.json()[0]["proposal_count"] >= 12
        for_list = len(statements)
    finally:
        event.remove(session.get_bind(), "before_cursor_execute", listener)

    # Three: the plan, its proposals, their files. The bound is deliberately
    # loose — what matters is that it does not grow with the 12+ proposals.
    assert for_many <= 8, f"plan read issued {for_many} queries for 12+ proposals"
    # The summary needs the counts, not the rows.
    assert for_list <= 4, f"plans list issued {for_list} queries"
