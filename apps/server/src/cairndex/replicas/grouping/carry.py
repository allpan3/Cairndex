"""Carry the owner's choices from the latest edited draft into a new Update's draft.

A new Update builds its draft from fresh planner evidence. Without this step every
title, selection, move and placement the owner made in an earlier draft would stay
behind in a draft that can no longer be accepted. The carry copies the *resulting
state* of the earlier draft onto the files that are still present, rather than
replaying its commands: commands name node ids the planner made for the earlier run,
anchor on files that may be gone, and unscoped commands such as "select all off"
would also reach files the owner never saw.

Files keep their fresh observation (`body`, `kind`, `part`), so acceptance still
checks current generations. New files keep their fresh suggestions. The earlier draft
is only read. Each sub-step is one bounded page, resumable from the cursor.
"""

import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.discovery_sources import stable_id
from cairndex.replicas.grouping import roles

BATCH = 32
STEPS = ("files", "folders", "stems", "prune", "order", "roles")
NODE_COLUMNS = (
    "parent",
    "kind",
    "title",
    "directory",
    "target",
    "original_target",
    "target_title",
    "collection",
    "collection_basis",
    "context",
    "position",
    "confidence",
    "reason",
)


def source(db: sqlite3.Connection, workspace: str) -> str | None:
    """The earlier draft the owner edited most recently, when it can be read as it stands."""
    row = db.execute(
        "SELECT w.id,w.state,w.phase,w.accepting,v.state AS review "
        "FROM grouping_commands c JOIN grouping_workspaces w ON w.id=c.workspace "
        "JOIN discovery_runs r ON r.id=w.id LEFT JOIN discovery_reviews v ON v.id=w.accepting "
        "WHERE c.state='succeeded' AND c.workspace<>? "
        "AND json_extract(c.intent,'$.action') NOT IN ('prepare','cancel_review') "
        "AND r.sequence<(SELECT sequence FROM discovery_runs WHERE id=?) "
        "ORDER BY c.sequence DESC LIMIT 1",
        (workspace, workspace),
    ).fetchone()
    if not row:
        return None
    # A review in progress owns its draft. A refused or cancelled one leaves the
    # owner's choices to carry; that is how a refused acceptance recovers.
    if row["accepting"] and row["review"] not in {"failed", "cancelled"}:
        return None
    # Edits wait while a draft builds, so the earlier draft is either settled or
    # only recomputing roles, which the carry recomputes anyway. A stem or
    # collection regroup in flight has partial nodes, so it is not read.
    if row["state"] != "ready" and row["phase"] != "roles":
        return None
    return str(row["id"])


def start(db: sqlite3.Connection, workspace: str) -> bool:
    """Begin a carry after the fresh copy; False when there is nothing to carry."""
    origin = source(db, workspace)
    if not origin:
        return False
    db.execute(
        "UPDATE grouping_workspaces SET phase='carry',cursor=? WHERE id=?",
        (value_text({"from": origin, "step": "files", "after": "", "files": 0}), workspace),
    )
    return True


def mapped(db: sqlite3.Connection, workspace: str, old: sqlite3.Row) -> str:
    # Planner ids are deterministic, so the same subject has the same id in both
    # drafts. Only a merge or split leaves an id whose kind differs; that node gets
    # its own derived id so the fresh node and its children stay valid.
    row = db.execute(
        "SELECT kind FROM grouping_nodes WHERE workspace=? AND id=?", (workspace, old["id"])
    ).fetchone()
    if row and row["kind"] != old["kind"]:
        return stable_id(["grouping-carry", workspace, old["id"]])
    return str(old["id"])


def dirty(db: sqlite3.Connection, workspace: str, node: str | None) -> None:
    if node:
        db.execute(
            "UPDATE grouping_nodes SET roles_dirty=1,role_cursor=-1,role_context=NULL "
            "WHERE workspace=? AND id=?",
            (workspace, node),
        )


