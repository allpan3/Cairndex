"""Durable catalog staging, linked payload verification and incremental causal revision indexes"""

import hashlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog import projection
from cairndex.replicas.catalog.model import split_key, structural_targets, value_text
from cairndex.replicas.catalog.protocol import CatalogDescriptor, Part, Root, UnitChange, decode
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.replicas.store import PrivateStore, no_fault

SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog_parts (
    id TEXT PRIMARY KEY, previous TEXT, sequence INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_revisions (
    event TEXT NOT NULL, unit TEXT NOT NULL, value TEXT NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY(unit,event));
CREATE INDEX IF NOT EXISTS catalog_active ON catalog_revisions(unit,active,event);
CREATE INDEX IF NOT EXISTS catalog_event_revisions ON catalog_revisions(event,unit);
CREATE TABLE IF NOT EXISTS catalog_cohorts (
    event TEXT NOT NULL, unit TEXT NOT NULL, anchor INTEGER NOT NULL, cohort TEXT NOT NULL,
    PRIMARY KEY(unit,event));
CREATE INDEX IF NOT EXISTS catalog_cohort_event ON catalog_cohorts(event,unit);
CREATE TABLE IF NOT EXISTS catalog_guards (
    event TEXT NOT NULL, unit TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(event,unit,target));
CREATE INDEX IF NOT EXISTS catalog_guard_target ON catalog_guards(target,unit,event);
CREATE TABLE IF NOT EXISTS catalog_holds (unit TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_jobs (
    id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
    result TEXT, error TEXT, sequence INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS catalog_job_state ON catalog_jobs(state,sequence);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_job_sequence ON catalog_jobs(sequence);
CREATE TABLE IF NOT EXISTS catalog_parents (
    child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(child,parent));
CREATE TABLE IF NOT EXISTS catalog_frontier (event TEXT PRIMARY KEY);
"""


# Private SQLite is the only mutable store; complete payload roots control activation
class CatalogStorage(PrivateStore):
    descriptor: CatalogDescriptor

    # Initialize catalog tables without opening a DB or lease in the source package
    def __init__(
        self,
        directory: Path,
        descriptor: CatalogDescriptor,
        *,
        fault: Callable[[str], None] = no_fault,
    ) -> None:
        super().__init__(directory, descriptor, fault=fault)
        with self.connection() as db:
            db.executescript(projection.SCHEMA + SCHEMA)
            if "anchor" not in {row[1] for row in db.execute("PRAGMA table_info(catalog_cohorts)")}:
                db.execute(
                    "ALTER TABLE catalog_cohorts ADD COLUMN anchor INTEGER NOT NULL DEFAULT 1"
                )
            if "cohort" not in {row[1] for row in db.execute("PRAGMA table_info(catalog_cohorts)")}:
                db.execute(
                    "ALTER TABLE catalog_cohorts ADD COLUMN cohort TEXT NOT NULL DEFAULT 'legacy'"
                )
            db.execute("UPDATE catalog_jobs SET state='queued' WHERE state='running'")

    # Intake retains malformed bytes, while compatible missing payloads remain retryable
    def ingest(self, raw: bytes, source: str = "") -> None:
        identity, state, reason = checksum(raw), "pending", ""
        try:
            identity, _ = decode(raw, self.descriptor)
        except ReplicaError as error:
            reason = error.message
            state = "invalid" if "upgrade" in reason or "identity" in reason else "unverified"
        with self.connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO inbox(id,raw,state,reason) VALUES (?, ?, ?, ?)",
                (identity, raw, state, reason),
            )
            if source:
                prior = db.execute(
                    "SELECT artifact FROM sources WHERE name=?", (source,)
                ).fetchone()
                db.execute("INSERT OR REPLACE INTO sources VALUES (?, ?)", (source, identity))
                if prior and prior[0] != identity and state == "pending":
                    db.execute(
                        "UPDATE inbox SET state='superseded' WHERE id=? AND "
                        "state='unverified' AND NOT EXISTS "
                        "(SELECT 1 FROM sources WHERE artifact=?)",
                        (prior[0], prior[0]),
                    )
            if state == "invalid":
                db.execute("INSERT OR REPLACE INTO config VALUES ('blocked', ?)", (reason,))

    # Rotate dependencies fairly and commit each bounded importer batch atomically
    def import_batch(self, limit: int = 32) -> int:
        accepted = 0
        with self.connection() as db:
            rows = db.execute(
                "SELECT id,raw FROM inbox WHERE state='pending' ORDER BY attempt,id LIMIT ?",
                (limit,),
            ).fetchall()
            attempt = db.execute("SELECT COALESCE(MAX(attempt),0)+1 FROM inbox").fetchone()[0]
            for row in rows:
                db.execute("SAVEPOINT artifact")
                try:
                    identity, body = decode(row["raw"], self.descriptor)
                    state = self.accept(db, identity, body, row["raw"])
                    reason = "Waiting for complete dependencies" if state == "pending" else ""
                    accepted += state == "accepted"
                except ReplicaError as error:
                    db.execute("ROLLBACK TO artifact")
                    state, reason = "invalid", error.message
                    db.execute("INSERT OR REPLACE INTO config VALUES ('blocked', ?)", (reason,))
                db.execute("RELEASE artifact")
                db.execute(
                    "UPDATE inbox SET state=?,reason=?,attempt=? WHERE id=?",
                    (state, reason, attempt, row["id"]),
                )
            self.fault("import_before_commit")
        self.fault("import_after_commit")
        return accepted

    # Verify the exact linked chain using disk-backed staging rather than retaining all chunks
    def payload_records(self, db: sqlite3.Connection, root: Root) -> Iterator[UnitChange]:
        db.execute(
            "CREATE TEMP TABLE IF NOT EXISTS catalog_chain (sequence INTEGER PRIMARY KEY,id TEXT)"
        )
        db.execute("DELETE FROM catalog_chain")
        tail: str | None = root.last
        for index in range(root.parts - 1, -1, -1):
            part = db.execute("SELECT * FROM catalog_parts WHERE id=?", (tail,)).fetchone()
            if not part:
                raise MissingPayload
            if part["sequence"] != index:
                raise ReplicaError("Catalog payload chain is inconsistent")
            db.execute("INSERT INTO catalog_chain VALUES (?, ?)", (index, tail))
            tail = part["previous"]
        if tail is not None:
            raise ReplicaError("Catalog payload chain does not end at its origin")
        digest = hashlib.sha256()
        buffer, count = "", 0
        for (data,) in db.execute(
            "SELECT p.data FROM catalog_chain c JOIN catalog_parts p "
            "ON p.id=c.id ORDER BY c.sequence"
        ):
            digest.update(data.encode())
            buffer += data
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                try:
                    parsed = json.loads(line)
                    if value_text(parsed) != line:
                        raise ValueError("noncanonical record")
                    change = UnitChange.model_validate(parsed)
                    if change.model_dump() != parsed:
                        raise ValueError("noncanonical catalog cell")
                except (ValueError, TypeError) as error:
                    raise ReplicaError("Unsupported catalog change; upgrade required") from error
                count += 1
                yield change
        if buffer or count != root.records or digest.hexdigest() != root.payload_hash:
            raise ReplicaError("Incomplete catalog payload or record checksum mismatch")

    # All record validation finishes in staging before any causal or visible state changes
    def stage(self, db: sqlite3.Connection, root: Root) -> bool:
        db.execute(
            "CREATE TEMP TABLE IF NOT EXISTS catalog_staging "
            "(unit TEXT PRIMARY KEY,value TEXT NOT NULL,basis TEXT NOT NULL,cohort TEXT)"
        )
        db.execute("DELETE FROM catalog_staging")
        try:
            for change in self.payload_records(db, root):
                if db.execute(
                    "SELECT 1 FROM catalog_staging WHERE unit=?", (change.unit,)
                ).fetchone():
                    raise ReplicaError("Duplicate catalog change in one operation")
                db.execute(
                    "INSERT INTO catalog_staging VALUES (?, ?, ?, ?)",
                    (change.unit, change.value, value_text(change.basis), change.cohort),
                )
        except MissingPayload:
            return False
        return True

    # Child stores implement edit semantics while this layer controls complete seed visibility
    def accept(
        self,
        db: sqlite3.Connection,
        identity: str,
        body: Root | Part,
        raw: bytes,
        *,
        local: bool = False,
        intent: str | None = None,
    ) -> str:
        if db.execute("SELECT 1 FROM events WHERE id=?", (identity,)).fetchone():
            return "duplicate"
        if isinstance(body, Part):
            db.execute(
                "INSERT INTO events(id,raw,local) VALUES (?, ?, ?)", (identity, raw, int(local))
            )
            db.execute(
                "INSERT INTO catalog_parts VALUES (?, ?, ?, ?)",
                (identity, body.previous, body.index, body.data),
            )
            return "accepted"
        if (
            body.kind != "catalog_seed"
            and not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone()
        ):
            return "pending"
        if not self.stage(db, body):
            return "pending"
        if len(body.parents) != len(set(body.parents)) or (
            bool(body.parents) != (body.kind == "catalog_edit")
        ):
            raise ReplicaError("Catalog operation requires its complete observed frontier")
        for parent in body.parents:
            if not db.execute("SELECT 1 FROM events WHERE id=?", (parent,)).fetchone():
                return "pending"
        if body.kind == "catalog_seed":
            for row in db.execute("SELECT * FROM catalog_staging"):
                if json.loads(row["basis"]):
                    raise ReplicaError("Seed cannot consume an existing revision")
                family, entity, field = split_key(row["unit"])
                db.execute(
                    "INSERT INTO catalog_units VALUES (?, ?, ?, ?, ?)",
                    (row["unit"], family, entity, field, row["value"]),
                )
                db.execute(
                    "INSERT INTO catalog_revisions VALUES (?, ?, ?, 1)",
                    (identity, row["unit"], row["value"]),
                )
                db.executemany(
                    "INSERT INTO catalog_claims VALUES (?, ?, ?, ?)",
                    (
                        (row["unit"], identity, target, kind)
                        for target, kind in structural_targets(row["unit"], row["value"])
                    ),
                )
            # Large seed work runs in the importer, never inside a catalog read handler
            projection.project_seed(db)
            for family in ("tags", "collections"):
                if not db.execute(
                    "SELECT 1 FROM catalog_units WHERE family=? AND field='$forest'", (family,)
                ).fetchone():
                    raise ReplicaError("Complete catalog seed is missing its hierarchy")
            db.execute("INSERT INTO config VALUES ('catalog_ready','1')")
        else:
            if not self.apply_edit(db, identity, body, local=local):
                return "pending"
        prior = db.execute(
            "SELECT id FROM events WHERE replica=? AND operation=?", (body.replica, body.operation)
        ).fetchone()
        if prior:
            raise ReplicaError("Operation identity fork requires recovery review")
        db.execute(
            "INSERT INTO events(id,replica,operation,intent,raw,local) VALUES (?, ?, ?, ?, ?, ?)",
            (identity, body.replica, body.operation, intent, raw, int(local)),
        )
        parents = set(body.parents)
        for (basis,) in db.execute("SELECT basis FROM catalog_staging"):
            parents.update(json.loads(basis))
        db.executemany(
            "INSERT INTO catalog_parents VALUES (?, ?)", ((identity, parent) for parent in parents)
        )
        db.executemany(
            "DELETE FROM catalog_frontier WHERE event=?", ((parent,) for parent in parents)
        )
        db.execute("INSERT INTO catalog_frontier VALUES (?)", (identity,))
        return "accepted"

    # Abstract edit application prevents this storage base from accepting incomplete semantics
    def apply_edit(self, db: sqlite3.Connection, identity: str, root: Root, *, local: bool) -> bool:
        raise ReplicaError("Catalog edit semantics are unavailable")

    # Indexed local state distinguishes complete activation, waiting payloads and delivery limits
    def status(self) -> dict[str, Any]:
        with self.connection(readonly=True) as db:
            config = dict(db.execute("SELECT key,value FROM config"))
            return {
                "ready": "catalog_ready" in config,
                "catalog_version": 1,
                "blocked": config.get("blocked"),
                "outbox": db.execute(
                    "SELECT COUNT(*) FROM events WHERE local=1 AND published=0"
                ).fetchone()[0],
                "waiting": db.execute(
                    "SELECT COUNT(*) FROM inbox WHERE state IN ('pending','unverified')"
                ).fetchone()[0],
                "invalid": db.execute(
                    "SELECT COUNT(*) FROM inbox WHERE state='invalid'"
                ).fetchone()[0],
                "peer_delivery": "unknown",
                "exchange_error": config.get("exchange_error"),
            }


# Missing linked objects keep an intact baseline pending without classifying it as corrupt
class MissingPayload(Exception):
    pass
