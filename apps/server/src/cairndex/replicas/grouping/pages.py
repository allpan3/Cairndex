"""Revision-bound grouping tree and source pages, including unloaded descendants."""

import json
import sqlite3
from typing import Any, cast

from cairndex.grouping.suggester import stem_prefix_as_written
from cairndex.replicas.protocol import ReplicaError

MEDIA_COUNTS = (
    "(SELECT json_group_object(kind,total) FROM "
    "(SELECT kind,count(*) AS total FROM grouping_files f "
    "WHERE f.workspace=n.workspace AND f.node=n.id GROUP BY kind)) AS media_counts "
)


def destinations(
    db: sqlite3.Connection,
    workspace: str,
    revision: int,
    kind: str,
    query: str = "",
    after: str = "",
    limit: int = 50,
) -> dict[str, Any]:
    current(db, workspace, revision)
    rows = db.execute(
        "SELECT id,title,directory,kind,parent,context FROM grouping_nodes "
        "WHERE workspace=? AND kind=? AND id>? AND instr(lower(title),lower(?))>0 "
        "ORDER BY id LIMIT ?",
        (workspace, kind, after, query, limit + 1),
    ).fetchall()
    return {
        "items": [dict(row) for row in rows[:limit]],
        "revision": revision,
        "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
    }


def attention(
    db: sqlite3.Connection, workspace: str, revision: int, after: str = "", limit: int = 50
) -> dict[str, Any]:
    """Page uncertain bundles across the complete draft, including folded branches."""
    current(db, workspace, revision)
    rows = db.execute(
        "SELECT n.*,count(f.id) AS files,coalesce(sum(f.selected),0) AS selected,"
        "1 AS bundles,0 AS children,"
        "(SELECT count(*) FROM grouping_folders p WHERE p.workspace=n.workspace AND p.node=n.id) "
        "AS folders," + MEDIA_COUNTS + "FROM grouping_nodes n JOIN grouping_files f "
        "ON f.workspace=n.workspace AND f.node=n.id "
        "WHERE n.workspace=? AND n.kind='bundle' AND n.confidence<0.75 AND n.id>? "
        "GROUP BY n.id ORDER BY n.id LIMIT ?",
        (workspace, after, limit + 1),
    ).fetchall()
    return {
        "items": [public_node(row) for row in rows[:limit]],
        "revision": revision,
        "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
    }


