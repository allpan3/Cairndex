"""Build an editable draft from one completed planner without reading source files."""

import json
import sqlite3
from typing import Any

from cairndex.grouping import suggester as rules
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.grouping.storage import refresh_counts

BATCH = 32


def parent(db: sqlite3.Connection, workspace: str, group: sqlite3.Row) -> str | None:
    directory = group["parent"]
    while directory is not None:
        row = db.execute(
            "SELECT id FROM discovery_plan_groups WHERE run=? AND directory=? "
            "AND kind='container' AND id<>?",
            (workspace, directory, group["id"]),
        ).fetchone()
        if row:
            return str(row[0])
        directory = directory.rpartition("/")[0] if directory else None
    return None


def reason(db: sqlite3.Connection, workspace: str, group: sqlite3.Row) -> tuple[float, str]:
    stats = db.execute(
        "SELECT count(*) AS files,coalesce(sum(kind='video'),0) AS videos,"
        "count(DISTINCT CASE WHEN kind='video' THEN part END) AS parts,"
        "coalesce(sum(kind='video' AND part IS NULL),0) AS no_part,"
        "coalesce(sum(directory=?),0) AS direct "
        "FROM grouping_files WHERE workspace=? AND node=?",
        (group["directory"], workspace, group["id"]),
    ).fetchone()
    if group["kind"] == "container":
        children = db.execute(
            "SELECT count(*) FROM grouping_nodes WHERE workspace=? AND parent=?",
            (workspace, group["id"]),
        ).fetchone()[0]
        return (0.85 if children > 1 else 0.6), ""
    if group["target"]:
        return 0.8, f"add {stats['files']} new file(s) to existing bundle"
    folders = db.execute(
        "SELECT count(*) FROM grouping_folders WHERE workspace=? AND node=?",
        (workspace, group["id"]),
    ).fetchone()[0]
    if db.execute(
        "SELECT 1 FROM grouping_folders WHERE workspace=? AND node=? AND path=?",
        (workspace, group["id"], group["directory"]),
    ).fetchone():
        return 0.5, f"{stats['files']} files in one folder, kept as a folder"
    if folders:
        return 0.5, (
            f"{stats['direct']} file(s) and {folders} folder(s) in one place"
            if folders > 1
            else f"{stats['direct']} file(s) and a folder of {stats['files'] - stats['direct']}"
        )
    multipart = stats["videos"] >= 2 and stats["parts"] == 1 and not stats["no_part"]
    level = db.execute(
        "SELECT level FROM grouping_stems WHERE workspace=? AND directory=?",
        (workspace, group["directory"]),
    ).fetchone()
    if level and level[0] > 1 and stats["videos"] > 1 and not multipart:
        return 0.55, f"{stats['files']} files matched by a widened stem"
    return rules._bundle_reason_counts(stats["files"], stats["videos"], multipart)


def nodes(db: sqlite3.Connection, workspace: str, cursor: str) -> None:
    rows = db.execute(
        "SELECT rowid,* FROM discovery_plan_groups WHERE run=? AND id>? ORDER BY id LIMIT ?",
        (workspace, cursor, BATCH),
    ).fetchall()
    for row in rows:
        owner = (
            db.execute(
                "SELECT owner_title FROM discovery_plan_files WHERE run=? AND owner=? LIMIT 1",
                (workspace, row["target"]),
            ).fetchone()
            if row["target"]
            else None
        )
        db.execute(
            "INSERT INTO grouping_nodes(workspace,id,parent,kind,title,directory,target,"
            "original_target,target_title,position,confidence,reason) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                workspace,
                row["id"],
                parent(db, workspace, row),
                row["kind"],
                row["title"],
                row["directory"],
                row["target"],
                row["target"],
                owner[0] if owner else None,
                row["rowid"],
                0.5,
                "",
            ),
        )
    db.execute(
        "UPDATE grouping_workspaces SET phase=?,cursor=? WHERE id=?",
        ("nodes" if rows else "files", rows[-1]["id"] if rows else "", workspace),
    )


