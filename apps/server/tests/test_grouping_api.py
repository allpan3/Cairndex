"""Grouping plan review/apply API (ADR-0009 phase 3)."""

from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.grouping import plan_store
from cairndex.grouping.service import gather_observations
from cairndex.grouping.suggester import suggest_grouping
from cairndex.persistence.models import AssetBundle, AssetFile, Collection
from cairndex.scanning.scanner import scan_library


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
    assert reparented.json()["parent_proposal_id"] == container["id"]

    applied = client.post(f"{base}/plans/{plan['id']}/apply")
    assert applied.status_code == 200
    collection = session.scalar(select(Collection).where(Collection.name == "Films"))
    assert collection is not None
    collection_bundles = session.scalars(
        select(AssetBundle).join(AssetBundle.collections).where(Collection.id == collection.id)
    ).all()
    assert {bundle.title for bundle in collection_bundles} == {"Cosmos", "Waves", "Loose"}


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