def public_node(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    for field in ("workspace", "roles_dirty", "role_cursor", "role_context", "collection_basis"):
        item.pop(field)
    item["context"] = bool(item["context"])
    item["media_counts"] = json.loads(item["media_counts"])
    return item


def current(db: sqlite3.Connection, workspace: str, revision: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM grouping_workspaces WHERE id=?", (workspace,)).fetchone()
    if not row or row["state"] != "ready" or row["revision"] != revision:
        raise ReplicaError("Grouping draft changed; reload its current tree before editing")
    return cast(sqlite3.Row, row)


def nodes(
    db: sqlite3.Connection,
    workspace: str,
    revision: int,
    parent: str | None = None,
    after: int = -1,
    limit: int = 50,
) -> dict[str, Any]:
    current(db, workspace, revision)
    rows = db.execute(
        "WITH RECURSIVE page AS (SELECT * FROM grouping_nodes WHERE workspace=? "
        "AND parent IS ? AND position>? ORDER BY position,id LIMIT ?), "
        "branch(root,id) AS (SELECT id,id FROM page UNION ALL SELECT b.root,n.id "
        "FROM branch b JOIN grouping_nodes n ON n.workspace=? AND n.parent=b.id), "
        "totals AS (SELECT b.root,count(f.id) AS files,coalesce(sum(f.selected),0) AS selected,"
        "count(DISTINCT f.node) AS bundles FROM branch b LEFT JOIN grouping_files f "
        "ON f.workspace=? AND f.node=b.id GROUP BY b.root) "
        "SELECT n.*,t.files,t.selected,t.bundles,"
        "(SELECT count(*) FROM grouping_nodes c WHERE c.workspace=n.workspace "
        "AND c.parent=n.id) AS children,"
        "(SELECT count(*) FROM grouping_folders f WHERE f.workspace=n.workspace "
        "AND f.node=n.id) AS folders,"
        + MEDIA_COUNTS
        + "FROM page n JOIN totals t ON t.root=n.id ORDER BY n.position,n.id",
        (workspace, parent, after, limit + 1, workspace, workspace),
    ).fetchall()
    return {
        "items": [public_node(row) for row in rows[:limit]],
        "revision": revision,
        "next_cursor": rows[limit - 1]["position"] if len(rows) > limit else None,
    }


def files(
    db: sqlite3.Connection,
    workspace: str,
    revision: int,
    node: str,
    after: int = -1,
    limit: int = 50,
    *,
    visible_only: bool = False,
) -> dict[str, Any]:
    current(db, workspace, revision)
    rows = db.execute(
        "SELECT f.* FROM grouping_files f WHERE workspace=? AND node=? AND sequence>? "
        "AND (?=0 OR NOT EXISTS (SELECT 1 FROM grouping_folders p "
        "WHERE p.workspace=f.workspace AND p.node=f.node AND p.expanded=0 "
        "AND f.path>p.path||'/' AND f.path<p.path||'0')) "
        "ORDER BY sequence,id LIMIT ?",
        (workspace, node, after, visible_only, limit + 1),
    ).fetchall()
    items = []
    for row in rows[:limit]:
        items.append(
            {
                "id": row["id"],
                "path": row["path"],
                "role": row["role"],
                "sequence": row["sequence"],
                "selected": bool(row["selected"]),
                "media_kind": row["kind"],
            }
        )
    return {
        "items": items,
        "revision": revision,
        "next_cursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
    }


def folders(
    db: sqlite3.Connection,
    workspace: str,
    revision: int,
    node: str,
    after: str = "",
    limit: int = 50,
    *,
    visible_only: bool = False,
) -> dict[str, Any]:
    current(db, workspace, revision)
    rows = db.execute(
        "SELECT p.*, (SELECT count(*) FROM grouping_files f WHERE f.workspace=p.workspace "
        "AND f.node=p.node AND f.path>p.path||'/' AND f.path<p.path||'0') AS files, "
        "(SELECT coalesce(sum(f.selected),0) FROM grouping_files f WHERE f.workspace=p.workspace "
        "AND f.node=p.node AND f.path>p.path||'/' AND f.path<p.path||'0') AS selected "
        "FROM grouping_folders p WHERE workspace=? AND node=? AND path>? "
        "AND (?=0 OR NOT EXISTS (SELECT 1 FROM grouping_folders a "
        "WHERE a.workspace=p.workspace AND a.node=p.node AND a.expanded=0 "
        "AND p.path>a.path||'/' AND p.path<a.path||'0')) ORDER BY path LIMIT ?",
        (workspace, node, after, visible_only, limit + 1),
    ).fetchall()
    return {
        "items": [
            {
                "path": row["path"],
                "expanded": bool(row["expanded"]),
                "files": row["files"],
                "selected": row["selected"],
            }
            for row in rows[:limit]
        ],
        "revision": revision,
        "next_cursor": rows[limit - 1]["path"] if len(rows) > limit else None,
    }


def stems(
    db: sqlite3.Connection,
    workspace: str,
    revision: int,
    after: str | None = None,
    limit: int = 50,
    directory: str | None = None,
) -> dict[str, Any]:
    current(db, workspace, revision)
    rows = db.execute(
        "SELECT * FROM grouping_stems WHERE workspace=? AND (? IS NULL OR directory=?) "
        "AND (? IS NULL OR directory>?) ORDER BY directory LIMIT ?",
        (workspace, directory, directory, after, after, limit + 1),
    ).fetchall()
    return {
        "items": [
            {
                "directory": row["directory"],
                "level": row["level"],
                "max": row["maximum"],
                "stem": stem_prefix_as_written(row["example"], row["level"], row["maximum"]),
            }
            for row in rows[:limit]
        ],
        "revision": revision,
        "next_cursor": rows[limit - 1]["directory"] if len(rows) > limit else None,
    }
