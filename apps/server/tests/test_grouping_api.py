"""Grouping plan review/apply API (ADR-0009 phase 3)."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.persistence.models import AssetBundle
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


def test_get_unknown_plan_is_404(client: TestClient, library_id: str) -> None:
    resp = client.get(f"/api/v1/libraries/{library_id}/grouping/plans/nope")
    assert resp.status_code == 404
