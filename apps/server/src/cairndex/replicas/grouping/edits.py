"""Small private tree edits; no source path or catalog membership is changed here."""

import sqlite3
from typing import Any, cast

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError


def node(
    db: sqlite3.Connection, workspace: str, identity: str, *, allow_context: bool = False
) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM grouping_nodes WHERE workspace=? AND id=?",
        (workspace, identity),
    ).fetchone()
    if not row or row["context"] and not allow_context:
        raise ReplicaError("Choose an editable suggestion from this grouping draft")
    return cast(sqlite3.Row, row)


def rename(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    row = node(db, workspace, intent["node"])
    if not isinstance(intent["title"], str):
        raise ReplicaError("Enter a suggestion title")
    title = intent["title"].strip()
    maximum = 255 if row["kind"] == "container" else 512
    if not title or len(title) > maximum:
        raise ReplicaError(f"A suggestion title must contain 1 to {maximum} characters")
    db.execute(
        "UPDATE grouping_nodes SET title=? WHERE workspace=? AND id=?",
        (title, workspace, row["id"]),
    )
    return set()


def select(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    if type(intent["selected"]) is not bool:
        raise ReplicaError("Choose whether the files are selected")
    selected = int(intent["selected"])
    if intent.get("nodes") is not None:
        identities = intent["nodes"]
        if (
            not isinstance(identities, list)
            or not 1 <= len(identities) <= 50
            or any(not isinstance(identity, str) for identity in identities)
            or len(set(identities)) != len(identities)
        ):
            raise ReplicaError("Choose up to fifty distinct bundle suggestions")
        for identity in identities:
            if node(db, workspace, identity)["kind"] != "bundle":
                raise ReplicaError("Choose bundle suggestions from this grouping draft")
        db.execute(
            "UPDATE grouping_files SET selected=? WHERE workspace=? "
            "AND node IN (SELECT value FROM json_each(?))",
            (selected, workspace, value_text(identities)),
        )
    elif intent.get("file"):
        found = db.execute(
            "SELECT 1 FROM grouping_files WHERE workspace=? AND id=?",
            (workspace, intent["file"]),
        ).fetchone()
        if not found:
            raise ReplicaError("Choose a file from this grouping draft")
        db.execute(
            "UPDATE grouping_files SET selected=? WHERE workspace=? AND id=?",
            (selected, workspace, intent["file"]),
        )
    elif intent.get("node"):
        row = node(db, workspace, intent["node"], allow_context=True)
        if intent.get("folder") is not None:
            folder = db.execute(
                "SELECT path FROM grouping_folders WHERE workspace=? AND node=? AND path=?",
                (workspace, row["id"], intent["folder"]),
            ).fetchone()
            if not folder:
                raise ReplicaError("Choose a folder from this suggestion")
            db.execute(
                "UPDATE grouping_files SET selected=? WHERE workspace=? AND node=? "
                "AND path>? AND path<?",
                (selected, workspace, row["id"], folder[0] + "/", folder[0] + "0"),
            )
        else:
            db.execute(
                "WITH RECURSIVE branch(id) AS (SELECT ? UNION ALL SELECT n.id "
                "FROM grouping_nodes n JOIN branch b ON n.parent=b.id WHERE n.workspace=?) "
                "UPDATE grouping_files SET selected=? WHERE workspace=? AND node IN (SELECT "
                "id FROM branch)",
                (row["id"], workspace, selected, workspace),
            )
    else:
        db.execute("UPDATE grouping_files SET selected=? WHERE workspace=?", (selected, workspace))
    return set()


def move_file(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    target = node(db, workspace, intent["node"])
    if target["kind"] != "bundle":
        raise ReplicaError("Move files into a bundle suggestion")
    source = db.execute(
        "SELECT * FROM grouping_files WHERE workspace=? AND id=?",
        (workspace, intent["file"]),
    ).fetchone()
    if not source:
        raise ReplicaError("Choose a file from this grouping draft")
    before = None
    if intent.get("before"):
        before = db.execute(
            "SELECT sequence FROM grouping_files WHERE workspace=? AND node=? AND id=?",
            (workspace, target["id"], intent["before"]),
        ).fetchone()
        if not before:
            raise ReplicaError("The destination file is no longer in this suggestion")
    position = (
        before[0]
        if before
        else db.execute(
            "SELECT coalesce(max(sequence),-1)+1 FROM grouping_files WHERE workspace=? AND node=?",
            (workspace, target["id"]),
        ).fetchone()[0]
    )
    if source["node"] == target["id"]:
        if intent.get("before") == source["id"]:
            return set()
        if source["sequence"] < position:
            position -= 1
        if source["sequence"] == position:
            return set()
    db.execute(
        "UPDATE grouping_files SET sequence=sequence-1 WHERE workspace=? AND node=? AND sequence>?",
        (workspace, source["node"], source["sequence"]),
    )
    db.execute(
        "UPDATE grouping_files SET sequence=sequence+1 WHERE workspace=? AND node=? "
        "AND sequence>=? AND id<>?",
        (workspace, target["id"], position, source["id"]),
    )
    db.execute(
        "UPDATE grouping_files SET node=?,sequence=? WHERE workspace=? AND id=?",
        (target["id"], position, workspace, source["id"]),
    )
    return {source["node"], target["id"]}


def reparent(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    from cairndex.replicas.grouping import collections

    if "parent" not in intent and not intent.get("collection"):
        raise ReplicaError("Name a destination, or explicitly choose the top level")
    row = node(db, workspace, intent["node"])
    if row["target"]:
        raise ReplicaError("An addition keeps its existing bundle's collections")
    parent = intent.get("parent")
    if parent is not None and (not isinstance(parent, str) or not parent):
        raise ReplicaError("Choose a collection suggestion, or explicitly choose the top level")
    if intent.get("collection"):
        if parent is not None:
            raise ReplicaError("Choose a proposed collection or an existing collection")
        parent = collections.materialize(db, workspace, row["id"], intent["collection"])
    if parent:
        target = db.execute(
            "SELECT kind FROM grouping_nodes WHERE workspace=? AND id=?",
            (workspace, parent),
        ).fetchone()
        if not target or target[0] != "container":
            raise ReplicaError("Choose a collection suggestion or an existing collection")
        if db.execute(
            "WITH RECURSIVE branch(id) AS (SELECT ? UNION ALL SELECT n.id "
            "FROM grouping_nodes n JOIN branch b ON n.parent=b.id WHERE n.workspace=?) "
            "SELECT 1 FROM branch WHERE id=? LIMIT 1",
            (row["id"], workspace, parent),
        ).fetchone():
            raise ReplicaError("A collection suggestion cannot contain itself")
    before = None
    if intent.get("before"):
        before = db.execute(
            "SELECT position FROM grouping_nodes WHERE workspace=? AND parent IS ? AND id=?",
            (workspace, parent, intent["before"]),
        ).fetchone()
        if not before:
            raise ReplicaError("The destination is no longer in this collection")
    position = (
        before[0]
        if before
        else db.execute(
            "SELECT coalesce(max(position),-1)+1 FROM grouping_nodes WHERE workspace=? AND "
            "parent IS ?",
            (workspace, parent),
        ).fetchone()[0]
    )
    if row["parent"] == parent:
        if intent.get("before") == row["id"]:
            return set()
        if row["position"] < position:
            position -= 1
        if row["position"] == position:
            return set()
    db.execute(
        "UPDATE grouping_nodes SET position=position-1 WHERE workspace=? AND parent IS ? AND "
        "position>?",
        (workspace, row["parent"], row["position"]),
    )
    db.execute(
        "UPDATE grouping_nodes SET position=position+1 WHERE workspace=? AND parent IS ? "
        "AND position>=? AND id<>?",
        (workspace, parent, position, row["id"]),
    )
    db.execute(
        "UPDATE grouping_nodes SET parent=?,position=? WHERE workspace=? AND id=?",
        (parent, position, workspace, row["id"]),
    )
    collections.prune(db, workspace)
    return set()


def destination(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    row = node(db, workspace, intent["node"])
    if (
        not row["original_target"]
        or row["kind"] != "bundle"
        or type(intent["create_new"]) is not bool
    ):
        raise ReplicaError("Only an addition has an existing-versus-new bundle choice")
    target = None if intent["create_new"] else row["original_target"]
    if target:
        owner = read_row(db, "asset_bundles", target)
        if not owner or owner["grouping_state"] != "CONFIRMED":
            raise ReplicaError("The existing bundle changed; run Update and review again")
    db.execute(
        "UPDATE grouping_nodes SET target=? WHERE workspace=? AND id=?",
        (target, workspace, row["id"]),
    )
    return {row["id"]}


def folder(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    node(db, workspace, intent["node"])
    if type(intent["expanded"]) is not bool:
        raise ReplicaError("Choose whether the folder is listed individually")
    result = db.execute(
        "UPDATE grouping_folders SET expanded=? WHERE workspace=? AND node=? AND path=?",
        (int(intent["expanded"]), workspace, intent["node"], intent["folder"]),
    )
    if not result.rowcount:
        raise ReplicaError("Choose a folder from this suggestion")
    return set()


def apply(db: sqlite3.Connection, workspace: str, intent: dict[str, Any]) -> set[str]:
    from cairndex.replicas.grouping import merge

    action = intent.get("action")
    methods = {
        "rename": rename,
        "select": select,
        "move_file": move_file,
        "reparent": reparent,
        "destination": destination,
        "folder": folder,
        "kind": merge.apply,
    }
    if action not in methods:
        raise ReplicaError("Unsupported grouping edit")
    return methods[action](db, workspace, intent)
