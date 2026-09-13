"""Validate private discovery evidence and retained review references before recovery"""

import json
import re
import sqlite3
from typing import Any

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas.catalog.model import validate_unit, value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_sources import file_id
from cairndex.replicas.protocol import ReplicaError, checksum


# Paths and evidence are validated even when a candidate has already been superseded
def observation(body: dict[str, Any], *, physical: bool = True) -> None:
    path = body["path"]
    if (
        not path
        or normalize_relative_path(path) != path
        or any(part.startswith(".") for part in path.split("/"))
    ):
        raise ReplicaError("Invalid private discovery path")
    validate_unit("asset_files/validation/$content", value_text(body["evidence"]))
    if physical and (
        not re.fullmatch(r"[a-f0-9]{64}", body["generation"])
        or any(type(body[name]) is not int for name in ("device", "inode", "mtime"))
    ):
        raise ReplicaError("Invalid private discovery observation")


# Every captured causal base must still be recoverable from retained immutable history
def references(db: sqlite3.Connection, events: list[str]) -> None:
    if not isinstance(events, list) or any(
        not db.execute("SELECT 1 FROM events WHERE id=?", (event,)).fetchone() for event in events
    ):
        raise ReplicaError("Private discovery review is missing its causal history")


# Validation checks private shapes and receipts without choosing newer catalog alternatives
def validate(db: sqlite3.Connection, store: CatalogStore) -> None:
    for row in db.execute("SELECT * FROM discovery_runs"):
        if (
            row["state"] not in {"running", "succeeded", "failed", "cancelled"}
            or row["phase"] not in {"walk", "known", "repair", "propose", "complete"}
            or min(row["sequence"], row["observed"], row["repaired"]) < 0
        ):
            raise ReplicaError("Unsupported discovery job state")
    for table in ("discovery_entries", "discovery_baselines", "discovery_missing"):
        for row in db.execute(f"SELECT * FROM {table}"):
            body = json.loads(row["body"])
            observation(body, physical=table != "discovery_missing" or body["automatic"])
            if table == "discovery_entries" and (
                row["path"] != body["path"]
                or row["parent"] != body["path"].rpartition("/")[0]
                or row["handled"] not in (0, 1, 2)
            ):
                raise ReplicaError("Private discovery entry is inconsistent")
            if table == "discovery_missing":
                references(db, body["basis"])
                references(db, body["content_basis"])
    for row in db.execute("SELECT * FROM discovery_identities"):
        body = {"path": row["path"], "evidence": json.loads(row["evidence"])}
        observation(body, physical=False)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", row["file_id"]) or (
            body["evidence"]["algorithm"] == "sha256"
            and row["file_id"]
            != file_id(store.descriptor.library_uuid, store.descriptor.epoch, body)
        ):
            raise ReplicaError("Private discovery identity is inconsistent")
    for row in db.execute("SELECT * FROM discovery_candidates"):
        body = json.loads(row["body"])
        if (
            body["kind"] not in {"new", "repair", "replacement"}
            or not 1 <= len(body["files"]) <= 128
            or row["state"] not in {"pending", "observed", "accepted", "superseded"}
            or row["id"] != checksum(value_text(body).encode())
            or row["path"] != body["files"][0]["path"]
        ):
            raise ReplicaError("Invalid discovery candidate")
        for file in body["files"]:
            observation(file)
        for choice in body.get("choices", []):
            observation(choice, physical=choice["automatic"])
            references(db, choice["basis"])
            references(db, choice["content_basis"])
    for row in db.execute("SELECT * FROM discovery_reviews"):
        intent = json.loads(row["intent"])
        candidate = db.execute(
            "SELECT body FROM discovery_candidates WHERE id=?", (intent["candidate"],)
        ).fetchone()
        if not candidate:
            raise ReplicaError("Private discovery review is missing its candidate")
        if row["state"] not in {
            "queued",
            "ready",
            "apply_queued",
            "applied",
            "failed",
            "cancelled",
        }:
            raise ReplicaError("Unsupported discovery review state")
        if row["state"] in {"ready", "apply_queued", "applied"} and not row["prepared"]:
            raise ReplicaError("Private discovery review is missing its preview")
        if row["prepared"]:
            prepared = json.loads(row["prepared"])
            original = json.loads(candidate[0])
            if (
                prepared["candidate"] != intent["candidate"]
                or prepared["kind"] != original["kind"]
                or not 1 <= len(prepared["files"]) <= 128
            ):
                raise ReplicaError("Private discovery preview is inconsistent")
            for file in prepared["files"]:
                observation(file)
                if not any(
                    all(file[name] == item[name] for name in ("path", "generation", "evidence"))
                    for item in original["files"]
                ):
                    raise ReplicaError("Private discovery preview changed its source selection")
            references(db, prepared["catalog"]["parents"])
            for change in prepared["catalog"]["changes"]:
                references(db, UnitChange.model_validate(change).basis)
        if (
            row["state"] == "applied"
            and not db.execute(
                "SELECT 1 FROM events WHERE id=? AND operation=?",
                (row["event"], "discover_" + checksum(row["id"].encode())[:50]),
            ).fetchone()
        ):
            raise ReplicaError("Private discovery receipt is missing its event")
