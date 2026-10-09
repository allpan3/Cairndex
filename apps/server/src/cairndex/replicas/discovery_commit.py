"""Exact large-review receipts, paged revalidation and atomic catalog acceptance"""

import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.protocol import Root, decode, envelope, payload
from cairndex.replicas.discovery_preview import DiscoveryPreview
from cairndex.replicas.media import generation, open_source
from cairndex.replicas.protocol import ReplicaError, canonical, checksum
from cairndex.replicas.store import retry_receipt


# A compact receipt binds every reviewed source and its order as well as the authored values
def sources_digest(db: sqlite3.Connection, operation: str) -> str:
    digest = hashlib.sha256()
    for row in db.execute(
        "SELECT position,group_id,body,sort_order FROM discovery_review_files "
        "WHERE operation=? ORDER BY position",
        (operation,),
    ):
        digest.update(value_text(list(row)).encode() + b"\n")
    return digest.hexdigest()


# Event retries use the established complete intent encoding, assembled from private disk rows
def catalog_intent(builder: DiscoveryPreview, parents: str) -> str:
    changes: str = builder.db.execute(
        "SELECT json_group_array(json(item)) FROM (SELECT json_object('basis',json(basis),"
        "'cohort',cohort,'unit',unit,'value',value) AS item FROM discovery_review_values "
        "WHERE operation=? ORDER BY unit)",
        (builder.operation,),
    ).fetchone()[0]
    return '{"changes":' + changes + ',"parents":' + parents + ',"recover":false,"resolve":false}'


# Prepared parts remain private until the whole transaction passes the existing catalog validator
def activate(builder: DiscoveryPreview) -> str:
    db, store, operation = builder.db, builder.store, builder.operation
    intent = db.execute(
        "SELECT intent FROM discovery_review_commit WHERE operation=?", (operation,)
    ).fetchone()[0]
    author = db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]
    token = "discover_" + checksum(operation.encode())[:50]
    prior = retry_receipt(db, author, token)
    if prior:
        from cairndex.replicas.store import recovered_intent

        if (
            prior["intent"] or recovered_intent(db, store.descriptor, prior["id"], intent)
        ) != intent:
            raise ReplicaError("Discovery retry identity was reused for different work")
        return str(prior["id"])
    identity = ""
    for row in db.execute(
        "SELECT id,raw FROM discovery_review_parts WHERE operation=? ORDER BY sequence",
        (operation,),
    ):
        identity, body = decode(row["raw"], store.descriptor)
        raw = row["raw"]
        if isinstance(body, Root) and body.replica != author:
            # Restored uncommitted work keeps its bases but must use the fresh private author
            body = body.model_copy(update={"replica": author})
            identity, raw = envelope(body)
        if store.accept(db, identity, body, raw, local=True, intent=intent) == "pending":
            raise ReplicaError("Reviewed dependencies are unavailable; retain this review")
    if not identity:
        raise ReplicaError("The prepared catalog transaction is incomplete")
    return identity


# Preparation validates every selected group as one atomic operation and exposes a compact receipt
def finish(
    builder: DiscoveryPreview, root: Path, intent: dict[str, Any], work: sqlite3.Row
) -> None:
    db, store, operation = builder.db, builder.store, builder.operation
    digest = hashlib.sha256()
    count = 0
    for change in builder.changes():
        digest.update(canonical(change.model_dump()) + b"\n")
        count += 1
    db.execute("DELETE FROM discovery_review_parts WHERE operation=?", (operation,))
    author = db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]
    for sequence, (identity, raw) in enumerate(
        payload(
            builder.changes(),
            library=store.descriptor.library_uuid,
            epoch=store.descriptor.epoch,
            replica=author,
            operation="discover_" + checksum(operation.encode())[:50],
            parents=json.loads(work["parents"]),
        )
    ):
        db.execute(
            "INSERT INTO discovery_review_parts VALUES (?,?,?,?)",
            (operation, sequence, identity, raw),
        )
    db.execute(
        "INSERT OR REPLACE INTO discovery_review_commit VALUES (?,?)",
        (operation, catalog_intent(builder, work["parents"])),
    )
    db.execute("SAVEPOINT complete_discovery_preview")
    try:
        activate(builder)
    finally:
        db.execute("ROLLBACK TO complete_discovery_preview")
        db.execute("RELEASE complete_discovery_preview")
    candidate = json.loads(work["header"])
    groups = db.execute(
        "SELECT COUNT(*) FROM discovery_review_groups WHERE operation=?", (operation,)
    ).fetchone()[0]
    prepared = {
        "version": 2,
        "candidate": intent["candidate"],
        "kind": candidate["kind"],
        "title": intent.get("title", candidate["title"]),
        "target": intent.get("target", candidate["target"]),
        "file_count": work["total"],
        "group_count": groups,
        "sources_digest": sources_digest(db, operation),
        "old": None,
        "catalog": {
            "parents": json.loads(work["parents"]),
            "changes_digest": digest.hexdigest(),
            "change_count": count,
            "resolve": False,
            "recover": False,
        },
    }
    db.execute(
        "UPDATE discovery_reviews SET state='ready',prepared=?,error=NULL WHERE id=?",
        (value_text(prepared), operation),
    )
    db.execute(
        "UPDATE discovery_review_work SET phase='ready',cursor=-1 WHERE operation=?", (operation,)
    )


