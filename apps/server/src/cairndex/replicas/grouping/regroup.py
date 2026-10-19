"""Rebuild one folder in bounded planner pages, then replace its draft rows atomically."""

import json
import sqlite3
from typing import Any

from cairndex.core.ids import new_id
from cairndex.grouping import suggester as rules
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.discovery_plan import (
    BATCH,
    assign_batch,
    classify_directory,
    combine_additions,
    finish_group,
    match_group,
    natural,
)
from cairndex.replicas.grouping import edits, initialize
from cairndex.replicas.protocol import ReplicaError


def scratch(operation: str) -> str:
    return "grouping-edit:" + operation


def begin(db: sqlite3.Connection, command: sqlite3.Row, intent: dict[str, Any]) -> None:
    workspace = command["workspace"]
    split = intent["action"] == "kind"
    row = edits.node(db, workspace, intent["node"])
    directory = row["directory"]
    args: tuple[Any, ...]
    if split:
        if row["kind"] != "bundle" or row["target"] or intent["kind"] != "container":
            raise ReplicaError("Only a new bundle suggestion can be split into a collection")
        if len(row["title"]) > 255:
            raise ReplicaError("Shorten the collection title to at most 255 characters")
        header = row
        level, maximum = 0, 1
        replacing = "id=?"
        args = (row["id"],)
    else:
        if type(intent["level"]) is not int:
            raise ReplicaError("Choose a whole-number stem level")
        stem = db.execute(
            "SELECT maximum FROM grouping_stems WHERE workspace=? AND directory=?",
            (workspace, directory),
        ).fetchone()
        if not stem:
            raise ReplicaError("This suggestion has no folder stem matching to adjust")
        maximum = stem[0]
        level = max(0, min(intent["level"], maximum))
        header = db.execute(
            "SELECT n.* FROM grouping_nodes n WHERE workspace=? AND directory=? "
            "AND kind='container' AND context=0 AND NOT EXISTS "
            "(SELECT 1 FROM grouping_nodes p WHERE p.workspace=n.workspace "
            "AND p.id=n.parent AND p.directory=n.directory) ORDER BY position,id LIMIT 1",
            (workspace, directory),
        ).fetchone()
        replacing = "directory=? AND context=0 AND id<>?"
        args = (directory, header["id"] if header else "")
    db.execute(
        "INSERT INTO grouping_replacements SELECT ?,id FROM grouping_nodes "
        f"WHERE workspace=? AND {replacing}",
        (command["id"], workspace, *args),
    )
    if (
        db.execute(
            "SELECT 1 FROM grouping_files f JOIN grouping_replacements r ON r.node=f.node "
            "WHERE r.command=? AND f.workspace=? AND f.directory<>? LIMIT 1",
            (command["id"], workspace, directory),
        ).fetchone()
        and not split
    ):
        raise ReplicaError(
            "This suggestion holds files from other folders; keep its manual grouping"
        )
    # A split uses every member even after cross-folder manual edits. Stem edits
    # affect only the selected physical directory and leave dragged-out files alone.
    count = db.execute(
        "SELECT count(*) FROM grouping_files f JOIN grouping_replacements r ON r.node=f.node "
        "WHERE r.command=? AND f.workspace=?",
        (command["id"], workspace),
    ).fetchone()[0]
    if not count:
        raise ReplicaError("This suggestion has no files to regroup")
    context = {
        "directory": directory,
        "split": split,
        "level": level,
        "maximum": maximum,
        "header": header["id"] if header else None,
        "parent": header["parent"] if header else row["parent"],
        "position": header["position"] if header else row["position"],
        "files": count,
    }
    db.execute(
        "INSERT INTO discovery_plan_directories(run,path) VALUES (?,?)",
        (scratch(command["id"]), directory),
    )
    db.execute(
        "UPDATE grouping_commands SET state='running',phase='copy',cursor='',result=? WHERE id=?",
        (value_text(context), command["id"]),
    )
    db.execute(
        "UPDATE grouping_workspaces SET state='editing',phase='regroup' WHERE id=?",
        (workspace,),
    )


