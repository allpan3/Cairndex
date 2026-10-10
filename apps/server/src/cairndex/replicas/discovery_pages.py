"""Paged immutable source, collection and prepared metadata inspection"""

import json
import sqlite3
from typing import Any

from cairndex.replicas.protocol import ReplicaError


# Review pages expose every selected source or staged value without materializing the entire review
def review_page(
    db: sqlite3.Connection, operation: str, kind: str, after: int = -1, limit: int = 50
) -> dict[str, Any]:
    if kind not in ("files", "changes", "groups"):
        raise ReplicaError("Unsupported discovery review page")
    table = {
        "files": "discovery_review_files",
        "changes": "discovery_review_values",
        "groups": "discovery_review_groups",
    }[kind]
    order = "sort_order" if kind == "files" else "rowid"
    rows = db.execute(
        f"SELECT {order} AS ordinal,* FROM {table} WHERE operation=? AND {order}>? "
        f"ORDER BY {order} LIMIT ?",
        (operation, after, limit + 1),
    ).fetchall()
    items = []
    for row in rows[:limit]:
        if kind == "changes":
            items.append(
                {
                    "unit": row["unit"],
                    "value": row["value"],
                    "basis": json.loads(row["basis"]),
                    "cohort": row["cohort"],
                }
            )
        else:
            items.append(
                json.loads(row["body"] or row["original"])
                | ({"target": row["target"]} if kind == "groups" else {})
            )
    return {
        "items": items,
        "next_cursor": rows[limit - 1]["ordinal"] if len(rows) > limit else None,
        "total": db.execute(
            f"SELECT COUNT(*) FROM {table} WHERE operation=?", (operation,)
        ).fetchone()[0],
    }


# Saved review lists carry a compact first page and durable phase progress
def display_review(db: sqlite3.Connection, review: dict[str, Any]) -> dict[str, Any]:
    work = db.execute(
        "SELECT phase,total,progress FROM discovery_review_work WHERE operation=?", (review["id"],)
    ).fetchone()
    if work:
        review["progress"] = dict(work)
    prepared = review["prepared"]
    if prepared and prepared.get("version") == 2:
        files = review_page(db, review["id"], "files")
        changes = review_page(db, review["id"], "changes")
        groups = review_page(db, review["id"], "groups")
        review["prepared"] = prepared | {
            "files": files["items"],
            "files_next": files["next_cursor"],
            "groups": groups["items"],
            "groups_next": groups["next_cursor"],
            "catalog": prepared["catalog"]
            | {"changes": changes["items"], "next_cursor": changes["next_cursor"]},
        }
    return review


# Collection descendants carry their complete required ancestors and support stable cursor paging
def groups(
    db: sqlite3.Connection, candidate: str, after: str = "", limit: int = 50
) -> dict[str, Any]:
    rows = db.execute(
        "SELECT * FROM discovery_candidate_groups WHERE candidate=? AND id>? ORDER BY id LIMIT ?",
        (candidate, after, limit + 1),
    ).fetchall()
    return {
        "items": [json.loads(row["body"]) for row in rows[:limit]],
        "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        "total": db.execute(
            "SELECT COUNT(*) FROM discovery_candidate_groups WHERE candidate=?", (candidate,)
        ).fetchone()[0],
    }