def node(
    db: sqlite3.Connection,
    workspace: str,
    origin: str,
    identity: str,
    memo: dict[str, str | None],
) -> str | None:
    """Copy an earlier node and its ancestors, parent first; returns its id in this draft.

    The whole chain is copied so carried nodes only point at carried nodes; the
    earlier tree has no cycle, so none can form here.
    """
    if identity in memo:
        return memo[identity]
    old = db.execute(
        "SELECT * FROM grouping_nodes WHERE workspace=? AND id=?", (origin, identity)
    ).fetchone()
    parent = node(db, workspace, origin, old["parent"], memo) if old["parent"] else None
    values = {name: old[name] for name in NODE_COLUMNS} | {"parent": parent}
    if old["collection"] and not read_row(db, "collections", old["collection"]):
        if old["context"]:
            # The existing collection is gone: its children move up to the nearest
            # carried ancestor instead of naming a collection that cannot be placed.
            memo[identity] = parent
            return parent
        values |= {"collection": None, "collection_basis": None}
    # A surviving collection keeps the basis captured when it was chosen, so a
    # collection changed since still refuses at acceptance.
    new = mapped(db, workspace, old)
    fresh = db.execute(
        "SELECT parent FROM grouping_nodes WHERE workspace=? AND id=?", (workspace, new)
    ).fetchone()
    if fresh and fresh["parent"] != parent:
        dirty(db, workspace, fresh["parent"])
    db.execute(
        f"INSERT INTO grouping_nodes(workspace,id,{','.join(NODE_COLUMNS)},roles_dirty) "
        f"VALUES (?,?,{','.join('?' for _ in NODE_COLUMNS)},1) "
        "ON CONFLICT(workspace,id) DO UPDATE SET "
        + ",".join(f"{name}=excluded.{name}" for name in NODE_COLUMNS)
        + ",roles_dirty=1,role_cursor=-1,role_context=NULL",
        (workspace, new, *(values[name] for name in NODE_COLUMNS)),
    )
    memo[identity] = new
    return new


def confirmed(db: sqlite3.Connection, bundle: str | None) -> bool:
    if not bundle:
        return True
    row = read_row(db, "asset_bundles", bundle)
    return bool(row and row["grouping_state"] == "CONFIRMED")