def copy(db: sqlite3.Connection, command: sqlite3.Row, context: dict[str, Any]) -> None:
    workspace, operation = command["workspace"], command["id"]
    rows = db.execute(
        "SELECT p.* FROM grouping_replacements r JOIN grouping_files f "
        "ON f.workspace=? AND f.node=r.node JOIN discovery_plan_files p "
        "ON p.run=f.workspace AND p.path=f.path WHERE r.command=? AND p.path>? "
        "UNION ALL SELECT p.* FROM discovery_plan_files p WHERE p.run=? "
        "AND p.directory=? AND p.owner IS NOT NULL AND p.path>? AND ?=0 "
        "ORDER BY p.path LIMIT ?",
        (
            workspace,
            operation,
            command["cursor"],
            workspace,
            context["directory"],
            command["cursor"],
            int(context["split"]),
            BATCH,
        ),
    ).fetchall()
    keys = rules._StemKey(context["level"], max(1, context["maximum"] - context["level"] + 1))
    for row in rows:
        body = dict(row) | {
            "run": scratch(operation),
            "directory": context["directory"],
            "stem": keys.of(row["path"]),
            "proposal": None,
            "role": None,
            "sequence": None,
        }
        if context["split"] and row["owner"]:
            continue
        db.execute(
            "INSERT INTO discovery_plan_files ("
            + ",".join(body)
            + ") VALUES ("
            + ",".join("?" for _ in body)
            + ")",
            tuple(body.values()),
        )
    db.execute(
        "UPDATE grouping_commands SET cursor=?,phase=? WHERE id=?",
        (rows[-1]["path"] if rows else "", "copy" if rows else "plan", operation),
    )


def plan(db: sqlite3.Connection, command: sqlite3.Row, context: dict[str, Any]) -> None:
    run = scratch(command["id"])
    directory = db.execute(
        "SELECT * FROM discovery_plan_directories WHERE run=?",
        (run,),
    ).fetchone()
    if directory["phase"] in {"videos", "sidecars"}:
        assign_batch(db, run, directory, level=context["level"], split=context["split"])
        return
    group = db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? AND stage='match' ORDER BY id LIMIT 1",
        (run,),
    ).fetchone()
    if group:
        if not context["split"]:
            match_group(db, run, group)
        else:
            db.execute(
                "UPDATE discovery_plan_groups SET stage='classified' WHERE run=? AND id=?",
                (run, group["id"]),
            )
        return
    if not context["split"] and directory["phase"] == "assigned":
        combine_additions(db, run, context["directory"])
        classify_directory(db, run, context["directory"])
        return
    group = db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? AND kind='bundle' "
        "AND stage IN ('classified','roles') "
        "ORDER BY id LIMIT 1",
        (run,),
    ).fetchone()
    if group:
        finish_group(db, run, group)
        return
    db.execute("UPDATE grouping_commands SET phase='splice' WHERE id=?", (command["id"],))


