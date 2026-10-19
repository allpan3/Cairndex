"""Preserve catalog identities when reviewing still-unconfirmed files."""

import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_preview import DiscoveryPreview
from cairndex.replicas.protocol import ReplicaError


def capture(
    store: CatalogStore,
    db: sqlite3.Connection,
    file: dict[str, Any],
    bundle: dict[str, Any],
    observation: dict[str, Any],
) -> dict[str, Any]:
    units = [
        key("asset_files", file["id"], field) for field in ("$alive", "relative_path", "$content")
    ] + [
        key("asset_bundles", bundle["id"], field)
        for field in ("$alive", "$members", "grouping_state")
    ]
    return observation | {
        "id": file["id"],
        "staged": {
            "bundle": bundle["id"],
            "bases": {unit: [tip["event"] for tip in store.tips(db, unit)] for unit in units},
        },
    }


def validate(builder: DiscoveryPreview, file: dict[str, Any]) -> None:
    staged = file["staged"]
    row = read_row(builder.db, "asset_files", file["id"])
    bundle = read_row(builder.db, "asset_bundles", staged["bundle"])
    if (
        not row
        or row["relative_path"] != file["path"]
        or row["bundle_id"] != staged["bundle"]
        or not bundle
        or bundle["grouping_state"] == "CONFIRMED"
        or any(
            set(bases) != {tip["event"] for tip in builder.store.tips(builder.db, unit)}
            for unit, bases in staged["bases"].items()
        )
    ):
        raise ReplicaError("An Unbundled identity changed; run Update and review again")
    for unit in staged["bases"]:
        # Freeze these opening choices through the final guarded catalog save.
        if unit.endswith("/$content") and not staged["bases"][unit]:
            continue
        builder.get(unit)


def reusable(builder: DiscoveryPreview, group: str) -> str | None:
    """Reuse one complete provisional source without confirming unselected files."""
    db, operation = builder.db, builder.operation
    for (source,) in db.execute(
        "SELECT DISTINCT json_extract(body,'$.staged.bundle') FROM discovery_review_files "
        "WHERE operation=? AND group_id=? AND json_type(body,'$.staged') IS NOT NULL "
        "ORDER BY json_extract(body,'$.staged.bundle')",
        (operation, group),
    ):
        if db.execute(
            "SELECT 1 FROM discovery_review_groups WHERE operation=? AND target=?",
            (operation, source),
        ).fetchone():
            continue
        if db.execute(
            "SELECT 1 FROM catalog_rows f WHERE f.family='asset_files' "
            "AND json_extract(f.body,'$.bundle_id')=? AND NOT EXISTS "
            "(SELECT 1 FROM discovery_review_files r WHERE r.operation=? AND r.group_id=? "
            "AND json_extract(r.body,'$.id')=f.entity) LIMIT 1",
            (source, operation, group),
        ).fetchone():
            continue
        return str(source)
    return None


def transfer(builder: DiscoveryPreview, file: dict[str, Any], target: str, sequence: int) -> None:
    validate(builder, file)
    source = file["staged"]["bundle"]
    builder.members(source)
    builder.members(target)
    builder.db.execute(
        "DELETE FROM discovery_review_members WHERE operation=? AND bundle=? "
        "AND family='asset_files' AND id=?",
        (builder.operation, source, file["id"]),
    )
    member = {"family": "asset_files", "id": file["id"], "role": file["role"], "sequence": sequence}
    builder.db.execute(
        "INSERT INTO discovery_review_members VALUES (?,?,?,?,?,?)",
        (builder.operation, target, "asset_files", file["id"], value_text(member), sequence),
    )
    if source != target:
        for field in ("cover_file_id", "primary_file_id"):
            unit = key("asset_bundles", source, field)
            if builder.get(unit) == file["id"]:
                builder.put(unit, None)