def eligible(db: sqlite3.Connection, body: dict[str, Any]) -> bool:
    if body.get("staged"):
        file = read_row(db, "asset_files", body["id"])
        bundle = read_row(db, "asset_bundles", file["bundle_id"]) if file else None
        return bool(bundle and bundle["grouping_state"] != "CONFIRMED")
    return not db.execute(
        "SELECT 1 FROM discovery_accepted_files WHERE path=? AND generation=?",
        (body["path"], body["generation"]),
    ).fetchone()


def files(db: sqlite3.Connection, workspace: str, cursor: str) -> None:
    rows = db.execute(
        "SELECT * FROM discovery_plan_files WHERE run=? AND path>? AND owner IS NULL "
        "AND proposal IS NOT NULL ORDER BY path LIMIT ?",
        (workspace, cursor, BATCH),
    ).fetchall()
    for row in rows:
        body = json.loads(row["body"])
        if not eligible(db, body):
            continue
        db.execute(
            "INSERT INTO grouping_files(workspace,id,path,directory,node,body,kind,part,role,"
            "sequence) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                workspace,
                row["file_id"],
                row["path"],
                row["directory"],
                row["proposal"],
                row["body"],
                row["kind"],
                row["part"],
                row["role"],
                row["sequence"],
            ),
        )
        maximum = rules.max_stem_level([row["path"]])
        db.execute(
            "INSERT INTO grouping_stems VALUES (?,?,1,?,?) "
            "ON CONFLICT(workspace,directory) DO UPDATE SET "
            "maximum=max(maximum,excluded.maximum),example=min(example,excluded.example)",
            (workspace, row["directory"], maximum, row["path"]),
        )
    db.execute(
        "UPDATE grouping_workspaces SET phase=?,cursor=? WHERE id=?",
        ("files" if rows else "folders", rows[-1]["path"] if rows else "", workspace),
    )


def folders(db: sqlite3.Connection, workspace: str, cursor: str) -> None:
    rows = db.execute(
        "SELECT * FROM discovery_plan_folders WHERE run=? AND path>? ORDER BY path LIMIT ?",
        (workspace, cursor, BATCH),
    ).fetchall()
    for row in rows:
        db.execute(
            "INSERT OR IGNORE INTO grouping_folders VALUES (?,?,?,0)",
            (workspace, row["path"], row["proposal"]),
        )
    if rows:
        db.execute(
            "UPDATE grouping_workspaces SET cursor=? WHERE id=?", (rows[-1]["path"], workspace)
        )
        return
    db.execute("UPDATE grouping_workspaces SET phase='reasons',cursor='' WHERE id=?", (workspace,))


def reasons(db: sqlite3.Connection, workspace: str, cursor: str) -> None:
    rows = db.execute(
        "SELECT * FROM grouping_nodes WHERE workspace=? AND id>? ORDER BY id LIMIT ?",
        (workspace, cursor, BATCH),
    ).fetchall()
    for row in rows:
        confidence, why = reason(db, workspace, row)
        db.execute(
            "UPDATE grouping_nodes SET confidence=?,reason=? WHERE workspace=? AND id=?",
            (confidence, why, workspace, row["id"]),
        )
    if rows:
        db.execute(
            "UPDATE grouping_workspaces SET cursor=? WHERE id=?", (rows[-1]["id"], workspace)
        )
        return
    refresh_counts(db, workspace)
    db.execute(
        "UPDATE grouping_workspaces SET state='ready',phase='ready',cursor='',revision=1 "
        "WHERE id=?",
        (workspace,),
    )


def step(db: sqlite3.Connection, workspace: str) -> None:
    work = db.execute(
        "SELECT phase,cursor FROM grouping_workspaces WHERE id=?", (workspace,)
    ).fetchone()
    {"nodes": nodes, "files": files, "folders": folders, "reasons": reasons}[work["phase"]](
        db, workspace, work["cursor"]
    )
