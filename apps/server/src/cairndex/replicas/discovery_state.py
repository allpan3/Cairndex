"""Private discovery queues, observations and exact review receipts"""

import json
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_plan import SCHEMA as PLAN_SCHEMA
from cairndex.replicas.discovery_plan import TABLES as PLAN_TABLES
from cairndex.replicas.discovery_preview import SCHEMA as PREVIEW_SCHEMA
from cairndex.replicas.discovery_preview import TABLES as PREVIEW_TABLES
from cairndex.replicas.discovery_proposals import SCHEMA as PROPOSAL_SCHEMA
from cairndex.replicas.discovery_proposals import TABLES as PROPOSAL_TABLES
from cairndex.replicas.discovery_verification import SCHEMA as VERIFICATION_SCHEMA
from cairndex.replicas.discovery_verification import TABLES as VERIFICATION_TABLES
from cairndex.replicas.protocol import ReplicaError, checksum

SCHEMA = """
CREATE INDEX IF NOT EXISTS discovery_path_claim ON catalog_revisions(value,active,unit);
CREATE TABLE IF NOT EXISTS discovery_runs (
    id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, state TEXT NOT NULL,
    phase TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', observed INTEGER NOT NULL DEFAULT 0,
    repaired INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS discovery_entries (
    run TEXT NOT NULL REFERENCES discovery_runs(id), path TEXT NOT NULL, parent TEXT NOT NULL,
    body TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run,path));
CREATE INDEX IF NOT EXISTS discovery_entry_pending ON discovery_entries(run,handled,path);
CREATE INDEX IF NOT EXISTS discovery_entry_parent ON discovery_entries(run,parent,path);
CREATE INDEX IF NOT EXISTS discovery_entry_evidence ON
discovery_entries(run,json_extract(body,'$.evidence.digest'));
CREATE TABLE IF NOT EXISTS discovery_missing (
    run TEXT NOT NULL REFERENCES discovery_runs(id), file_id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(run,file_id));
CREATE INDEX IF NOT EXISTS discovery_missing_evidence ON
discovery_missing(run,json_extract(body,'$.evidence.digest'));
CREATE TABLE IF NOT EXISTS discovery_baselines (
    file_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discovery_baseline_path ON
discovery_baselines(json_extract(body,'$.path'));
CREATE TABLE IF NOT EXISTS discovery_identities (
    path TEXT NOT NULL, evidence TEXT NOT NULL, file_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(path,evidence));
CREATE TABLE IF NOT EXISTS discovery_candidates (
    id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES discovery_runs(id), path TEXT NOT NULL,
    body TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discovery_candidate_state ON
discovery_candidates(state,path,id);
CREATE TABLE IF NOT EXISTS discovery_reviews (
    id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL, prepared TEXT,
    error TEXT, event TEXT);
"""
TABLES = {
    "discovery_path_claim",
    "discovery_baseline_path",
    "discovery_identities",
    "discovery_runs",
    "discovery_entries",
    "discovery_baselines",
    "discovery_candidates",
    "discovery_reviews",
    "discovery_entry_pending",
    "discovery_entry_parent",
    "discovery_candidate_state",
    "discovery_entry_evidence",
    "discovery_missing",
    "discovery_missing_evidence",
}
BASE_TABLES = set(TABLES)
SCHEMA += VERIFICATION_SCHEMA
TABLES |= VERIFICATION_TABLES
SCHEMA += PLAN_SCHEMA
TABLES |= PLAN_TABLES
SCHEMA += PROPOSAL_SCHEMA
TABLES |= PROPOSAL_TABLES
SCHEMA += PREVIEW_SCHEMA
TABLES |= PREVIEW_TABLES


# A capability fence precedes all private discovery mutations
def capable(store: CatalogStore) -> None:
    if store.descriptor.format_version != 3:
        raise ReplicaError("Update requires a discovery-capable replica package")
    status = store.status()
    if not status["ready"] or status["blocked"]:
        raise ReplicaError("Update is waiting for complete metadata or recovery")


