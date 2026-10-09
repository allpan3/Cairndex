"""Metadata-only ordering deltas over complete selected source membership"""

import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.protocol import ReplicaError


# Moves apply to original candidate identities; later full verification may assign portable IDs
def reorder(db: sqlite3.Connection, operation: str, intent: dict[str, Any]) -> None:
    if intent.get("files"):
        db.execute(
            "UPDATE discovery_review_files SET sort_order=(SELECT CAST(key AS INTEGER) "
            "FROM json_each(?) WHERE value=json_extract(original,'$.id')) WHERE operation=?",
            (value_text(intent["files"]), operation),
        )
    for move in intent.get("moves", []):
        rows = [
            db.execute(
                "SELECT position,sort_order,group_id FROM discovery_review_files "
                "WHERE operation=? AND json_extract(original,'$.id')=?",
                (operation, move[name]),
            ).fetchone()
            for name in ("file", "before")
        ]
        if any(row is None for row in rows):
            raise ReplicaError("Reordered files must both remain selected")
        source, target = rows
        if source["group_id"] != target["group_id"]:
            raise ReplicaError("File order changes must stay within one proposed bundle")
        old, new = source["sort_order"], target["sort_order"]
        if old == new:
            continue
        if old < new:
            db.execute(
                "UPDATE discovery_review_files SET sort_order=sort_order-1 "
                "WHERE operation=? AND sort_order>? AND sort_order<?",
                (operation, old, new),
            )
            new -= 1
        else:
            db.execute(
                "UPDATE discovery_review_files SET sort_order=sort_order+1 "
                "WHERE operation=? AND sort_order>=? AND sort_order<?",
                (operation, new, old),
            )
        db.execute(
            "UPDATE discovery_review_files SET sort_order=? WHERE operation=? AND position=?",
            (new, operation, source["position"]),
        )