def files(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> bool:
    rows = db.execute(
        "SELECT id,path,node FROM grouping_files WHERE workspace=? AND path>? "
        "ORDER BY path LIMIT ?",
        (workspace, work["after"], BATCH),
    ).fetchall()
    memo: dict[str, str | None] = {}
    for row in rows:
        old = db.execute(
            "SELECT f.sequence,f.selected,n.id,n.target,n.original_target "
            "FROM grouping_files f JOIN grouping_nodes n ON n.workspace=f.workspace "
            "AND n.id=f.node WHERE f.workspace=? AND f.path=?",
            (work["from"], row["path"]),
        ).fetchone()
        # An addition to a bundle that is no longer confirmed keeps the fresh suggestion
        if not old or not confirmed(db, old["target"] or old["original_target"]):
            continue
        target = node(db, workspace, work["from"], old["id"], memo)
        if target != row["node"]:
            dirty(db, workspace, row["node"])
        db.execute(
            "UPDATE grouping_files SET node=?,sequence=?,selected=? WHERE workspace=? AND id=?",
            (target, old["sequence"], old["selected"], workspace, row["id"]),
        )
        work["files"] += 1
    work["after"] = rows[-1]["path"] if rows else ""
    return not rows


def folders(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> bool:
    rows = db.execute(
        "SELECT f.path,o.expanded,n.id,n.kind FROM grouping_folders f "
        "JOIN grouping_folders o ON o.workspace=? AND o.path=f.path "
        "JOIN grouping_nodes n ON n.workspace=o.workspace AND n.id=o.node "
        "WHERE f.workspace=? AND f.path>? ORDER BY f.path LIMIT ?",
        (work["from"], workspace, work["after"], BATCH),
    ).fetchall()
    for row in rows:
        target = mapped(db, workspace, row)
        exists = db.execute(
            "SELECT 1 FROM grouping_nodes WHERE workspace=? AND id=?", (workspace, target)
        ).fetchone()
        db.execute(
            "UPDATE grouping_folders SET expanded=?,node=CASE WHEN ? THEN ? ELSE node END "
            "WHERE workspace=? AND path=?",
            (row["expanded"], bool(exists), target, workspace, row["path"]),
        )
    work["after"] = rows[-1]["path"] if rows else ""
    return not rows


def stems(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> bool:
    rows = db.execute(
        "SELECT s.directory,min(o.level,s.maximum) AS level FROM grouping_stems s "
        "JOIN grouping_stems o ON o.workspace=? AND o.directory=s.directory "
        "WHERE s.workspace=? AND s.directory>? ORDER BY s.directory LIMIT ?",
        (work["from"], workspace, work["after"], BATCH),
    ).fetchall()
    db.executemany(
        "UPDATE grouping_stems SET level=? WHERE workspace=? AND directory=?",
        ((row["level"], workspace, row["directory"]) for row in rows),
    )
    work["after"] = rows[-1]["directory"] if rows else ""
    return not rows


def dirty_page(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> list[sqlite3.Row]:
    position, identity = json.loads(work["after"]) if work["after"] else (-1, "")
    rows = db.execute(
        "SELECT id,parent,kind,position FROM grouping_nodes WHERE workspace=? AND roles_dirty=1 "
        "AND (position,id)>(?,?) ORDER BY position,id LIMIT ?",
        (workspace, position, identity, BATCH),
    ).fetchall()
    work["after"] = value_text([rows[-1]["position"], rows[-1]["id"]]) if rows else ""
    return list(rows)


def prune(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> bool:
    """Remove bundles left without files and collections left without children."""
    rows = dirty_page(db, workspace, work)
    for row in rows:
        current: str | None = row["id"]
        # Each removal can empty its parent; the walk is bounded by the tree depth
        while current:
            found = db.execute(
                "SELECT parent,kind FROM grouping_nodes WHERE workspace=? AND id=?",
                (workspace, current),
            ).fetchone()
            if not found:
                break
            empty = not db.execute(
                "SELECT 1 FROM grouping_files WHERE workspace=? AND node=? LIMIT 1"
                if found["kind"] == "bundle"
                else "SELECT 1 FROM grouping_nodes WHERE workspace=? AND parent=? LIMIT 1",
                (workspace, current),
            ).fetchone()
            if not empty:
                break
            db.execute(
                "DELETE FROM grouping_folders WHERE workspace=? AND node=?", (workspace, current)
            )
            db.execute(
                "DELETE FROM grouping_nodes WHERE workspace=? AND id=?", (workspace, current)
            )
            current = found["parent"]
    return not rows


def order(db: sqlite3.Connection, workspace: str, work: dict[str, Any]) -> bool:
    """Make file order dense again; moves and roles assume sequences 0..n-1."""
    rows = dirty_page(db, workspace, work)
    for row in rows:
        if row["kind"] != "bundle":
            continue
        db.execute(
            "WITH ordered AS MATERIALIZED (SELECT id,row_number() OVER "
            "(ORDER BY sequence,id)-1 AS n FROM grouping_files WHERE workspace=? AND node=?) "
            "UPDATE grouping_files SET sequence=(SELECT n FROM ordered "
            "WHERE ordered.id=grouping_files.id) WHERE workspace=? AND node=?",
            (workspace, row["id"], workspace, row["id"]),
        )
    return not rows


def step(db: sqlite3.Connection, workspace: str, cursor: str) -> None:
    work = json.loads(cursor)
    done = (
        roles.step(db, workspace)
        if work["step"] == "roles"
        else {"files": files, "folders": folders, "stems": stems, "prune": prune, "order": order}[
            work["step"]
        ](db, workspace, work)
    )
    if not done:
        db.execute(
            "UPDATE grouping_workspaces SET cursor=? WHERE id=?", (value_text(work), workspace)
        )
        return
    following = STEPS.index(work["step"]) + 1
    if following < len(STEPS):
        work |= {"step": STEPS[following], "after": ""}
        db.execute(
            "UPDATE grouping_workspaces SET cursor=? WHERE id=?", (value_text(work), workspace)
        )
        return
    if work["files"]:
        # The draft now holds the owner's choices, so a later Update carries from it
        db.execute(
            "INSERT OR IGNORE INTO grouping_commands(id,workspace,revision,intent,state,phase,"
            "result,sequence) VALUES (?,?,1,?,'succeeded','done',?,"
            "(SELECT coalesce(max(sequence),0)+1 FROM grouping_commands))",
            (
                "carry:" + workspace,
                workspace,
                value_text({"action": "carry", "from": work["from"]}),
                value_text({"files": work["files"]}),
            ),
        )
    db.execute("UPDATE grouping_workspaces SET phase='reasons',cursor='' WHERE id=?", (workspace,))
