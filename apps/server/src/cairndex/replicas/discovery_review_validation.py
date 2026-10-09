"""Recovery validates normalized selections, complete private transactions and source receipts"""

import hashlib
import json
import sqlite3
from itertools import zip_longest
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.protocol import Root, decode, payload
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, canonical, checksum


# Normalized candidate headers bind every group and file independently of transport page boundaries
def candidate(db: sqlite3.Connection, row: sqlite3.Row, body: dict[str, Any]) -> None:
    from cairndex.replicas.discovery_validation import observation

    if (
        body["kind"] not in {"new", "collection"}
        or body["files"] != []
        or body["file_count"] < 1
        or row["id"] != checksum(value_text(body).encode())
        or row["state"] not in {"building", "pending", "accepted", "superseded", "observed"}
    ):
        raise ReplicaError("Invalid normalized discovery candidate")
    digest, count = hashlib.sha256(), 0
    for file in db.execute(
        "SELECT * FROM discovery_candidate_files WHERE candidate=? ORDER BY position", (row["id"],)
    ):
        original = json.loads(file["body"])
        observation(original)
        if (
            file["position"] != count
            or not db.execute(
                "SELECT 1 FROM discovery_candidate_groups WHERE candidate=? AND id=?",
                (row["id"], file["group_id"]),
            ).fetchone()
            or count == 0
            and row["path"] != original["path"]
        ):
            raise ReplicaError("Normalized discovery source ordering is inconsistent")
        digest.update(value_text([file["group_id"], original]).encode() + b"\n")
        count += 1
    if (
        count > body["file_count"]
        or row["state"] != "building"
        and (count != body["file_count"] or digest.hexdigest() != body["files_digest"])
    ):
        raise ReplicaError("Normalized discovery candidate is incomplete")
    digest = hashlib.sha256()
    for group in db.execute(
        "SELECT body FROM discovery_candidate_groups WHERE candidate=? "
        "ORDER BY json_extract(body,'$.directory'),id",
        (row["id"],),
    ):
        digest.update(group[0].encode() + b"\n")
    if digest.hexdigest() != body["groups_digest"]:
        raise ReplicaError("Normalized discovery grouping context changed")


# Verified full content can replace only the original sample for the same pinned source generation
def source(
    db: sqlite3.Connection, intent: dict[str, Any], original: dict[str, Any], file: dict[str, Any]
) -> None:
    from cairndex.replicas.discovery_validation import observation

    observation(file)
    if any(
        file[name] != original[name] for name in ("path", "generation", "mtime", "device", "inode")
    ):
        raise ReplicaError("Private discovery preview changed its source generation")
    if file["evidence"] != original["evidence"] and not (
        file.get("sample") == original["evidence"]
        and db.execute(
            "SELECT 1 FROM discovery_hash_files WHERE operation=? AND path=? AND original IS "
            "NOT NULL "
            "AND state='verified' AND evidence=? AND json_extract(original,'$.generation')=?",
            (
                intent.get("verification"),
                file["path"],
                value_text(file["evidence"]),
                file["generation"],
            ),
        ).fetchone()
    ):
        raise ReplicaError("Private discovery preview changed its content evidence")


# Prepared values retain complete bases and reproduce the exact immutable payload and retry intent
def review(db: sqlite3.Connection, store: CatalogStore, row: sqlite3.Row) -> None:
    from cairndex.replicas.discovery_commit import catalog_intent, sources_digest
    from cairndex.replicas.discovery_preview import DiscoveryPreview
    from cairndex.replicas.discovery_validation import references

    operation, intent = row["id"], json.loads(row["intent"])
    work = db.execute(
        "SELECT * FROM discovery_review_work WHERE operation=?", (operation,)
    ).fetchone()
    if work is None:
        if row["prepared"]:
            raise ReplicaError("Private discovery preparation is missing its work")
        return
    original = db.execute(
        "SELECT body FROM discovery_candidates WHERE id=?", (intent["candidate"],)
    ).fetchone()[0]
    if (
        work["header"] != original
        or work["phase"]
        not in {
            "copy",
            "verify",
            "groups",
            "files",
            "extras",
            "guards",
            "finish",
            "ready",
            "applied",
        }
        or work["total"] < 1
        or work["progress"] < 0
    ):
        raise ReplicaError("Invalid private discovery preparation state")
    references(db, json.loads(work["parents"]))
    count = 0
    for file in db.execute(
        "SELECT * FROM discovery_review_files WHERE operation=? ORDER BY position", (operation,)
    ):
        count += 1
        item = db.execute(
            "SELECT body,group_id FROM discovery_candidate_files WHERE candidate=? AND position=?",
            (intent["candidate"], file["position"]),
        ).fetchone()
        if not item or item["body"] != file["original"] or item["group_id"] != file["group_id"]:
            raise ReplicaError("Private discovery selection differs from its candidate")
        if file["body"]:
            source(db, intent, json.loads(file["original"]), json.loads(file["body"]))
    builder = DiscoveryPreview(store, db, operation)
    digest, changes = hashlib.sha256(), 0
    for change in builder.changes():
        references(db, change.basis)
        digest.update(canonical(change.model_dump()) + b"\n")
        changes += 1
    if not row["prepared"]:
        return
    prepared = json.loads(row["prepared"])
    if (
        set(prepared)
        != {
            "version",
            "candidate",
            "kind",
            "title",
            "target",
            "file_count",
            "group_count",
            "old",
            "catalog",
            "sources_digest",
        }
        or prepared["version"] != 2
        or prepared["candidate"] != intent["candidate"]
        or prepared["kind"] != json.loads(original)["kind"]
        or prepared["file_count"] != count
        or prepared["sources_digest"] != sources_digest(db, operation)
        or prepared["catalog"]["changes_digest"] != digest.hexdigest()
        or prepared["catalog"]["change_count"] != changes
        or prepared["catalog"]["parents"] != json.loads(work["parents"])
    ):
        raise ReplicaError("Private discovery preview receipt changed")
    commit = db.execute(
        "SELECT intent FROM discovery_review_commit WHERE operation=?", (operation,)
    ).fetchone()
    if not commit or commit[0] != catalog_intent(builder, work["parents"]):
        raise ReplicaError("Private discovery retry intent changed")
    last = db.execute(
        "SELECT raw FROM discovery_review_parts WHERE operation=? ORDER BY sequence DESC LIMIT 1",
        (operation,),
    ).fetchone()
    if last is None:
        raise ReplicaError("Private discovery preview has no complete transaction")
    _, root = decode(last[0], store.descriptor)
    if not isinstance(root, Root):
        raise ReplicaError("Private discovery preview has no complete root")
    expected = payload(
        builder.changes(),
        library=store.descriptor.library_uuid,
        epoch=store.descriptor.epoch,
        replica=root.replica,
        operation="discover_" + checksum(operation.encode())[:50],
        parents=json.loads(work["parents"]),
    )
    actual = db.execute(
        "SELECT id,raw FROM discovery_review_parts WHERE operation=? ORDER BY sequence",
        (operation,),
    )
    for stored, wanted in zip_longest(actual, expected):
        if stored is None or wanted is None or tuple(stored) != wanted:
            raise ReplicaError("Private discovery transaction differs from its reviewed values")