# Source generations are checked in pages before the final atomic write
def revalidate(builder: DiscoveryPreview, root: Path, *, apply: bool) -> None:
    db, operation = builder.db, builder.operation
    work = db.execute(
        "SELECT * FROM discovery_review_work WHERE operation=?", (operation,)
    ).fetchone()
    rows = db.execute(
        "SELECT position,body FROM discovery_review_files WHERE operation=? "
        "AND position>? ORDER BY position LIMIT 32",
        (operation, work["cursor"]),
    ).fetchall()
    for row in rows:
        file = json.loads(row["body"])
        if sources.inspect(root, file["path"])["generation"] != file["generation"]:
            raise ReplicaError("Files changed after review; run Update and prepare again")
    if rows:
        db.execute(
            "UPDATE discovery_review_work SET cursor=?,progress=progress+? WHERE operation=?",
            (rows[-1]["position"], len(rows), operation),
        )
        return
    if not apply:
        db.execute("SAVEPOINT revalidated_discovery_preview")
        try:
            activate(builder)
        finally:
            db.execute("ROLLBACK TO revalidated_discovery_preview")
            db.execute("RELEASE revalidated_discovery_preview")
        db.execute("UPDATE discovery_reviews SET state='ready',error=NULL WHERE id=?", (operation,))
        db.execute(
            "UPDATE discovery_review_work SET phase='ready',cursor=-1 WHERE operation=?",
            (operation,),
        )
        return
    # Final metadata-only checks fence files that changed after their earlier page was validated
    for row in db.execute(
        "SELECT body FROM discovery_review_files WHERE operation=? ORDER BY position", (operation,)
    ):
        file = json.loads(row[0])
        with open_source(root, file["path"]) as handle:
            if generation(file["path"], os.fstat(handle)) != file["generation"]:
                raise ReplicaError(
                    "Files changed during acceptance; the complete review is retained"
                )
    event = activate(builder)
    from cairndex.replicas.discovery import baseline

    for row in db.execute(
        "SELECT body FROM discovery_review_files WHERE operation=? ORDER BY position", (operation,)
    ):
        file = json.loads(row[0])
        baseline(db, file["id"], file)
        db.execute(
            "INSERT OR REPLACE INTO discovery_accepted_files VALUES (?,?,?,?)",
            (file["path"], file["generation"], file["id"], event),
        )
    db.execute(
        "UPDATE discovery_candidates SET state='accepted' WHERE state='pending' "
        "AND json_extract(body,'$.version')=2 AND NOT EXISTS "
        "(SELECT 1 FROM discovery_candidate_files f WHERE f.candidate=discovery_candidates.id "
        "AND NOT EXISTS (SELECT 1 FROM discovery_accepted_files a WHERE "
        "a.path=json_extract(f.body,'$.path') AND "
        "a.generation=json_extract(f.body,'$.generation')))"
    )
    db.execute(
        "UPDATE discovery_reviews SET state='applied',event=?,error=NULL WHERE id=?",
        (event, operation),
    )
    db.execute(
        "UPDATE discovery_review_work SET phase='applied',cursor=-1 WHERE operation=?", (operation,)
    )
