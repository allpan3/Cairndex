"""Disk-backed grouping drafts; source observations and authored catalog stay separate."""

import json
import sqlite3
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_state import capable
from cairndex.replicas.protocol import ReplicaError

RECOVERED_EDIT_ERROR = "Recovered grouping edit; resume its exact saved intent explicitly"


def open_workspace(store: CatalogStore, run: str) -> dict[str, Any]:
    capable(store)
    with store.connection() as db:
        source = db.execute("SELECT state FROM discovery_runs WHERE id=?", (run,)).fetchone()
        if not source or source[0] != "succeeded":
            raise ReplicaError("Finish Update before reviewing its grouping suggestions")
        parents = [
            row[0] for row in db.execute("SELECT event FROM catalog_frontier ORDER BY event")
        ]
        db.execute(
            "INSERT OR IGNORE INTO grouping_workspaces(id,state,phase,parents) "
            "VALUES (?,'building','nodes',?)",
            (run, value_text(parents)),
        )
    return status(store, run)


def workspaces(store: CatalogStore, after: int | None = None, limit: int = 20) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT w.id,w.state,w.phase,w.files,w.selected,w.bundles,w.revision,"
            "w.accepting,r.sequence "
            "FROM grouping_workspaces w JOIN discovery_runs r ON r.id=w.id "
            "WHERE (? IS NULL OR r.sequence<?) ORDER BY r.sequence DESC LIMIT ?",
            (after, after, limit + 1),
        ).fetchall()
        available = db.execute(
            "SELECT id FROM discovery_runs WHERE state='succeeded' ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
        return {
            "items": [dict(row) for row in rows[:limit]],
            "next_cursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
            "available_run": available[0] if available else None,
        }


def status(store: CatalogStore, workspace: str) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute("SELECT * FROM grouping_workspaces WHERE id=?", (workspace,)).fetchone()
        if not row:
            raise ReplicaError("Grouping draft is unavailable; finish Update and open review")
        result = {
            name: row[name]
            for name in (
                "id",
                "state",
                "phase",
                "revision",
                "accepting",
                "error",
                "files",
                "selected",
                "bundles",
            )
        }
        result["uncertain"] = db.execute(
            "SELECT count(*) FROM grouping_nodes n WHERE workspace=? AND kind='bundle' "
            "AND confidence<0.75 AND EXISTS (SELECT 1 FROM grouping_files f "
            "WHERE f.workspace=n.workspace AND f.node=n.id)",
            (workspace,),
        ).fetchone()[0]
        command = db.execute(
            "SELECT id FROM grouping_commands WHERE workspace=? "
            "AND state IN ('queued','running','paused') "
            "ORDER BY sequence LIMIT 1",
            (workspace,),
        ).fetchone()
        result["command"] = command[0] if command else None
        return result


def refresh_counts(db: sqlite3.Connection, workspace: str) -> None:
    """Count on a completed edit, keeping status polling independent of draft size."""
    counts = db.execute(
        "SELECT count(*) AS files,coalesce(sum(selected),0) AS selected,"
        "count(DISTINCT node) AS bundles FROM grouping_files WHERE workspace=?",
        (workspace,),
    ).fetchone()
    db.execute(
        "UPDATE grouping_workspaces SET files=?,selected=?,bundles=? WHERE id=?",
        (*tuple(counts), workspace),
    )


def enqueue(
    store: CatalogStore,
    workspace: str,
    operation: str,
    revision: int,
    intent: dict[str, Any],
) -> dict[str, Any]:
    raw = value_text(intent)
    if len(raw.encode()) > 1024 * 1024:
        raise ReplicaError("Grouping edit is too large")
    with store.connection() as db:
        prior = db.execute(
            "SELECT workspace,revision,intent FROM grouping_commands WHERE id=?",
            (operation,),
        ).fetchone()
        if prior and tuple(prior) != (workspace, revision, raw):
            raise ReplicaError("Retry identity was reused for a different grouping edit")
        db.execute(
            "INSERT OR IGNORE INTO grouping_commands(id,workspace,revision,intent,state,phase,"
            "sequence) VALUES (?,?,?,?,'queued','edit',"
            "(SELECT coalesce(max(sequence),0)+1 FROM grouping_commands))",
            (operation, workspace, revision, raw),
        )
    return command(store, operation)


def command(store: CatalogStore, operation: str) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        row = db.execute("SELECT * FROM grouping_commands WHERE id=?", (operation,)).fetchone()
        if not row:
            raise ReplicaError("Grouping edit is unavailable")
        return {name: row[name] for name in ("id", "workspace", "state", "phase", "error")} | {
            "result": json.loads(row["result"]) if row["result"] else None,
        }


def pause_recovered(db: sqlite3.Connection) -> None:
    db.execute(
        "UPDATE grouping_commands SET state='paused',error=? WHERE state IN ('queued','running')",
        (RECOVERED_EDIT_ERROR,),
    )


def retry(store: CatalogStore, operation: str) -> dict[str, Any]:
    capable(store)
    with store.connection() as db:
        row = db.execute("SELECT * FROM grouping_commands WHERE id=?", (operation,)).fetchone()
        if not row:
            raise ReplicaError("Retained grouping edit is unavailable")
        if row["state"] == "paused":
            if row["phase"] == "verification":
                from cairndex.replicas.discovery_verification import enqueue_in

                enqueue_in(db, operation, json.loads(row["result"])["candidate"])
            db.execute(
                "UPDATE grouping_commands SET state='queued',error=NULL WHERE id=?", (operation,)
            )
        elif row["state"] not in {"queued", "running", "succeeded"}:
            raise ReplicaError("This edit was refused; revise the saved grouping draft")
    return command(store, operation)
