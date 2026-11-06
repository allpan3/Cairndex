"""Private exact source-operation intent, reviews and restart state."""

import json
from typing import Any, Literal

from pydantic import Field

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import Digest, ReplicaError, StrictModel, Token, checksum

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_operations (
    id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
    review TEXT, result TEXT, phase TEXT NOT NULL, progress INTEGER NOT NULL,
    error TEXT, sequence INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS source_operation_state ON source_operations(state,sequence);
CREATE UNIQUE INDEX IF NOT EXISTS source_operation_sequence ON source_operations(sequence);
CREATE TABLE IF NOT EXISTS source_receipts (
    id TEXT PRIMARY KEY, raw TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS source_uploads (
    id TEXT PRIMARY KEY, size INTEGER NOT NULL, state TEXT NOT NULL, evidence TEXT);
"""
TABLES = {
    "source_operations",
    "source_operation_state",
    "source_operation_sequence",
    "source_receipts",
    "source_uploads",
}


class SourceRequest(StrictModel):
    operation: Token
    action: Literal["copy", "rename", "move", "trash", "undo", "restore", "mkdir"]
    source: str = Field(default="", max_length=4096)
    destination: str = Field(default="", max_length=4096)
    collision: Literal["fail", "skip", "suffix", "replace"] = "fail"
    prior: Token | None = None
    upload: Token | None = None
    version: Literal["source", "destination", "output"] = "source"
    byte_limit: int = Field(default=128 * 1024**3, ge=1, le=1024**4)


class SourceAccept(StrictModel):
    receipt: Digest


class SourceJob(StrictModel):
    id: str
    action: str
    state: str
    phase: str
    progress: int
    review: dict[str, Any] | None
    result: dict[str, Any] | None
    error: str | None
    receipt: str | None
    request: SourceRequest


class SourcePage(StrictModel):
    items: list[SourceJob]
    next_cursor: int | None


def enqueue(store: CatalogStore, request: SourceRequest) -> SourceJob:
    """A retry cannot change a source, collision choice or byte budget."""
    if store.descriptor.format_version != 3:
        raise ReplicaError("Source operations require the complete discovery catalog")
    intent = value_text(request.model_dump(mode="json"))
    with store.connection() as db:
        prior = db.execute(
            "SELECT intent FROM source_operations WHERE id=?", (request.operation,)
        ).fetchone()
        if prior and prior[0] != intent:
            raise ReplicaError("Source operation identity was reused for different intent")
        if not prior:
            # Different editor instances must not queue overlapping namespace
            # mutations against a path an unfinished operation may already own.
            for path in {request.source, request.destination} - {""}:
                occupied = db.execute(
                    "SELECT DISTINCT o.id,o.state,o.phase,o.error,o.result,"
                    "json_extract(o.intent,'$.action') AS action "
                    "FROM source_operations o, json_each(o.intent) p "
                    "WHERE o.state IN ('queued','preparing','prepared','accepted',"
                    "'applying','interrupted') AND p.key IN ('source','destination') "
                    "AND p.value!='' AND (p.value=? OR substr(p.value,1,length(?)+1)=?||'/' "
                    "OR substr(?,1,length(p.value)+1)=p.value||'/')",
                    (path, path, path, path),
                )
                for other in occupied:
                    # Earlier clients hid these refused names without always
                    # cancelling the journal row. They changed no source names
                    # and must not reserve a location indefinitely.
                    if (
                        other["action"] in {"rename", "mkdir"}
                        and other["state"] == "interrupted"
                        and other["phase"] == "prepare"
                        and not json.loads(other["result"] or "{}").get("started")
                        and other["error"]
                        in {
                            "Destination exists; choose Replace, Skip or Keep Both",
                            "Folder name is already in use; choose another name",
                            "Folder path has catalog entries; choose another name",
                        }
                    ):
                        db.execute(
                            "UPDATE source_operations SET state='cancelled' WHERE id=?",
                            (other["id"],),
                        )
                        continue
                    raise ReplicaError(
                        "An unfinished file operation uses this location. "
                        "Finish or cancel that operation before starting another."
                    )
        db.execute(
            "INSERT OR IGNORE INTO source_operations VALUES "
            "(?,?,'queued',NULL,NULL,'prepare',0,NULL,"
            "(SELECT COALESCE(MAX(sequence),0)+1 FROM source_operations))",
            (request.operation, intent),
        )
    return job(store, request.operation)


def job(store: CatalogStore, operation: str) -> SourceJob:
    with store.connection(readonly=True) as db:
        row = db.execute("SELECT * FROM source_operations WHERE id=?", (operation,)).fetchone()
        if row is None:
            raise ReplicaError("Source operation is unavailable")
        return SourceJob(
            id=operation,
            action=json.loads(row["intent"])["action"],
            state=row["state"],
            phase=row["phase"],
            progress=row["progress"],
            review=json.loads(row["review"]) if row["review"] else None,
            result=json.loads(row["result"]) if row["result"] else None,
            error=row["error"],
            receipt=checksum(row["review"].encode()) if row["review"] else None,
            request=SourceRequest.model_validate_json(row["intent"]),
        )


def listing(store: CatalogStore, after: int = 0, limit: int = 30) -> SourcePage:
    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT id,sequence FROM source_operations WHERE (?=0 OR sequence<?) "
            "ORDER BY sequence DESC LIMIT ?",
            (after, after, limit + 1),
        ).fetchall()
    return SourcePage(
        items=[
            job(store, row["id"]).model_copy(update={"review": None, "result": None})
            for row in rows[:limit]
        ],
        next_cursor=rows[limit - 1]["sequence"] if len(rows) > limit else None,
    )


def accept(store: CatalogStore, operation: str, receipt: str) -> SourceJob:
    """Accept only the original byte and metadata review; do not refresh its basis."""
    with store.connection() as db:
        row = db.execute(
            "SELECT state,review FROM source_operations WHERE id=?", (operation,)
        ).fetchone()
        if not row or not row["review"] or checksum(row["review"].encode()) != receipt:
            raise ReplicaError("The source operation review changed")
        if row["state"] == "prepared":
            db.execute(
                "UPDATE source_operations SET state='accepted',phase='apply' WHERE id=?",
                (operation,),
            )
        elif row["state"] not in ("accepted", "applying", "succeeded"):
            raise ReplicaError("This source operation requires recovery or a new review")
    return job(store, operation)


def cancel(store: CatalogStore, operation: str) -> None:
    """Request cancellation before application; never abandon a captured original."""
    with store.connection() as db:
        db.execute(
            "UPDATE source_operations SET state='cancelled' WHERE id=? "
            "AND state IN ('queued','preparing','prepared','accepted','applying','interrupted') "
            "AND COALESCE(json_extract(result,'$.started'),0)=0",
            (operation,),
        )
        row = db.execute("SELECT state FROM source_operations WHERE id=?", (operation,)).fetchone()
        if row and row[0] not in {"cancelled", "succeeded"}:
            raise ReplicaError("Files have already changed; finish recovery before cancelling")


def retain_version(
    store: CatalogStore,
    operation: str,
    path: str,
    version: str,
    evidence: dict[str, Any],
    *,
    version_operation: str | None = None,
) -> None:
    """Expose completed preparation versions even when later review or application stops."""
    with store.connection() as db:
        row = db.execute("SELECT result FROM source_operations WHERE id=?", (operation,)).fetchone()
        result = json.loads(row[0]) if row and row[0] else {}
        versions = result.setdefault("retained_versions", {})
        value = {
            "operation": version_operation or operation,
            "version": version,
            "evidence": evidence,
        }
        if path in versions and versions[path] != value:
            raise ReplicaError("Retained version differs from the original operation")
        versions[path] = value
        db.execute(
            "UPDATE source_operations SET result=? WHERE id=?", (value_text(result), operation)
        )


def retry(store: CatalogStore, operation: str) -> SourceJob:
    """Resume the exact saved phase after interruption, without new write intent."""
    with store.connection() as db:
        db.execute(
            "UPDATE source_operations SET state=CASE WHEN phase='prepare' THEN 'queued' "
            "ELSE 'accepted' END,error=NULL,"
            "result=CASE WHEN result IS NULL THEN NULL "
            "ELSE json_remove(result,'$.storage_failure') END "
            "WHERE id=? AND state='interrupted'",
            (operation,),
        )
    return job(store, operation)
