"""Grouping acceptance survives controlled commit boundaries without duplicate metadata"""

from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import GroupingState
from cairndex.persistence.models import AssetBundle
from cairndex.scanning.scanner import scan_library


# Generate two independent proposals through the ordinary authenticated metadata API
def _review(client: TestClient, library_id: str, session: Session, root: Path):
    from cairndex.metadata.schema import ensure_metadata_schema
    from cairndex.persistence.engine import ensure_plans_schema

    # TestClient startup discards earlier fixture plans; reopen the actual new on-disk generation
    session.close()
    engine = session.get_bind()
    engine.dispose()
    ensure_plans_schema(engine)
    ensure_metadata_schema(engine)
    for name in ("Amber", "Blue"):
        directory = root / name
        directory.mkdir()
        (directory / f"{name}.mp4").write_bytes(b"synthetic video")
        (directory / "poster.jpg").write_bytes(b"synthetic image")
    scan_library(session, root)
    base = f"/api/v1/libraries/{library_id}/grouping/plans"
    response = client.post(base)
    assert response.status_code == 201
    plan = response.json()
    selected = next(row for row in plan["proposals"] if row["kind"] == "bundle")
    headers = {
        "X-Cairndex-Basis": response.headers["X-Cairndex-Basis"],
        "X-Cairndex-Operation": uuid4().hex,
    }
    return f"{base}/{plan['id']}", plan, selected, headers


