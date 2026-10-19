"""Retire accepted sources and advance remaining bases only through that exact accepted event."""

import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.grouping import roles, storage
from cairndex.replicas.protocol import ReplicaError

BATCH = 32


def tips(
    db: sqlite3.Connection, units: set[str], event: str
) -> tuple[dict[str, list[str]], set[str]]:
    current: dict[str, list[str]] = {unit: [] for unit in units}
    safe = set(units)
    if not units:
        return current, safe
    for row in db.execute(
        "WITH RECURSIVE accepted(event) AS (SELECT ? UNION SELECT p.parent "
        "FROM catalog_parents p JOIN accepted a ON p.child=a.event) "
        "SELECT r.unit,r.event,a.event IS NOT NULL AS observed FROM catalog_revisions r "
        "LEFT JOIN accepted a ON a.event=r.event WHERE r.active=1 "
        "AND r.unit IN (SELECT value FROM json_each(?)) ORDER BY r.unit,r.event",
        (event, value_text(sorted(units))),
    ):
        current[row["unit"]].append(row["event"])
        if not row["observed"]:
            safe.discard(row["unit"])
    return current, safe


def files(db: sqlite3.Connection, work: sqlite3.Row, review: sqlite3.Row) -> bool:
    rows = db.execute(
        "SELECT * FROM grouping_files WHERE workspace=? AND id>? ORDER BY id LIMIT ?",
        (work["id"], work["cursor"], BATCH),
    ).fetchall()
    bodies = {row["id"]: json.loads(row["body"]) for row in rows}
    units = {unit for body in bodies.values() for unit in body.get("staged", {}).get("bases", {})}
    current, safe = tips(db, units, review["event"])
    for row in rows:
        body = bodies[row["id"]]
        accepted = db.execute(
            "SELECT f.original FROM discovery_review_files f WHERE f.operation=? "
            "AND json_extract(f.original,'$.id')=?",
            (review["id"], row["id"]),
        ).fetchone()
        if accepted:
            original = json.loads(accepted[0])
            receipt = db.execute(
                "SELECT 1 FROM discovery_accepted_files WHERE path=? AND generation=? AND event=?",
                (row["path"], body["generation"], review["event"]),
            ).fetchone()
            if receipt and all(original[name] == body[name] for name in ("path", "generation")):
                db.execute(
                    "DELETE FROM grouping_files WHERE workspace=? AND id=?", (work["id"], row["id"])
                )
                continue
        if not body.get("staged"):
            continue
        bases = body["staged"]["bases"]
        if any(unit not in safe and bases[unit] != current[unit] for unit in bases):
            db.execute(
                "UPDATE grouping_workspaces SET error=? WHERE id=?",
                (
                    "Newer catalog edits are retained; run Update before preparing remaining files",
                    work["id"],
                ),
            )
            continue
        body["staged"]["bases"] = {unit: current[unit] for unit in bases}
        raw = value_text(body)
        if raw != row["body"]:
            db.execute(
                "UPDATE grouping_files SET body=? WHERE workspace=? AND id=?",
                (raw, work["id"], row["id"]),
            )
    db.execute(
        "UPDATE grouping_workspaces SET cursor=? WHERE id=?",
        (rows[-1]["id"] if rows else "", work["id"]),
    )
    return not rows


def nodes(db: sqlite3.Connection, work: sqlite3.Row, review: sqlite3.Row) -> bool:
    rows = db.execute(
        "SELECT n.*,g.target AS accepted_target,g.body AS accepted_body FROM grouping_nodes n "
        "JOIN discovery_review_groups g ON g.operation=? AND g.id=n.id "
        "WHERE n.workspace=? AND n.id>? ORDER BY n.id LIMIT ?",
        (review["id"], work["id"], work["cursor"], BATCH),
    ).fetchall()
    for row in rows:
        if not db.execute(
            "SELECT 1 FROM grouping_files WHERE workspace=? AND node=? LIMIT 1",
            (work["id"], row["id"]),
        ).fetchone():
            continue
        target = row["accepted_target"]
        title = json.loads(row["accepted_body"])["title"]
        db.execute(
            "UPDATE grouping_nodes SET target=?,original_target=?,target_title=?,roles_dirty=1,"
            "role_cursor=-1,role_context=NULL WHERE workspace=? AND id=?",
            (target, target, title, work["id"], row["id"]),
        )
    db.execute(
        "UPDATE grouping_workspaces SET cursor=? WHERE id=?",
        (rows[-1]["id"] if rows else "", work["id"]),
    )
    return not rows


def step(db: sqlite3.Connection) -> bool:
    work = db.execute(
        "SELECT w.* FROM grouping_workspaces w JOIN discovery_reviews r ON r.id=w.accepting "
        "WHERE w.accepting IS NOT NULL AND r.state='applied' ORDER BY w.rowid LIMIT 1"
    ).fetchone()
    if not work:
        return False
    review = db.execute(
        "SELECT * FROM discovery_reviews WHERE id=?", (work["accepting"],)
    ).fetchone()
    candidate = db.execute(
        "SELECT body FROM discovery_candidates WHERE id=?",
        (json.loads(review["intent"])["candidate"],),
    ).fetchone()
    if not candidate or json.loads(candidate[0]).get("workspace") != work["id"]:
        raise ReplicaError("The applied review does not belong to this grouping draft")
    if work["phase"] == "ready":
        db.execute(
            "UPDATE grouping_workspaces SET state='editing',phase='accepted_files',cursor='' "
            "WHERE id=?",
            (work["id"],),
        )
    elif work["phase"] == "accepted_files":
        if files(db, work, review):
            db.execute(
                "UPDATE grouping_workspaces SET phase='accepted_nodes' WHERE id=?", (work["id"],)
            )
    elif work["phase"] == "accepted_nodes":
        if nodes(db, work, review):
            db.execute(
                "UPDATE grouping_workspaces SET phase='accepted_roles' WHERE id=?", (work["id"],)
            )
    elif work["phase"] == "accepted_roles":
        if roles.step(db, work["id"]):
            storage.refresh_counts(db, work["id"])
            db.execute(
                "UPDATE grouping_workspaces SET state='ready',phase='ready',cursor='',"
                "accepting=NULL,"
                "revision=revision+1 WHERE id=?",
                (work["id"],),
            )
    else:
        raise ReplicaError("The accepted grouping draft has an unsupported reconciliation phase")
    return True


def cancel(db: sqlite3.Connection, workspace: sqlite3.Row, intent: dict[str, Any]) -> None:
    if not workspace["accepting"] or intent.get("review") != workspace["accepting"]:
        raise ReplicaError("Choose the prepared review belonging to this grouping draft")
    review = db.execute(
        "SELECT state FROM discovery_reviews WHERE id=?", (workspace["accepting"],)
    ).fetchone()
    if not review or review[0] in {"apply_queued", "applied"}:
        raise ReplicaError("Wait for accepted changes before editing their grouping")
    db.execute(
        "UPDATE discovery_reviews SET state='cancelled' WHERE id=?", (workspace["accepting"],)
    )
    db.execute("UPDATE grouping_workspaces SET accepting=NULL WHERE id=?", (workspace["id"],))
