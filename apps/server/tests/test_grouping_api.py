"""Grouping plan review/apply API (ADR-0009 phase 3)."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.persistence.models import AssetBundle, AssetFile
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
    reviewed_ids = list(reversed(original_ids))
    reordered = client.put(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}/files/order",
        json={"ordered_ids": reviewed_ids},
    )
    assert reordered.status_code == 200
    assert [file["asset_file_id"] for file in reordered.json()] == reviewed_ids
    assert [file["sequence"] for file in reordered.json()] == [0, 1, 2]

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
    closed_reorder = client.put(
        f"{base}/plans/{plan_id}/proposals/{proposal_id}/files/order",
        json={"ordered_ids": reviewed_ids},
    )
    assert closed_reorder.status_code == 409


# Require a proposal's complete file set so no reviewed member can be dropped
def test_reorder_rejects_incomplete_proposal_file_set(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    proposal = next(p for p in plan["proposals"] if p["kind"] == "bundle")

    response = client.put(
        f"{base}/plans/{plan['id']}/proposals/{proposal['id']}/files/order",
        json={"ordered_ids": [proposal["files"][0]["asset_file_id"]]},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# Keep collection suggestions out of the bundle-title edit path
def test_rename_rejects_non_bundle_proposal(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    (library_root / "Movies" / "Cosmos").mkdir(parents=True)
    (library_root / "Movies" / "Cosmos" / "cosmos.mp4").write_text("v")
    (library_root / "Movies" / "Waves").mkdir()
    (library_root / "Movies" / "Waves" / "waves.mp4").write_text("v")
    scan_library(session, library_root)
    base = f"/api/v1/libraries/{library_id}/grouping"
    plan = client.post(f"{base}/plans").json()
    container = next(p for p in plan["proposals"] if p["kind"] == "container")

    response = client.patch(
        f"{base}/plans/{plan['id']}/proposals/{container['id']}",
        json={"title": "Not a bundle"},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


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
