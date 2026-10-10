"""Complete paged missing-identity choices with immutable evidence receipts"""

import hashlib
import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.protocol import checksum


# Exact samples find possibilities while only complete evidence can prove portable equality
def matching(db: sqlite3.Connection, run: str, observation: dict[str, Any]) -> sqlite3.Cursor:
    evidence = value_text(observation["evidence"])
    return db.execute(
        "SELECT body FROM discovery_missing WHERE run=? AND "
        "(json_extract(body,'$.evidence')=? OR json_extract(body,'$.sample')=?) "
        "ORDER BY file_id",
        (run, evidence, evidence),
    )


# The candidate checksum binds all choices while the displayed preview remains a bounded page
def stage(db: sqlite3.Connection, run: str, body: dict[str, Any]) -> None:
    count, digest = 0, hashlib.sha256()
    for (raw,) in matching(db, run, body["files"][0]):
        count += 1
        digest.update(raw.encode() + b"\n")
    body = body | {"choices": [], "choices_total": count, "choices_digest": digest.hexdigest()}
    identity = checksum(value_text(body).encode())
    db.execute(
        "INSERT INTO discovery_candidates VALUES (?,?,?,?,'pending') "
        "ON CONFLICT(id) DO UPDATE SET run=excluded.run,state='pending'",
        (identity, run, body["files"][0]["path"], value_text(body)),
    )
    for (raw,) in matching(db, run, body["files"][0]):
        db.execute(
            "INSERT OR IGNORE INTO discovery_candidate_choices VALUES (?,?,?)",
            (identity, json.loads(raw)["file_id"], raw),
        )


# Choice pages can return the saved selection separately so changing pages never clears its label
def page(
    db: sqlite3.Connection, candidate: str, after: str = "", selected: str = ""
) -> dict[str, Any]:
    rows = db.execute(
        "SELECT file_id,body FROM discovery_candidate_choices WHERE candidate=? "
        "AND file_id>? ORDER BY file_id LIMIT 51",
        (candidate, after),
    ).fetchall()
    chosen = db.execute(
        "SELECT body FROM discovery_candidate_choices WHERE candidate=? AND file_id=?",
        (candidate, selected),
    ).fetchone()
    return {
        "items": [json.loads(row[1]) for row in rows[:50]],
        "next_cursor": rows[49][0] if len(rows) > 50 else None,
        "selected": json.loads(chosen[0]) if chosen else None,
    }


# Recovery binds every missing-identity option and its original causal references to the candidate
def validate(db: sqlite3.Connection, candidate: str, body: dict[str, Any]) -> None:
    from cairndex.replicas.discovery_validation import observation, references
    from cairndex.replicas.protocol import ReplicaError

    count, digest = 0, hashlib.sha256()
    for (raw,) in db.execute(
        "SELECT body FROM discovery_candidate_choices WHERE candidate=? ORDER BY file_id",
        (candidate,),
    ):
        item = json.loads(raw)
        observation(item, physical=item["automatic"])
        references(db, item["basis"])
        references(db, item["content_basis"])
        count += 1
        digest.update(raw.encode() + b"\n")
    if count != body["choices_total"] or digest.hexdigest() != body["choices_digest"]:
        raise ReplicaError("Private discovery identity choices are incomplete")
