"""Read-only collection context for explicit placement, with captured causal bases."""

import sqlite3

from cairndex.core.ids import new_id
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError


def materialize(db: sqlite3.Connection, workspace: str, moving: str, collection: str) -> str:
    path = []
    seen = set()
    current = collection
    while current:
        if current in seen:
            raise ReplicaError("The selected collection hierarchy contains a cycle")
        seen.add(current)
        row = read_row(db, "collections", current)
        if not row:
            raise ReplicaError("The selected collection is unavailable")
        path.append(row)
        current = row["parent_id"]
    parent = None
    for row in reversed(path):
        basis = {}
        for unit in (
            key("collections", row["id"], "$alive"),
            key("collections", row["id"], "name"),
            "collections/_/$forest",
        ):
            if db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone():
                raise ReplicaError("Resolve the collection's current hierarchy before placement")
            basis[unit] = [
                item[0]
                for item in db.execute(
                    "SELECT event FROM catalog_revisions WHERE unit=? AND active=1 ORDER BY event",
                    (unit,),
                )
            ]
        existing = db.execute(
            "SELECT * FROM grouping_nodes WHERE workspace=? AND collection=?",
            (workspace, row["id"]),
        ).fetchone()
        if not existing:
            existing = db.execute(
                "SELECT * FROM grouping_nodes WHERE workspace=? AND parent IS ? "
                "AND kind='container' AND context=0 AND title=? AND collection IS NULL "
                "ORDER BY position,id LIMIT 1",
                (workspace, parent, row["name"]),
            ).fetchone()
        if (
            existing
            and db.execute(
                "WITH RECURSIVE branch(id) AS (SELECT ? UNION ALL SELECT n.id FROM "
                "grouping_nodes n "
                "JOIN branch b ON n.parent=b.id WHERE n.workspace=?) SELECT 1 FROM branch "
                "WHERE id=?",
                (moving, workspace, existing["id"]),
            ).fetchone()
        ):
            raise ReplicaError("A collection suggestion cannot contain itself")
        if not existing:
            identity = new_id()
            db.execute(
                "INSERT INTO grouping_nodes(workspace,id,parent,kind,title,directory,collection,"
                "collection_basis,context,position,confidence,reason) "
                "VALUES (?,?,?,'container',?,'',?,?,1,"
                "(SELECT coalesce(max(position),-1)+1 FROM grouping_nodes "
                "WHERE workspace=? AND parent IS ?),1.0,'existing collection')",
                (
                    workspace,
                    identity,
                    parent,
                    row["name"],
                    row["id"],
                    value_text(basis),
                    workspace,
                    parent,
                ),
            )
        else:
            identity = existing["id"]
            db.execute(
                "UPDATE grouping_nodes SET collection=?,collection_basis=?,parent=?,"
                "title=CASE WHEN context=1 THEN ? ELSE title END WHERE workspace=? AND id=?",
                (row["id"], value_text(basis), parent, row["name"], workspace, identity),
            )
        parent = identity
    if parent is None:
        raise ReplicaError("Choose an existing collection")
    return str(parent)


def prune(db: sqlite3.Connection, workspace: str) -> None:
    while db.execute(
        "DELETE FROM grouping_nodes AS n WHERE workspace=? AND context=1 AND NOT EXISTS "
        "(SELECT 1 FROM grouping_nodes c WHERE c.workspace=n.workspace AND c.parent=n.id)",
        (workspace,),
    ).rowcount:
        pass
