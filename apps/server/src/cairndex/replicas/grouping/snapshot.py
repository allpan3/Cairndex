"""Export edited selection into the existing immutable, guarded discovery review model."""

import hashlib
import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.protocol import ReplicaError, checksum

BATCH = 32
MEMBERS = (
    "SELECT f.*,n.directory AS group_directory FROM grouping_nodes n JOIN grouping_files f "
    "ON f.workspace=n.workspace AND f.node=n.id WHERE n.workspace=? AND f.selected=1 "
)
GROUPS = (
    "SELECT n.* FROM grouping_nodes n WHERE n.workspace=? AND n.kind='bundle' AND EXISTS "
    "(SELECT 1 FROM grouping_files f WHERE f.workspace=n.workspace AND f.node=n.id "
    "AND f.selected=1) "
    "ORDER BY n.directory,n.id"
)


def group_body(db: sqlite3.Connection, workspace: str, node: sqlite3.Row) -> dict[str, Any]:
    ancestors = []
    seen: set[str] = set()
    parent = node["parent"]
    while parent:
        if parent in seen:
            raise ReplicaError("The grouping draft contains a cycle; retain it for review")
        seen.add(parent)
        row = db.execute(
            "SELECT * FROM grouping_nodes WHERE workspace=? AND id=?",
            (workspace, parent),
        ).fetchone()
        if not row:
            raise ReplicaError("A grouping ancestor is missing; retain the draft for review")
        ancestors.append(
            {
                "id": row["id"],
                "directory": row["directory"],
                "title": row["title"],
                "collection": row["collection"],
                "editable": not bool(row["context"]),
                "basis": json.loads(row["collection_basis"]) if row["collection_basis"] else {},
            }
        )
        parent = row["parent"]
    return {
        "id": node["id"],
        "title": node["title"],
        "target": node["target"],
        "directory": node["directory"],
        "ancestors": list(reversed(ancestors)),
        "folders": [
            row[0]
            for row in db.execute(
                "SELECT path FROM grouping_folders WHERE workspace=? AND node=? "
                "AND expanded=0 ORDER BY path",
                (workspace, node["id"]),
            )
        ],
    }


def source(row: sqlite3.Row) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(row["body"])
    return body | {"role": row["role"], "sequence": row["sequence"]}


def begin(db: sqlite3.Connection, command: sqlite3.Row) -> None:
    workspace = command["workspace"]
    digest, count, first = hashlib.sha256(), 0, ""
    for row in db.execute(MEMBERS + "ORDER BY n.directory,n.id,f.sequence,f.id", (workspace,)):
        digest.update(value_text([row["node"], source(row)]).encode() + b"\n")
        first = first or row["path"]
        count += 1
    if not count:
        raise ReplicaError("Choose at least one file to accept")
    groups = hashlib.sha256()
    for node in db.execute(GROUPS, (workspace,)):
        groups.update(value_text(group_body(db, workspace, node)).encode() + b"\n")
    header = {
        "version": 2,
        "kind": "collection",
        "files": [],
        "file_count": count,
        "files_digest": digest.hexdigest(),
        "groups_digest": groups.hexdigest(),
        "title": "Grouping suggestions",
        "target": None,
        "directory": "",
        "reason": "Review the selected grouping changes",
        "workspace": workspace,
    }
    candidate = checksum(value_text(header).encode())
    prior = db.execute("SELECT state FROM discovery_candidates WHERE id=?", (candidate,)).fetchone()
    if prior and prior["state"] in {"accepted", "superseded"}:
        raise ReplicaError("This selection has already changed; review the current grouping draft")
    db.execute(
        "INSERT OR IGNORE INTO discovery_candidates VALUES (?,?,?,?,'building')",
        (candidate, workspace, first, value_text(header)),
    )
    for node in db.execute(GROUPS, (workspace,)):
        db.execute(
            "INSERT OR IGNORE INTO discovery_candidate_groups VALUES (?,?,?)",
            (candidate, node["id"], value_text(group_body(db, workspace, node))),
        )
    db.execute(
        "UPDATE grouping_commands SET state='running',phase='export',cursor='',result=? WHERE id=?",
        (
            value_text(
                {
                    "candidate": candidate,
                    "position": 0,
                    "verify": bool(json.loads(command["intent"]).get("verify_content")),
                }
            ),
            command["id"],
        ),
    )
    db.execute(
        "UPDATE grouping_workspaces SET state='editing',phase='export' WHERE id=?",
        (workspace,),
    )


