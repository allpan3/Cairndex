"""Immutable disk-backed suggestions and paged members for complete grouping reviews"""

import hashlib
import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.discovery_plan import BATCH
from cairndex.replicas.protocol import ReplicaError, checksum

SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_candidate_groups (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(candidate,id));
CREATE TABLE IF NOT EXISTS discovery_candidate_files (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), position INTEGER NOT NULL,
    group_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(candidate,position));
CREATE INDEX IF NOT EXISTS discovery_candidate_file_group ON
discovery_candidate_files(candidate,group_id,position);
CREATE TABLE IF NOT EXISTS discovery_candidate_choices (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), file_id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(candidate,file_id));
"""
TABLES = {
    "discovery_candidate_groups",
    "discovery_candidate_files",
    "discovery_candidate_file_group",
    "discovery_candidate_choices",
}


# Ancestor context is complete and shallow; selecting a descendant cannot orphan its hierarchy
def group_body(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> dict[str, Any]:
    ancestors = []
    parent = group["parent"]
    while parent:
        row = db.execute(
            "SELECT * FROM discovery_plan_groups WHERE run=? AND directory=? AND kind='container'",
            (run, parent),
        ).fetchone()
        if row is None:
            break
        ancestors.append({"directory": row["directory"], "title": row["title"]})
        parent = row["parent"]
    return {
        "id": group["id"],
        "title": group["title"],
        "target": group["target"],
        "directory": group["directory"],
        "ancestors": list(reversed(ancestors)),
        "folders": [
            row[0]
            for row in db.execute(
                "SELECT path FROM discovery_plan_folders WHERE run=? AND proposal=? ORDER BY path",
                (run, group["id"]),
            )
        ],
    }


# Group membership is selected relationally so a collection includes every later-page descendant
def selected_groups(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> sqlite3.Cursor:
    if group["kind"] != "container":
        return db.execute(
            "SELECT * FROM discovery_plan_groups WHERE run=? AND id=? AND kind='bundle'",
            (run, group["id"]),
        )
    return db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? AND kind='bundle' AND "
        "(directory=? OR substr(directory,1,length(?)+1)=?||'/') "
        "ORDER BY directory,id",
        (
            run,
            group["directory"],
            group["directory"],
            group["directory"],
        ),
    )


# A complete source receipt uses constant hash buffers and a deterministic full member stream
def source_rows(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> sqlite3.Cursor:
    if group["kind"] != "container":
        return db.execute(
            "SELECT * FROM discovery_plan_files WHERE run=? AND proposal=? ORDER BY sequence,path",
            (run, group["id"]),
        )
    return db.execute(
        "SELECT f.* FROM discovery_plan_files f JOIN discovery_plan_groups g "
        "ON g.run=f.run AND g.id=f.proposal WHERE g.run=? AND g.kind='bundle' AND "
        "(g.directory=? OR substr(g.directory,1,length(?)+1)=?||'/') "
        "ORDER BY g.directory,g.id,f.sequence,f.path",
        (
            run,
            group["directory"],
            group["directory"],
            group["directory"],
        ),
    )


# Persist the suggestion header and normalized group context before copying bounded member pages
def begin(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> str:
    digest, count, first = hashlib.sha256(), 0, ""
    for row in source_rows(db, run, group):
        body = json.loads(row["body"]) | {"role": row["role"], "sequence": row["sequence"]}
        digest.update(value_text([row["proposal"], body]).encode() + b"\n")
        count += 1
        first = first or row["path"]
    if not count:
        raise ReplicaError("A grouping suggestion has no discovered source files")
    groups_digest = hashlib.sha256()
    for selected in selected_groups(db, run, group):
        groups_digest.update(value_text(group_body(db, run, selected)).encode() + b"\n")
    body = {
        "version": 2,
        "kind": "collection" if group["kind"] == "container" else "new",
        "files": [],
        "file_count": count,
        "files_digest": digest.hexdigest(),
        "groups_digest": groups_digest.hexdigest(),
        "title": group["title"],
        "target": group["target"],
        "directory": group["directory"],
        "reason": "Review this collection and its complete descendants"
        if group["kind"] == "container"
        else "Add files to the confirmed bundle"
        if group["target"]
        else "Review the complete grouping",
    }
    identity = checksum(value_text(body).encode())
    db.execute(
        "INSERT INTO discovery_candidates VALUES (?,?,?,?,'building') "
        "ON CONFLICT(id) DO UPDATE SET run=excluded.run,state='building'",
        (identity, run, first, value_text(body)),
    )
    for selected in selected_groups(db, run, group):
        db.execute(
            "INSERT OR IGNORE INTO discovery_candidate_groups VALUES (?,?,?)",
            (identity, selected["id"], value_text(group_body(db, run, selected))),
        )
    db.execute(
        "UPDATE discovery_plan_groups SET stage=?,cursor=0 WHERE run=? AND id=?",
        ("export:" + identity, run, group["id"]),
    )
    return identity


def source_page(db: sqlite3.Connection, run: str, candidate: str, cursor: int) -> list[sqlite3.Row]:
    """Resume at the last exported member, without numbering the complete stream again."""
    directory, identity, sequence, path = "", "", -1, ""
    if cursor:
        prior = db.execute(
            "SELECT g.directory,f.group_id,f.body FROM discovery_candidate_files f "
            "JOIN discovery_plan_groups g ON g.run=? AND g.id=f.group_id "
            "WHERE f.candidate=? AND f.position=?",
            (run, candidate, cursor - 1),
        ).fetchone()
        if prior is None:
            raise ReplicaError("Grouping export cursor has no committed member")
        body = json.loads(prior["body"])
        directory, identity, sequence, path = (
            prior["directory"],
            prior["group_id"],
            body["sequence"],
            body["path"],
        )
    rows: list[sqlite3.Row] = []
    while len(rows) < BATCH:
        if identity:
            rows.extend(
                db.execute(
                    "SELECT body,role,sequence,proposal,path FROM discovery_plan_files "
                    "WHERE run=? AND proposal=? AND (sequence,path)>(?,?) "
                    "ORDER BY sequence,path LIMIT ?",
                    (run, identity, sequence, path, BATCH - len(rows)),
                ).fetchall()
            )
            if len(rows) == BATCH:
                break
        group = db.execute(
            "SELECT g.directory,g.id FROM discovery_candidate_groups c "
            "JOIN discovery_plan_groups g ON g.run=? AND g.id=c.id "
            "WHERE c.candidate=? AND (g.directory,g.id)>(?,?) "
            "ORDER BY g.directory,g.id LIMIT 1",
            (run, candidate, directory, identity),
        ).fetchone()
        if group is None:
            break
        directory, identity, sequence, path = group["directory"], group["id"], -1, ""
    return rows


# Copying internal pages changes neither the complete candidate checksum nor its review boundary
def tick(db: sqlite3.Connection, run: str) -> bool:
    group = db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? AND stage LIKE 'export:%' "
        "ORDER BY id LIMIT 1",
        (run,),
    ).fetchone()
    if group is None:
        group = db.execute(
            "SELECT * FROM discovery_plan_groups WHERE run=? AND "
            "(stage='ready' OR (kind='container' AND stage='classified')) ORDER BY id LIMIT 1",
            (run,),
        ).fetchone()
        if group is None:
            return True
        identity = begin(db, run, group)
        group = db.execute(
            "SELECT * FROM discovery_plan_groups WHERE run=? AND id=?", (run, group["id"])
        ).fetchone()
    else:
        identity = group["stage"].split(":", 1)[1]
    rows = source_page(db, run, identity, group["cursor"])
    for position, row in enumerate(rows, start=group["cursor"]):
        db.execute(
            "INSERT OR IGNORE INTO discovery_candidate_files VALUES (?,?,?,?)",
            (
                identity,
                position,
                row["proposal"],
                value_text(
                    json.loads(row["body"]) | {"role": row["role"], "sequence": row["sequence"]}
                ),
            ),
        )
    db.execute(
        "UPDATE discovery_plan_groups SET cursor=cursor+? WHERE run=? AND id=?",
        (len(rows), run, group["id"]),
    )
    if len(rows) < BATCH:
        db.execute("UPDATE discovery_candidates SET state='pending' WHERE id=?", (identity,))
        db.execute(
            "UPDATE discovery_plan_groups SET stage='exported' WHERE run=? AND id=?",
            (run, group["id"]),
        )
    return False


# Old retained reviews and normalized suggestions share one ordered member accessor
def files(
    db: sqlite3.Connection, candidate: str, after: int = -1, limit: int = 50
) -> dict[str, Any]:
    row = db.execute("SELECT body FROM discovery_candidates WHERE id=?", (candidate,)).fetchone()
    if row is None:
        raise ReplicaError("Discovery candidate is unavailable")
    body = json.loads(row[0])
    if body.get("version") == 2:
        rows = db.execute(
            "SELECT position,body,group_id FROM discovery_candidate_files "
            "WHERE candidate=? AND position>? ORDER BY position LIMIT ?",
            (candidate, after, limit + 1),
        ).fetchall()
    else:
        rows = [(i, value_text(file), "") for i, file in enumerate(body["files"]) if i > after][
            : limit + 1
        ]
    items = []
    for member in rows[:limit]:
        file = json.loads(member[1])
        accepted = bool(
            db.execute(
                "SELECT 1 FROM discovery_accepted_files WHERE path=? AND generation=?",
                (file["path"], file["generation"]),
            ).fetchone()
        )
        items.append(file | {"position": member[0], "group": member[2], "accepted": accepted})
    return {
        "items": items,
        "next_cursor": rows[limit - 1][0] if len(rows) > limit else None,
        "total": body.get("file_count", len(body["files"])),
    }


# Candidate lists return one display page while complete private source membership stays on disk
def display(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    body = json.loads(row["body"])
    if "choices_digest" in body:
        from cairndex.replicas.discovery_choices import page as choice_page

        choices = choice_page(db, row["id"])
        body |= {"choices": choices["items"], "choices_next": choices["next_cursor"]}
    page = files(db, row["id"])
    unverified = (
        db.execute(
            "SELECT COUNT(*) FROM discovery_candidate_files WHERE candidate=? AND "
            "json_extract(body,'$.evidence.algorithm')<>'sha256'",
            (row["id"],),
        ).fetchone()[0]
        if body.get("version") == 2
        else sum(file["evidence"]["algorithm"] != "sha256" for file in body["files"])
    )
    return dict(row) | {
        "body": body
        | {
            "files": page["items"],
            "file_count": page["total"],
            "files_next": page["next_cursor"],
            "unverified_count": unverified,
        }
    }
