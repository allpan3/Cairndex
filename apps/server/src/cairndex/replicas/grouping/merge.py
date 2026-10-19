"""Collapse a proposed collection while preserving private identities and folder choices."""

import sqlite3
from typing import Any

from cairndex.replicas.discovery_plan import natural
from cairndex.replicas.grouping.edits import node
from cairndex.replicas.protocol import ReplicaError

BRANCH = (
    "WITH RECURSIVE branch(id) AS (SELECT ? UNION ALL SELECT n.id FROM grouping_nodes n "
    "JOIN branch b ON n.parent=b.id WHERE n.workspace=?) "
)


def apply(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    row = node(db, workspace, intent["node"])
    if row["kind"] != "container" or intent["kind"] != "bundle":
        raise ReplicaError("Choose a collection suggestion to merge into a bundle")
    if db.execute(
        BRANCH + "SELECT 1 FROM grouping_nodes WHERE workspace=? AND id IN (SELECT id FROM branch) "
        "AND (target IS NOT NULL OR context=1) LIMIT 1",
        (row["id"], workspace, workspace),
    ).fetchone():
        raise ReplicaError(
            "A collection with existing bundle additions or collection context cannot merge"
        )
    db.create_function("grouping_natural", 1, natural)
    db.execute(
        BRANCH
        + "UPDATE grouping_files SET node=? WHERE workspace=? AND node IN (SELECT id FROM branch)",
        (row["id"], workspace, row["id"], workspace),
    )
    db.execute(
        "WITH ordered AS (SELECT id,row_number() OVER (ORDER BY CASE kind WHEN 'video' THEN 0 "
        "WHEN 'audio' THEN 1 WHEN 'image' THEN 2 ELSE 3 END,grouping_natural(path),path)-1 AS n "
        "FROM grouping_files WHERE workspace=? AND node=?) UPDATE grouping_files "
        "SET sequence=(SELECT n FROM ordered WHERE ordered.id=grouping_files.id) "
        "WHERE workspace=? AND node=?",
        (workspace, row["id"], workspace, row["id"]),
    )
    db.execute(
        BRANCH + "UPDATE grouping_folders SET node=? WHERE workspace=? "
        "AND node IN (SELECT id FROM branch)",
        (row["id"], workspace, row["id"], workspace),
    )
    db.execute(
        "DELETE FROM grouping_folders WHERE workspace=? AND node=? AND path=?",
        (workspace, row["id"], row["directory"]),
    )
    db.execute(
        BRANCH + "DELETE FROM grouping_nodes WHERE workspace=? "
        "AND id IN (SELECT id FROM branch) AND id<>?",
        (row["id"], workspace, workspace, row["id"]),
    )
    db.execute(
        "UPDATE grouping_nodes SET kind='bundle',reason='' WHERE workspace=? AND id=?",
        (workspace, row["id"]),
    )
    return {row["id"]}