# Durable library changes must precede any deletion from the disposable plan database
def test_apply_commits_content_before_retiring_plan(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    url, plan, selected, headers = _review(client, library_id, session, library_root)
    engine = session.get_bind()
    commits = []
    statements = []

    # Record actual SQL ordering, including the receipt in the portable DB
    def statement(_conn, _cursor, sql, _parameters, _context, _many):
        statements.append(sql)

    # Capture statements at each real transaction commit boundary
    def committed(_conn):
        commits.append(list(statements))
        statements.clear()

    event.listen(engine, "before_cursor_execute", statement)
    event.listen(engine, "commit", committed)
    try:
        response = client.post(
            url + "/apply", json={"proposal_ids": [selected["id"]]}, headers=headers
        )
    finally:
        event.remove(engine, "before_cursor_execute", statement)
        event.remove(engine, "commit", committed)
    assert response.status_code == 200, response.text
    content_commit = next(
        i for i, sql in enumerate(commits) if any("INSERT INTO metadata_receipts" in s for s in sql)
    )
    retirement_commit = next(
        i
        for i, sql in enumerate(commits)
        if any("DELETE FROM plans.grouping_proposals" in s for s in sql)
    )
    assert content_commit < retirement_commit
    assert response.json()["proposals_remaining"] == 1
    retry = client.post(url + "/apply", json={"proposal_ids": [selected["id"]]}, headers=headers)
    assert retry.content == response.content
    assert retry.headers["X-Cairndex-Basis"] == response.headers["X-Cairndex-Basis"]
    assert len(client.get(url).json()["proposals"]) == 1
    assert (
        len(
            list(
                session.scalars(
                    select(AssetBundle).where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
                )
            )
        )
        == 1
    )


# A superseded snapshot must never apply merely because its file rows still exist
def test_superseded_plan_cannot_apply(client, library_id, session, library_root):
    url, plan, selected, headers = _review(client, library_id, session, library_root)
    client.post(url.rsplit("/", 1)[0])
    response = client.post(url + "/apply", json={"proposal_ids": [selected["id"]]})
    assert response.status_code == 409
    assert not list(
        session.scalars(
            select(AssetBundle).where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
        )
    )


# A lost response after content commit recovers remaining review before replaying the exact result
@pytest.mark.parametrize("boundary", ["before_content", "after_content", "after_plan"])
def test_apply_process_crash_and_retry(client, library_id, session, library_root, boundary):
    import subprocess
    import sys

    url, plan, selected, headers = _review(client, library_id, session, library_root)
    plans_path = next(
        row[2]
        for row in session.connection().exec_driver_sql("PRAGMA database_list")
        if row[1] == "plans"
    )
    session.close()
    payload = {"proposal_ids": [selected["id"]]}
    # The child exits at actual SQLite commit boundaries, with no rollback/finally cleanup
    script = """
import json, os, sys
from dataclasses import asdict
from sqlalchemy.orm import Session
from cairndex.persistence.engine import create_app_engine
from cairndex.grouping.plan_store import get_plan
from cairndex.grouping.apply import apply_plan
from cairndex.grouping.recovery import recover_before_read
from cairndex.metadata.session import begin_edit, save_receipt
root, plan_id, proposal_id, basis, operation, url, boundary, data_dir = sys.argv[1:]
os.environ["CAIRNDEX_DATA_DIR"] = data_dir
from cairndex.core.config import get_settings
get_settings.cache_clear()
engine = create_app_engine(database_url="sqlite:///" + root + "/.cairndex/library.db")
with Session(engine) as db:
    payload = json.dumps({"proposal_ids": [proposal_id]}, separators=(",", ":")).encode()
    _, digest = begin_edit(db, basis=basis, operation=operation, review=None,
        method="POST", path=url + "/apply?", body=payload)
    result = apply_plan(db, get_plan(db, plan_id),
        proposal_ids={proposal_id}, defer_settlement=True)
    body = json.dumps(asdict(result), separators=(",", ":")).encode()
    save_receipt(db, operation, digest, 200, body)
    if boundary == "before_content": os._exit(41)
    db.commit()
    if boundary == "after_content": os._exit(42)
    original = Session.commit
    def crash_after_plan(self):
        original(self)
        os._exit(43)
    Session.commit = crash_after_plan
    recover_before_read(db)
"""
    exited = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(library_root),
            plan["id"],
            selected["id"],
            headers["X-Cairndex-Basis"],
            headers["X-Cairndex-Operation"],
            url,
            boundary,
            str(Path(plans_path).parent.parent),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert (
        exited.returncode == {"before_content": 41, "after_content": 42, "after_plan": 43}[boundary]
    ), exited.stderr
    # Read through the API first: pending retirement is finished without reapplying metadata
    review = client.get(url)
    assert review.status_code == 200, review.text
    remaining = [p for p in review.json()["proposals"] if p["kind"] == "bundle"]
    assert len(remaining) == (2 if boundary == "before_content" else 1)
    retry = client.post(url + "/apply", json=payload, headers=headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()["bundles_confirmed"] == 1
    assert retry.json()["proposals_remaining"] == 1
    again = client.post(url + "/apply", json=payload, headers=headers)
    assert again.content == retry.content
    assert (
        len(
            list(
                session.scalars(
                    select(AssetBundle).where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
                )
            )
        )
        == 1
    )
    assert (
        session.connection()
        .exec_driver_sql(
            "SELECT count(*) FROM metadata_receipts WHERE grouping_settlement IS NOT NULL"
        )
        .scalar_one()
        == 0
    )


# An addition's missing source must stay available for repair instead of joining a settled bundle
def test_missing_addition_does_not_change_confirmed_membership(session, library_root):
    from cairndex.domain.enums import FileAvailability
    from cairndex.grouping import apply as grouping_apply
    from cairndex.grouping import plan_store
    from cairndex.persistence.models import AssetFile

    folder = library_root / "Amber"
    folder.mkdir()
    (folder / "clip.mp4").write_bytes(b"synthetic video")
    scan_library(session, library_root)
    grouping_apply.apply_plan(session, plan_store.generate_plan(session))
    session.commit()
    target = session.scalars(select(AssetBundle)).one()
    target.notes = ["Settled annotation"]
    session.commit()
    (folder / "clip.en.srt").write_bytes(b"synthetic subtitle")
    scan_library(session, library_root)
    plan = plan_store.generate_plan(session)
    addition = next(p for p in plan.proposals if p.target_bundle_id)
    row = session.get(AssetFile, addition.files[0].asset_file_id)
    original_bundle = row.bundle_id
    row.availability = FileAvailability.MISSING
    session.commit()
    result = grouping_apply.apply_plan(session, plan, proposal_ids={addition.id})
    assert result.files_added_to_bundles == 0
    assert result.conflicts and result.proposals_remaining == 1
    assert row.bundle_id == original_bundle
    assert target.notes == ["Settled annotation"]


# Startup intentionally discards all unconfirmed plans while committed acceptance remains replayable
def test_startup_discard_keeps_committed_acceptance(
    client, library_id, session, library_root, monkeypatch
):
    import json
    from dataclasses import asdict

    from cairndex.core.config import get_settings
    from cairndex.grouping import apply as grouping_apply
    from cairndex.grouping.plan_store import get_plan
    from cairndex.metadata.schema import ensure_metadata_schema
    from cairndex.metadata.session import begin_edit, save_receipt
    from cairndex.persistence.engine import discard_all_plans, ensure_plans_schema
    from cairndex.persistence.models import GroupingPlan

    url, plan, selected, headers = _review(client, library_id, session, library_root)
    body = json.dumps({"proposal_ids": [selected["id"]]}, separators=(",", ":")).encode()
    session.close()
    _, digest = begin_edit(
        session,
        basis=headers["X-Cairndex-Basis"],
        operation=headers["X-Cairndex-Operation"],
        review=None,
        method="POST",
        path=url + "/apply?",
        body=body,
    )
    result = grouping_apply.apply_plan(
        session, get_plan(session, plan["id"]), proposal_ids={selected["id"]}, defer_settlement=True
    )
    save_receipt(
        session, headers["X-Cairndex-Operation"], digest, 200, json.dumps(asdict(result)).encode()
    )
    session.commit()
    session.close()
    engine = session.get_bind()
    engine.dispose()
    # Isolate the real startup discard function to this test's own plan file
    settings = get_settings()
    from cairndex.persistence.engine import plans_database_path

    path = plans_database_path(library_root / ".cairndex" / "library.db")
    original_glob = Path.glob

    def only_this_plan(directory, pattern):
        return (
            iter([path])
            if directory == settings.data_dir / "plans"
            else original_glob(directory, pattern)
        )

    with monkeypatch.context() as patch:
        patch.setattr(Path, "glob", only_this_plan)
        assert discard_all_plans() == 1
    ensure_plans_schema(engine)
    ensure_metadata_schema(engine)
    retry = client.post(url + "/apply", json={"proposal_ids": [selected["id"]]}, headers=headers)
    assert retry.status_code == 200 and retry.json()["bundles_confirmed"] == 1
    assert client.get(url).status_code == 404
    assert not list(session.scalars(select(GroupingPlan)))
    assert (
        len(
            list(
                session.scalars(
                    select(AssetBundle).where(AssetBundle.grouping_state == GroupingState.CONFIRMED)
                )
            )
        )
        == 1
    )


# Existing exact response receipts survive the additive recovery-field upgrade byte for byte
def test_receipt_schema_upgrade_preserves_existing_response(engine):
    from cairndex.metadata.schema import ensure_metadata_schema

    with engine.begin() as db:
        db.exec_driver_sql("DROP INDEX ix_metadata_pending_grouping")
        db.exec_driver_sql("ALTER TABLE metadata_receipts DROP COLUMN grouping_settlement")
        db.exec_driver_sql(
            "INSERT INTO metadata_receipts "
            "VALUES ('synthetic-operation', 'digest', 200, ?, 'basis')",
            (b'{"bundles_confirmed":1}',),
        )
    ensure_metadata_schema(engine)
    with engine.connect() as db:
        row = db.exec_driver_sql(
            "SELECT body, basis, grouping_settlement FROM metadata_receipts"
        ).one()
        assert tuple(row) == (b'{"bundles_confirmed":1}', "basis", None)
        assert not db.exec_driver_sql("PRAGMA foreign_key_check").all()