def step(db: sqlite3.Connection, command: sqlite3.Row) -> None:
    workspace = command["workspace"]
    result = json.loads(command["result"])
    if command["phase"] == "verification":
        verification = db.execute(
            "SELECT state FROM discovery_verifications WHERE id=?",
            (command["id"],),
        ).fetchone()
        if verification and verification[0] in {"queued", "running"}:
            return
        if not verification or verification[0] != "succeeded":
            raise ReplicaError("Content verification stopped; your grouping draft is retained")
        queue_review(db, command, result["candidate"], verification=command["id"])
        return
    last = json.loads(command["cursor"]) if command["cursor"] else None
    continuation = "AND (n.directory,n.id,f.sequence,f.id)>(?,?,?,?) " if last else ""
    rows = db.execute(
        MEMBERS + continuation + "ORDER BY n.directory,n.id,f.sequence,f.id LIMIT ?",
        (workspace, *(last or []), BATCH),
    ).fetchall()
    for position, row in enumerate(rows, start=result["position"]):
        db.execute(
            "INSERT OR IGNORE INTO discovery_candidate_files VALUES (?,?,?,?)",
            (result["candidate"], position, row["node"], value_text(source(row))),
        )
    if rows:
        last_row = rows[-1]
        result["position"] += len(rows)
        db.execute(
            "UPDATE grouping_commands SET cursor=?,result=? WHERE id=?",
            (
                value_text(
                    [
                        last_row["group_directory"],
                        last_row["node"],
                        last_row["sequence"],
                        last_row["id"],
                    ]
                ),
                value_text(result),
                command["id"],
            ),
        )
        return
    candidate = result["candidate"]
    db.execute(
        "UPDATE discovery_candidates SET state='pending' WHERE id=? AND state='building'",
        (candidate,),
    )
    if result["verify"]:
        from cairndex.replicas.discovery_verification import enqueue_in

        enqueue_in(db, command["id"], candidate)
        result["verification"] = command["id"]
        db.execute(
            "UPDATE grouping_commands SET phase='verification',result=? WHERE id=?",
            (value_text(result), command["id"]),
        )
        db.execute("UPDATE grouping_workspaces SET phase='verification' WHERE id=?", (workspace,))
        return
    queue_review(db, command, candidate)


def queue_review(
    db: sqlite3.Connection, command: sqlite3.Row, candidate: str, *, verification: str | None = None
) -> None:
    intent = value_text(
        {"candidate": candidate, **({"verification": verification} if verification else {})}
    )
    previous = db.execute(
        "SELECT intent FROM discovery_reviews WHERE id=?", (command["id"],)
    ).fetchone()
    if previous and previous[0] != intent:
        raise ReplicaError("Review retry identity was reused for different work")
    db.execute(
        "INSERT OR IGNORE INTO discovery_reviews VALUES (?,?,'queued',NULL,NULL,NULL)",
        (command["id"], intent),
    )
    db.execute(
        "UPDATE grouping_workspaces SET state='ready',phase='ready',accepting=? WHERE id=?",
        (command["id"], command["workspace"]),
    )
    db.execute(
        "UPDATE grouping_commands SET state='succeeded',phase='done',result=? WHERE id=?",
        (value_text({"candidate": candidate, "review": command["id"]}), command["id"]),
    )