def splice(db: sqlite3.Connection, command: sqlite3.Row, context: dict[str, Any]) -> None:
    workspace, operation = command["workspace"], command["id"]
    run = scratch(operation)
    count = db.execute(
        "SELECT count(*) FROM discovery_plan_files WHERE run=? AND owner IS NULL "
        "AND proposal IS NOT NULL",
        (run,),
    ).fetchone()[0]
    if count != context["files"]:
        raise ReplicaError("Regrouping would drop files; the previous draft is retained")
    groups = db.execute(
        "SELECT count(*) FROM discovery_plan_groups WHERE run=? AND kind='bundle'", (run,)
    ).fetchone()[0]
    if context["split"] and groups == 1:
        title = db.execute(
            "SELECT title FROM discovery_plan_groups WHERE run=?", (run,)
        ).fetchone()[0]
        header_row = edits.node(db, workspace, context["header"])
        if title == header_row["title"].strip():
            raise ReplicaError(
                "This subject already carries its own name; a collection adds no structure"
            )
    header = context["header"]
    if context["split"]:
        db.execute(
            "UPDATE grouping_nodes SET kind='container',reason='',roles_dirty=0 "
            "WHERE workspace=? AND id=?",
            (workspace, header),
        )
        db.execute(
            "UPDATE grouping_stems SET level=1 WHERE workspace=? AND directory=?",
            (workspace, context["directory"]),
        )
    elif not header and groups > 1 and context["directory"]:
        header = new_id()
        db.execute(
            "INSERT INTO "
            "grouping_nodes(workspace,id,parent,kind,title,directory,position,confidence,reason) "
            "VALUES (?,?,?,'container',?,?,?,0.85,'')",
            (
                workspace,
                header,
                context["parent"],
                context["directory"].rsplit("/", 1)[-1],
                context["directory"],
                context["position"],
            ),
        )
    if not header:
        db.execute(
            "UPDATE grouping_nodes SET position=position+? WHERE workspace=? "
            "AND parent IS ? AND position>=?",
            (groups, workspace, context["parent"], context["position"]),
        )
    split_confidence = (
        db.execute(
            "SELECT confidence FROM grouping_nodes WHERE workspace=? AND id=?",
            (workspace, header),
        ).fetchone()[0]
        if context["split"]
        else None
    )
    if not context["split"]:
        db.execute(
            "UPDATE grouping_stems SET level=? WHERE workspace=? AND directory=?",
            (context["level"], workspace, context["directory"]),
        )
    db.create_function("grouping_natural", 1, natural)
    for index, group in enumerate(
        db.execute(
            "SELECT * FROM discovery_plan_groups WHERE run=? AND kind='bundle' "
            "ORDER BY grouping_natural(title),id",
            (run,),
        )
    ):
        identity = new_id()
        title = group["title"]
        if not header and context["directory"] and not group["target"]:
            title = context["directory"].rsplit("/", 1)[-1]
        owner = (
            db.execute(
                "SELECT owner_title FROM discovery_plan_files WHERE run=? AND owner=? LIMIT 1",
                (run, group["target"]),
            ).fetchone()
            if group["target"]
            else None
        )
        db.execute(
            "INSERT INTO grouping_nodes(workspace,id,parent,kind,title,directory,target,"
            "original_target,target_title,position,confidence,reason) "
            "VALUES (?,?,?,'bundle',?,?,?,?,?,?,0.5,'')",
            (
                workspace,
                identity,
                header or context["parent"],
                title,
                context["directory"],
                group["target"],
                group["target"],
                owner[0] if owner else None,
                context["position"] + index,
            ),
        )
        db.execute(
            "UPDATE grouping_files SET node=?,sequence=(SELECT p.sequence FROM "
            "discovery_plan_files p "
            "WHERE p.run=? AND p.path=grouping_files.path),role=(SELECT p.role "
            "FROM discovery_plan_files p WHERE p.run=? AND p.path=grouping_files.path) "
            "WHERE workspace=? AND id IN "
            "(SELECT file_id FROM discovery_plan_files WHERE run=? AND proposal=?)",
            (identity, run, run, workspace, run, group["id"]),
        )
        db.execute(
            "INSERT INTO grouping_folders(workspace,path,node,expanded) "
            "SELECT ?,p.path,?,coalesce(f.expanded,0) FROM discovery_plan_folders p "
            "LEFT JOIN grouping_folders f ON f.workspace=? AND f.path=p.path "
            "WHERE p.run=? AND p.proposal=? "
            "ON CONFLICT(workspace,path) DO UPDATE SET node=excluded.node",
            (workspace, identity, workspace, run, group["id"]),
        )
        created = db.execute(
            "SELECT * FROM grouping_nodes WHERE workspace=? AND id=?", (workspace, identity)
        ).fetchone()
        # Automatic regeneration uses the established evidence rules. An explicit
        # type conversion inherits its parent's certainty, as the earlier review did.
        confidence, why = (
            (split_confidence, "")
            if context["split"]
            else initialize.reason(db, workspace, created)
        )
        db.execute(
            "UPDATE grouping_nodes SET confidence=?,reason=? WHERE workspace=? AND id=?",
            (confidence, why, workspace, identity),
        )
    # Displaced logical children from other physical folders follow the kept
    # folder header. Other edits, file selection and original observations survive.
    db.execute(
        "UPDATE grouping_nodes SET parent=? WHERE workspace=? AND parent IN "
        "(SELECT node FROM grouping_replacements WHERE command=?)",
        (header or context["parent"], workspace, operation),
    )
    db.execute(
        "DELETE FROM grouping_folders WHERE workspace=? AND node IN "
        "(SELECT node FROM grouping_replacements WHERE command=?)",
        (workspace, operation),
    )
    db.execute(
        "DELETE FROM grouping_nodes WHERE workspace=? AND id IN "
        "(SELECT node FROM grouping_replacements WHERE command=?) AND id<>?",
        (workspace, operation, header or ""),
    )
    # Freeze positions before updating them: an inlined CTE can observe earlier
    # row updates and reorder unrelated siblings while numbering the next row.
    db.execute(
        "WITH numbered AS MATERIALIZED (SELECT id,row_number() OVER (PARTITION BY parent ORDER BY "
        "position,id)-1 AS n "
        "FROM grouping_nodes WHERE workspace=?) UPDATE grouping_nodes "
        "SET position=(SELECT n FROM numbered WHERE numbered.id=grouping_nodes.id) WHERE "
        "workspace=?",
        (workspace, workspace),
    )
    cleanup(db, operation)


def cleanup(db: sqlite3.Connection, operation: str) -> None:
    for table in ("files", "groups", "folders", "directories"):
        db.execute(f"DELETE FROM discovery_plan_{table} WHERE run=?", (scratch(operation),))
    db.execute("DELETE FROM grouping_replacements WHERE command=?", (operation,))


def step(db: sqlite3.Connection, command: sqlite3.Row) -> bool:
    context = json.loads(command["result"])
    {"copy": copy, "plan": plan, "splice": splice}[command["phase"]](db, command, context)
    return bool(command["phase"] == "splice")
