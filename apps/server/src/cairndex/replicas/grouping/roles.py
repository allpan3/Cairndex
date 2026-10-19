"""Recompute the established roles in bounded pages after an owner edits file order."""

import json
import sqlite3
from typing import Any

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.grouping import suggester as rules
from cairndex.replicas.catalog.model import value_text

# These pages read cached metadata only. Larger pages avoid a durable progress
# write for every handful of unchanged roles while keeping Release responsive.
BATCH = 256


def context(db: sqlite3.Connection, workspace: str, node: sqlite3.Row) -> dict[str, Any]:
    if node["target"]:
        return {"addition": True}
    stats = db.execute(
        "SELECT count(*) AS videos,count(DISTINCT part) AS parts,"
        "coalesce(sum(part IS NULL),0) AS no_part FROM grouping_files "
        "WHERE workspace=? AND node=? AND kind='video'",
        (workspace, node["id"]),
    ).fetchone()
    first = db.execute(
        "SELECT id FROM grouping_files WHERE workspace=? AND node=? AND kind='video' "
        "ORDER BY sequence,id LIMIT 1",
        (workspace, node["id"]),
    ).fetchone()
    db.create_function(
        "grouping_cover_stem", 1, lambda path: int(rules._stem(path).lower() in rules._COVER_STEMS)
    )
    cover = db.execute(
        "SELECT id FROM grouping_files WHERE workspace=? AND node=? AND kind='image' "
        "ORDER BY grouping_cover_stem(path) DESC,sequence,id LIMIT 1",
        (workspace, node["id"]),
    ).fetchone()
    return {
        "addition": False,
        "videos": stats["videos"],
        "first": first[0] if first else None,
        "cover": cover[0] if cover else None,
        "multipart": stats["videos"] >= 2 and stats["parts"] == 1 and not stats["no_part"],
    }


def step(db: sqlite3.Connection, workspace: str) -> bool:
    node = db.execute(
        "SELECT * FROM grouping_nodes WHERE workspace=? AND roles_dirty=1 ORDER BY "
        "position,id LIMIT 1",
        (workspace,),
    ).fetchone()
    if not node:
        return True
    facts = (
        json.loads(node["role_context"]) if node["role_context"] else context(db, workspace, node)
    )
    rows = db.execute(
        "SELECT * FROM grouping_files WHERE workspace=? AND node=? AND sequence>? "
        "ORDER BY sequence,id LIMIT ?",
        (workspace, node["id"], node["role_cursor"], BATCH),
    ).fetchall()
    for row in rows:
        kind = MediaKind(row["kind"])
        if facts["addition"]:
            role = {
                MediaKind.VIDEO: FileRole.VIDEO_PART,
                MediaKind.IMAGE: FileRole.IMAGE,
                MediaKind.SUBTITLE: FileRole.SUBTITLE,
            }.get(kind, FileRole.ATTACHMENT)
        else:
            observation = rules.FileObservation(row["id"], row["path"], kind)
            role = rules._role_for(observation, facts["multipart"], facts["cover"])
            if (
                kind is MediaKind.VIDEO
                and facts["videos"] > 1
                and not facts["multipart"]
                and row["id"] != facts["first"]
            ):
                role = FileRole.ALTERNATE_VERSION
        if role.name != row["role"]:
            db.execute(
                "UPDATE grouping_files SET role=? WHERE workspace=? AND id=?",
                (role.name, workspace, row["id"]),
            )
    done = len(rows) < BATCH
    db.execute(
        "UPDATE grouping_nodes SET roles_dirty=?,role_cursor=?,role_context=? WHERE "
        "workspace=? AND id=?",
        (
            0 if done else 1,
            -1 if done else rows[-1]["sequence"],
            None if done else value_text(facts),
            workspace,
            node["id"],
        ),
    )
    return False