def dependents(builder: DiscoveryPreview, cursor: int) -> bool:
    """Move at most 32 dependent rows, keeping linked subtitle files together."""
    db, operation = builder.db, builder.operation
    rows = db.execute(
        "SELECT DISTINCT r.rowid,r.* FROM discovery_review_files f "
        "JOIN catalog_references ref ON ref.target='asset_files/'||json_extract(f.body,'$.id') "
        "JOIN catalog_rows r ON ref.source=r.family||'/'||r.entity "
        "WHERE f.operation=? AND json_type(f.body,'$.staged') IS NOT NULL "
        "AND r.family IN ('moments','subtitle_tracks') AND r.rowid>? ORDER BY r.rowid LIMIT 32",
        (operation, cursor),
    ).fetchall()
    for row in rows:
        body = json.loads(row["body"])
        fields = ("file_id",) if row["family"] == "moments" else ("video_file_id", "source_file_id")
        targets = set()
        for field in fields:
            if not body[field]:
                continue
            member = db.execute(
                "SELECT bundle FROM discovery_review_members WHERE operation=? "
                "AND family='asset_files' AND id=?",
                (operation, body[field]),
            ).fetchone()
            targets.add(member[0] if member else body["bundle_id"])
        if len(targets) != 1:
            raise ReplicaError("Keep the video and subtitle files of an existing track together")
        body["bundle_id"] = targets.pop()
        builder.row(row["family"], body)
    db.execute(
        "UPDATE discovery_review_work SET cursor=? WHERE operation=?",
        (rows[-1]["rowid"] if rows else -1, operation),
    )
    return not rows


def cleanup(builder: DiscoveryPreview, cursor: int) -> bool:
    """Retire empty staging sources only after their dependent rows have moved."""
    db, operation = builder.db, builder.operation
    rows = db.execute(
        "SELECT a.rowid,b.entity AS bundle FROM discovery_review_arrangements a "
        "JOIN catalog_rows b ON b.family='asset_bundles' "
        "AND a.unit='asset_bundles/'||b.entity||'/$members' "
        "WHERE a.operation=? AND a.rowid>? ORDER BY a.rowid LIMIT 32",
        (operation, cursor),
    ).fetchall()
    for row in rows:
        source = read_row(db, "asset_bundles", row["bundle"])
        if not source or source["grouping_state"] == "CONFIRMED":
            continue
        if db.execute(
            "SELECT 1 FROM discovery_review_members WHERE operation=? AND bundle=? LIMIT 1",
            (operation, row["bundle"]),
        ).fetchone():
            continue
        if (
            json.loads(source["notes"] or "[]")
            or source["rating"] is not None
            or json.loads(source["extra_metadata"] or "{}")
        ) or db.execute(
            "SELECT 1 FROM catalog_references WHERE target=? AND "
            "(source LIKE 'asset_bundle_tags/%' OR source LIKE 'asset_bundle_collections/%' "
            "OR source LIKE 'collections/%') LIMIT 1",
            ("asset_bundles/" + row["bundle"],),
        ).fetchone():
            raise ReplicaError(
                "Keep source bundles with metadata or memberships in a separate grouping"
            )
        builder.put(key("asset_bundles", row["bundle"], "$members"), [])
        builder.put(key("asset_bundles", row["bundle"], "$alive"), False)
        # As in Preview.delete, a tombstone retains fields in history rather
        # than submitting scalar edits to the entity it removes. Its frozen
        # lifetime basis still fences intervening metadata edits.
        db.execute(
            "DELETE FROM discovery_review_values WHERE operation=? AND unit>=? AND unit<? "
            "AND unit NOT IN (?,?)",
            (
                operation,
                f"asset_bundles/{row['bundle']}/",
                f"asset_bundles/{row['bundle']}0",
                key("asset_bundles", row["bundle"], "$members"),
                key("asset_bundles", row["bundle"], "$alive"),
            ),
        )
    db.execute(
        "UPDATE discovery_review_work SET cursor=? WHERE operation=?",
        (rows[-1]["rowid"] if rows else -1, operation),
    )
    return not rows
