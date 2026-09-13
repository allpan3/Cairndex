"""Explicit complete-content verification with bounded reads and generation-bound receipts"""

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.replicas.catalog.model import validate_unit, value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_sources import inspect
from cairndex.replicas.media import generation, open_source
from cairndex.replicas.protocol import ReplicaError

SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_verifications (
    id TEXT PRIMARY KEY, candidate TEXT NOT NULL REFERENCES discovery_candidates(id),
    state TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS discovery_hash_files (
    operation TEXT NOT NULL REFERENCES discovery_verifications(id), path TEXT NOT NULL,
    original TEXT NOT NULL, state TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
    evidence TEXT, PRIMARY KEY(operation,path));
CREATE TABLE IF NOT EXISTS discovery_verified (
    path TEXT NOT NULL, generation TEXT NOT NULL, evidence TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(path,generation));
"""
TABLES = {"discovery_verifications", "discovery_hash_files", "discovery_verified"}
BLOCK_BYTES = 1024 * 1024
STEP_BYTES = 8 * BLOCK_BYTES
_active: dict[CatalogStore, tuple[str, str, int, Any]] = {}


# Closing a worker releases its pinned source and discards only an incomplete hash accumulator
def close(store: CatalogStore) -> None:
    item = _active.pop(store, None)
    if item:
        os.close(item[2])


# Hash requests refer to a retained suggestion, never arbitrary client-supplied paths
def enqueue(store: CatalogStore, operation: str, candidate: str) -> dict[str, Any]:
    from cairndex.replicas.discovery_state import capable

    capable(store)
    with store.connection() as db:
        original = db.execute(
            "SELECT body FROM discovery_candidates WHERE id=?", (candidate,)
        ).fetchone()
        if original is None:
            raise ReplicaError("Discovery candidate is unavailable")
        prior = db.execute(
            "SELECT candidate FROM discovery_verifications WHERE id=?", (operation,)
        ).fetchone()
        if prior and prior[0] != candidate:
            raise ReplicaError("Verification retry identity was reused for different files")
        if not prior:
            db.execute(
                "INSERT INTO discovery_verifications VALUES (?,?,'queued',NULL)",
                (operation, candidate),
            )
            if json.loads(original[0]).get("version") == 2:
                db.execute(
                    "INSERT INTO discovery_hash_files(operation,path,original,state) "
                    "SELECT ?,json_extract(body,'$.path'),body,'queued' "
                    "FROM discovery_candidate_files WHERE candidate=?",
                    (operation, candidate),
                )
            else:
                db.execute(
                    "INSERT INTO discovery_hash_files(operation,path,original,state) "
                    "SELECT ?,json_extract(value,'$.path'),value,'queued' "
                    "FROM json_each(?, '$.files')",
                    (operation, original[0]),
                )
            # Small candidates already contain complete hashes; worker generation checks trust them
            db.execute(
                "UPDATE discovery_hash_files SET state='verified',"
                "offset=json_extract(original,'$.evidence.size'),"
                "evidence=json_extract(original,'$.evidence') WHERE operation=? "
                "AND json_extract(original,'$.evidence.algorithm')='sha256' "
                "AND json_extract(original,'$.evidence.size')<=196608",
                (operation,),
            )
        else:
            db.execute(
                "UPDATE discovery_verifications SET state='queued',error=NULL "
                "WHERE id=? AND state IN ('failed','cancelled','succeeded')",
                (operation,),
            )
    return status(store, operation)


# Progress is durable and computes only indexed job rows, without inspecting source media
def status(store: CatalogStore, operation: str) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT * FROM discovery_verifications WHERE id=?", (operation,)
        ).fetchone()
        if row is None:
            raise ReplicaError("Content verification is unavailable")
        counts = db.execute(
            "SELECT COUNT(*) AS files,COALESCE(SUM(state='verified'),0) AS verified,"
            "COALESCE(SUM(offset),0) AS bytes_read,"
            "COALESCE(SUM(json_extract(original,'$.evidence.size')),0) AS total_bytes "
            "FROM discovery_hash_files WHERE operation=?",
            (operation,),
        ).fetchone()
        return dict(row) | dict(counts)


# Cancellation retains complete receipts but never promotes an incomplete digest
def cancel(store: CatalogStore, operation: str) -> None:
    with store.connection() as db:
        db.execute(
            "UPDATE discovery_verifications SET state='cancelled' WHERE id=? "
            "AND state IN ('queued','running')",
            (operation,),
        )


# Cached full evidence is valid only for exactly the observed source generation
def evidence(db: sqlite3.Connection, observation: dict[str, Any]) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT evidence FROM discovery_verified WHERE path=? AND generation=? AND trusted=1",
        (observation["path"], observation["generation"]),
    ).fetchone()
    return json.loads(row[0]) if row else None


# Complete hashes replace samples only after the pinned descriptor and current path both agree
def step(store: CatalogStore, root: Path, operation: str) -> None:
    with store.connection(readonly=True) as db:
        file = db.execute(
            "SELECT * FROM discovery_hash_files WHERE operation=? AND state<>'verified' "
            "ORDER BY path LIMIT 1",
            (operation,),
        ).fetchone()
    if file is None:
        close(store)
        # Restored receipts remain historic until this device reopens their exact generations
        with store.connection() as db:
            restored = db.execute(
                "SELECT f.path,f.original,f.evidence FROM discovery_hash_files f "
                "LEFT JOIN discovery_verified v ON v.path=f.path AND "
                "v.generation=json_extract(f.original,'$.generation') "
                "WHERE f.operation=? AND COALESCE(v.trusted,0)=0 ORDER BY f.path LIMIT 32",
                (operation,),
            ).fetchall()
            for row in restored:
                original = json.loads(row["original"])
                with open_source(root, row["path"]) as current:
                    if generation(row["path"], os.fstat(current)) != original["generation"]:
                        raise ReplicaError("Restored verification source changed; run Update again")
                db.execute(
                    "INSERT OR REPLACE INTO discovery_verified VALUES (?,?,?,1)",
                    (row["path"], original["generation"], row["evidence"]),
                )
        if restored:
            return
        with store.connection() as db:
            db.execute(
                "UPDATE discovery_verifications SET state='succeeded',error=NULL "
                "WHERE id=? AND state IN ('queued','running')",
                (operation,),
            )
        return
    original = json.loads(file["original"])
    path, expected = file["path"], original["generation"]
    item = _active.get(store)
    if item is None or item[:2] != (operation, path):
        close(store)
        with open_source(root, path) as source:
            if generation(path, os.fstat(source)) != expected:
                raise ReplicaError("Source changed before complete verification; run Update again")
            handle = os.dup(source)
        _active[store] = operation, path, handle, hashlib.sha256()
        # Hashlib state is deliberately not deserialized; interrupted files restart from byte zero
        with store.connection() as db:
            db.execute(
                "UPDATE discovery_hash_files SET offset=0,state='running',evidence=NULL "
                "WHERE operation=? AND path=?",
                (operation, path),
            )
        offset = 0
    else:
        offset = file["offset"]
    _, _, handle, digest = _active[store]
    if generation(path, os.fstat(handle)) != expected:
        raise ReplicaError("Source changed during complete verification; run Update again")
    size, consumed, deadline = original["evidence"]["size"], 0, time.monotonic() + 0.05
    while offset < size and consumed < STEP_BYTES:
        count = min(BLOCK_BYTES, size - offset)
        data = os.pread(handle, count, offset)
        if len(data) != count:
            raise ReplicaError("Source delivery is incomplete; complete verification is pending")
        digest.update(data)
        offset += count
        consumed += count
        if time.monotonic() >= deadline:
            break
    complete = offset == size
    if generation(path, os.fstat(handle)) != expected:
        raise ReplicaError("Source changed during complete verification; run Update again")
    result = {"algorithm": "sha256", "size": size, "digest": digest.hexdigest()}
    if complete:
        with open_source(root, path) as current:
            if generation(path, os.fstat(current)) != expected:
                raise ReplicaError("The verified path was replaced; run Update again")
    with store.connection() as db:
        active = db.execute(
            "SELECT state FROM discovery_verifications WHERE id=?", (operation,)
        ).fetchone()
        if not active or active[0] not in ("queued", "running"):
            close(store)
            return
        db.execute("UPDATE discovery_verifications SET state='running' WHERE id=?", (operation,))
        db.execute(
            "UPDATE discovery_hash_files SET offset=?,state=?,evidence=? "
            "WHERE operation=? AND path=?",
            (
                offset,
                "verified" if complete else "running",
                value_text(result) if complete else None,
                operation,
                path,
            ),
        )
        if complete:
            db.execute(
                "INSERT OR REPLACE INTO discovery_verified VALUES (?,?,?,1)",
                (path, expected, value_text(result)),
            )
    if complete:
        close(store)


# One bounded read step runs outside request handlers and yields before metadata exchange
def tick(store: CatalogStore, root: Path) -> bool:
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT id FROM discovery_verifications WHERE state IN ('queued','running') "
            "ORDER BY id LIMIT 1"
        ).fetchone()
    if row is None:
        close(store)
        return False
    try:
        step(store, root, row[0])
    except (OSError, ValueError, DomainError) as error:
        close(store)
        with store.connection() as db:
            db.execute(
                "UPDATE discovery_verifications SET state='failed',error=? "
                "WHERE id=? AND state IN ('queued','running')",
                (
                    error.message
                    if isinstance(error, DomainError)
                    else "Source is unavailable; retry complete verification when it can be read",
                    row[0],
                ),
            )
    return True


# A verified candidate keeps its source observation while upgrading portable content evidence
def verified_file(db: sqlite3.Connection, root: Path, file: dict[str, Any]) -> dict[str, Any]:
    observed = inspect(root, file["path"])
    if observed["generation"] != file["generation"]:
        raise ReplicaError("The source changed after verification; run Update again")
    full = evidence(db, observed)
    if full is None:
        raise ReplicaError("Complete content verification is required for these files")
    return file | {"evidence": full, "sample": observed["evidence"]}


# Recovery treats receipts as historic proof and rejects invented progress or source selections
def validate(db: sqlite3.Connection) -> None:
    from cairndex.replicas.discovery_validation import observation

    for job in db.execute("SELECT * FROM discovery_verifications"):
        if job["state"] not in {"queued", "running", "succeeded", "failed", "cancelled"}:
            raise ReplicaError("Unsupported content verification state")
        candidate = db.execute(
            "SELECT body FROM discovery_candidates WHERE id=?", (job["candidate"],)
        ).fetchone()
        if candidate is None:
            raise ReplicaError("Content verification is missing its candidate")
        count = 0
        for file in db.execute(
            "SELECT * FROM discovery_hash_files WHERE operation=?", (job["id"],)
        ):
            count += 1
            original = json.loads(file["original"])
            observation(original)
            if json.loads(candidate[0]).get("version") == 2:
                selected = db.execute(
                    "SELECT 1 FROM discovery_candidate_files WHERE candidate=? AND body=?",
                    (job["candidate"], file["original"]),
                ).fetchone()
            else:
                selected = db.execute(
                    "SELECT 1 FROM json_each(?,'$.files') WHERE value=?",
                    (candidate[0], file["original"]),
                ).fetchone()
            if (
                file["path"] != original["path"]
                or file["state"] not in {"queued", "running", "verified"}
                or not 0 <= file["offset"] <= original["evidence"]["size"]
                or not selected
            ):
                raise ReplicaError("Invalid content verification source or progress")
            if file["state"] == "verified":
                if file["offset"] != original["evidence"]["size"] or not file["evidence"]:
                    raise ReplicaError("Content verification is missing complete evidence")
                validate_unit("asset_files/verification/$content", file["evidence"])
                full = json.loads(file["evidence"])
                if full["algorithm"] != "sha256" or full["size"] != file["offset"]:
                    raise ReplicaError("Content verification evidence is inconsistent")
            elif job["state"] == "succeeded":
                raise ReplicaError("Content verification completed with unfinished files")
        original_candidate = json.loads(candidate[0])
        expected_count = original_candidate.get("file_count", len(original_candidate["files"]))
        if not count or count != expected_count:
            raise ReplicaError("Content verification is missing part of its source selection")
    for row in db.execute("SELECT * FROM discovery_verified"):
        validate_unit("asset_files/verification/$content", row["evidence"])
        if (
            row["trusted"] not in (0, 1)
            or not db.execute(
                "SELECT 1 FROM discovery_hash_files WHERE path=? AND "
                "json_extract(original,'$.generation')=? AND evidence=? AND state='verified'",
                (row["path"], row["generation"], row["evidence"]),
            ).fetchone()
        ):
            raise ReplicaError("Private verified evidence is missing its complete receipt")
