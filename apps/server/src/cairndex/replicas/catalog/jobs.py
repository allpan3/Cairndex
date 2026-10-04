"""Durable catalog jobs keep structural preparation and large saves outside HTTP handlers"""

import json
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, checksum


# Queuing is bounded and idempotent; a request never scans the catalog or reconstructs history
def enqueue(
    store: CatalogStore, operation: str, action: str, body: dict[str, Any]
) -> dict[str, Any]:
    intent = value_text({"action": action, "body": body})
    if (
        action not in ("save", "preview", "commit_preview", "recover")
        or len(intent.encode()) > 1024 * 1024
    ):
        raise ReplicaError("Unsupported or oversized catalog job")
    with store.connection() as db:
        prior = db.execute("SELECT intent FROM catalog_jobs WHERE id=?", (operation,)).fetchone()
        if prior and prior[0] != intent:
            raise ReplicaError("Retry identity was reused for a different catalog job")
        db.execute(
            "INSERT OR IGNORE INTO catalog_jobs VALUES (?, ?, 'queued', NULL, NULL, "
            "(SELECT COALESCE(MAX(sequence),0)+1 FROM catalog_jobs))",
            (operation, intent),
        )
    return job(store, operation)


# Job receipts distinguish queue durability from a completed local metadata save
def job(store: CatalogStore, operation: str) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute("SELECT * FROM catalog_jobs WHERE id=?", (operation,)).fetchone()
        if row is None:
            raise ReplicaError("Catalog job is unavailable")
        return {
            "id": operation,
            "action": json.loads(row["intent"])["action"],
            "state": row["state"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "error": row["error"],
            "receipt": checksum(row["result"].encode()) if row["result"] else None,
        }


# Recent durable intent stays discoverable even if the browser lost the original response
def listing(store: CatalogStore, after: int = 0, limit: int = 30) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT id,sequence,state,error,json_extract(intent,'$.action') AS action "
            "FROM catalog_jobs WHERE (?=0 OR sequence<?) "
            "ORDER BY sequence DESC LIMIT ?",
            (after, after, limit + 1),
        ).fetchall()
        items = []
        for row in rows[:limit]:
            items.append(
                {name: row[name] for name in ("id", "action", "state", "error")}
                | {"result": None, "receipt": None}
            )
        return {
            "items": items,
            "next_cursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
        }


# Only the server worker executes a job; queued work remains retryable after abrupt exits
def run_one(store: CatalogStore) -> None:
    with store.connection() as db:
        row = db.execute(
            "SELECT id,intent FROM catalog_jobs WHERE state='queued' ORDER BY sequence LIMIT 1"
        ).fetchone()
        if row is not None:
            db.execute("UPDATE catalog_jobs SET state='running' WHERE id=?", (row["id"],))
    if row is None:
        return
    operation, intent = row["id"], json.loads(row["intent"])
    action, body = intent["action"], intent["body"]
    try:
        if action == "preview":
            result = preview(store, body)
        elif action == "recover":
            from cairndex.replicas.catalog.recovery import recover_preview

            result = recover_preview(store, body["event"], body["family"], body["entity"])
        else:
            if action == "commit_preview":
                prepared = job(store, body["job"])
                if prepared["state"] != "succeeded" or prepared["receipt"] != body["receipt"]:
                    raise ReplicaError("The reviewed catalog preview changed")
                body = prepared["result"]
            if set(body) != {"changes", "parents", "resolve", "recover"}:
                raise ReplicaError("Complete observed save intent is required")
            result = {
                "event": store.save(
                    [UnitChange.model_validate(change) for change in body["changes"]],
                    operation,
                    parents=body["parents"],
                    resolve=body["resolve"],
                    recover=body["recover"],
                )
            }
        raw, state, error = value_text(result), "succeeded", None
    except (DomainError, ValueError, KeyError, TypeError) as failure:
        raw, state = None, "failed"
        error = (
            failure.message
            if isinstance(failure, DomainError)
            else "Invalid catalog operation; private draft retained"
        )
    with store.connection() as db:
        db.execute(
            "UPDATE catalog_jobs SET state=?,result=?,error=? WHERE id=?",
            (state, raw, error, operation),
        )


# Cancel only queued work; saved events and completed previews remain durably discoverable
def cancel(store: CatalogStore, operation: str) -> None:
    with store.connection() as db:
        db.execute(
            "UPDATE catalog_jobs SET state='cancelled' WHERE id=? AND state='queued'", (operation,)
        )