# Stable operation IDs make lost enqueue responses harmless
def enqueue(store: CatalogStore, operation: str) -> dict[str, Any]:
    capable(store)
    with store.connection() as db:
        prior = db.execute("SELECT id FROM discovery_runs WHERE id=?", (operation,)).fetchone()
        active = db.execute("SELECT id FROM discovery_runs WHERE state='running'").fetchone()
        if not prior and active:
            operation = active[0]
        elif not prior:
            db.execute(
                "INSERT INTO discovery_runs(id,sequence,state,phase) VALUES (?, "
                "(SELECT COALESCE(MAX(sequence),0)+1 FROM discovery_runs),'running','walk')",
                (operation,),
            )
    return run(store, operation)


# Status reads a single private job and never walks the filesystem
def run(store: CatalogStore, operation: str | None = None) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT * FROM discovery_runs WHERE (? IS NULL OR id=?) ORDER BY sequence DESC LIMIT 1",
            (operation, operation),
        ).fetchone()
        return dict(row) if row else {"state": "idle"}


# Cancelling stops future worker steps and never erases candidates or saved events
def cancel(store: CatalogStore, operation: str) -> None:
    with store.connection() as db:
        db.execute(
            "UPDATE discovery_runs SET state='cancelled' WHERE id=? AND state='running'",
            (operation,),
        )


# Candidates are paginated separately from the authored catalog
def candidates(store: CatalogStore, after: str = "", limit: int = 30) -> dict[str, Any]:
    from cairndex.replicas.discovery_proposals import display

    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT * FROM discovery_candidates WHERE state='pending' AND id>? ORDER BY id LIMIT ?",
            (after, limit + 1),
        ).fetchall()
        return {
            "items": [display(db, row) for row in rows[:limit]],
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }


# The server retains the complete bounded user selection before preparing catalog changes
def prepare(store: CatalogStore, operation: str, intent: dict[str, Any]) -> dict[str, Any]:
    capable(store)
    raw = value_text(intent)
    if len(raw.encode()) > 64 * 1024:
        raise ReplicaError("Review selection exceeds the bounded batch size")
    with store.connection() as db:
        prior = db.execute(
            "SELECT intent FROM discovery_reviews WHERE id=?", (operation,)
        ).fetchone()
        if prior and prior[0] != raw:
            raise ReplicaError("Review retry identity was reused for different work")
        if prior:
            db.execute(
                "UPDATE discovery_reviews SET state='queued',error=NULL "
                "WHERE id=? AND state IN ('failed','cancelled')",
                (operation,),
            )
            db.execute(
                "UPDATE discovery_review_work SET cursor=-1,progress=0 WHERE operation=? "
                "AND EXISTS (SELECT 1 FROM discovery_reviews WHERE id=? AND prepared IS NOT NULL "
                "AND state='queued')",
                (operation, operation),
            )
        db.execute(
            "INSERT OR IGNORE INTO discovery_reviews VALUES (?,?,'queued',NULL,NULL,NULL)",
            (operation, raw),
        )
    return review(store, operation)


# A review is durable and reopening never submits it
def review(store: CatalogStore, operation: str) -> dict[str, Any]:
    from cairndex.replicas.discovery_pages import display_review

    with store.connection(readonly=True) as db:
        row = db.execute("SELECT * FROM discovery_reviews WHERE id=?", (operation,)).fetchone()
        if row is None:
            raise ReplicaError("Discovery review is unavailable")
        return display_review(
            db,
            dict(row)
            | {
                "intent": json.loads(row["intent"]),
                "prepared": json.loads(row["prepared"]) if row["prepared"] else None,
                "receipt": checksum(row["prepared"].encode()) if row["prepared"] else None,
            },
        )


# Applying requires the exact visible preview; cancellation does not touch authored history
def accept(store: CatalogStore, operation: str, receipt: str) -> dict[str, Any]:
    capable(store)
    with store.connection() as db:
        row = db.execute("SELECT * FROM discovery_reviews WHERE id=?", (operation,)).fetchone()
        if not row or not row["prepared"] or checksum(row["prepared"].encode()) != receipt:
            raise ReplicaError("The discovery review changed; reopen it")
        if row["state"] not in ("ready", "apply_queued", "applied"):
            raise ReplicaError("Revalidate the pending discovery before applying")
        db.execute(
            "UPDATE discovery_reviews SET state='apply_queued' WHERE id=? AND state='ready'",
            (operation,),
        )
        if row["state"] == "ready":
            db.execute(
                "UPDATE discovery_review_work SET cursor=-1,progress=0 WHERE operation=?",
                (operation,),
            )
    return review(store, operation)
