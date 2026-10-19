"""Resume private review edits without publishing any catalog or source operation."""

import json
import sqlite3

from cairndex.core.errors import DomainError
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.grouping import (
    edits,
    initialize,
    pages,
    reconcile,
    regroup,
    roles,
    snapshot,
    storage,
)
from cairndex.replicas.protocol import ReplicaError


def finish(db: sqlite3.Connection, command: sqlite3.Row) -> None:
    workspace = command["workspace"]
    storage.refresh_counts(db, workspace)
    db.execute(
        "UPDATE grouping_workspaces SET state='ready',phase='ready',revision=revision+1 WHERE id=?",
        (workspace,),
    )
    revision = db.execute(
        "SELECT revision FROM grouping_workspaces WHERE id=?", (workspace,)
    ).fetchone()[0]
    db.execute(
        "UPDATE grouping_commands SET state='succeeded',phase='done',result=?,error=NULL "
        "WHERE id=?",
        (value_text({"revision": revision}), command["id"]),
    )


def step(store: CatalogStore) -> bool:
    with store.connection() as db:
        if reconcile.step(db):
            return True
        building = db.execute(
            "SELECT id FROM grouping_workspaces WHERE state='building' ORDER BY rowid LIMIT 1"
        ).fetchone()
        if building:
            initialize.step(db, building[0])
            return True
        command = db.execute(
            "SELECT * FROM grouping_commands WHERE state IN ('queued','running') "
            "ORDER BY sequence LIMIT 1"
        ).fetchone()
        if not command:
            return False
        db.execute("SAVEPOINT grouping_edit")
        try:
            if command["phase"] == "edit":
                workspace = pages.current(db, command["workspace"], command["revision"])
                intent = json.loads(command["intent"])
                if intent.get("action") == "cancel_review":
                    reconcile.cancel(db, workspace, intent)
                    finish(db, command)
                    db.execute("RELEASE grouping_edit")
                    return True
                if workspace["accepting"]:
                    raise ReplicaError("Finish the pending acceptance before editing its draft")
                if intent.get("action") == "prepare":
                    snapshot.begin(db, command)
                    db.execute("RELEASE grouping_edit")
                    return True
                if intent.get("action") == "stem" or (
                    intent.get("action") == "kind" and intent.get("kind") == "container"
                ):
                    regroup.begin(db, command, intent)
                    db.execute("RELEASE grouping_edit")
                    return True
                dirty = edits.apply(db, command["workspace"], intent)
                if dirty:
                    db.executemany(
                        "UPDATE grouping_nodes SET roles_dirty=1,role_cursor=-1,role_context=NULL,"
                        "reason='' WHERE workspace=? AND id=?",
                        ((command["workspace"], node) for node in sorted(dirty)),
                    )
                    db.execute(
                        "UPDATE grouping_workspaces SET state='editing',phase='roles' WHERE id=?",
                        (command["workspace"],),
                    )
                    db.execute(
                        "UPDATE grouping_commands SET state='running',phase='roles' WHERE id=?",
                        (command["id"],),
                    )
                else:
                    finish(db, command)
            elif command["phase"] == "roles":
                if roles.step(db, command["workspace"]):
                    finish(db, command)
            elif command["phase"] in {"copy", "plan", "splice"}:
                if regroup.step(db, command):
                    finish(db, command)
            elif command["phase"] in {"export", "verification"}:
                snapshot.step(db, command)
            else:
                raise ReplicaError("Unsupported grouping edit phase")
            db.execute("RELEASE grouping_edit")
        except (DomainError, KeyError, TypeError, ValueError) as error:
            db.execute("ROLLBACK TO grouping_edit")
            db.execute("RELEASE grouping_edit")
            if command["phase"] in {"copy", "plan", "splice", "export", "verification"}:
                if command["phase"] not in {"export", "verification"}:
                    regroup.cleanup(db, command["id"])
                db.execute(
                    "UPDATE grouping_workspaces SET state='ready',phase='ready' WHERE id=?",
                    (command["workspace"],),
                )
            db.execute(
                "UPDATE grouping_commands SET state='failed',error=? WHERE id=?",
                (
                    error.message
                    if isinstance(error, DomainError)
                    else "Invalid grouping edit; the saved draft is retained",
                    command["id"],
                ),
            )
        return True
