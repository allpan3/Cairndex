"""Indexed field revisions, drafts and transactional outbox in a private SQLite store"""

import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from cairndex.core.errors import ValidationError as InputError
from cairndex.replicas.protocol import (
    MAX_CANDIDATES,
    Change,
    Descriptor,
    Edit,
    FieldName,
    PackageIdentity,
    ReplicaError,
    Seed,
    canonical,
    checksum,
    decode,
    envelope,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, replica TEXT, operation TEXT, intent TEXT,
    raw BLOB NOT NULL, local INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0,
    UNIQUE(replica, operation));
CREATE INDEX IF NOT EXISTS events_outbox ON events(local,published,id);
CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, title TEXT, notes TEXT, rating REAL);
CREATE TABLE IF NOT EXISTS revisions (
    event TEXT NOT NULL REFERENCES events(id), bundle TEXT NOT NULL REFERENCES bundles(id),
    field TEXT NOT NULL, value TEXT NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY(event, bundle, field));
CREATE INDEX IF NOT EXISTS revisions_history ON revisions(bundle, field, event);
CREATE INDEX IF NOT EXISTS revisions_active ON revisions(bundle, field, active, event);
CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY, raw BLOB NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, artifact TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_attempt ON inbox(attempt);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(state, attempt, id);
CREATE TABLE IF NOT EXISTS draft_receipts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, bundle TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS drafts_bundle ON drafts(bundle, id);
"""


# Failpoints are injected by synthetic crash tests, never configured through an API
def no_fault(point: str) -> None:
    pass


# Each transaction opens its own connection; SQLite serializes clients and importer together
class PrivateStore:
    # Bind a private store to one logical history without copying media or a legacy DB
    def __init__(
        self,
        directory: Path,
        descriptor: PackageIdentity,
        *,
        fault: Callable[[str], None] = no_fault,
    ) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        directory = directory.absolute()
        if directory.resolve() != directory:
            raise ReplicaError("Private metadata storage must not be linked")
        info = directory.stat()
        self._directory_identity = (info.st_dev, info.st_ino)
        self.path = directory / "replica.db"
        if self.path.is_symlink():
            raise ReplicaError("Private replica database must not be a symlink")
        self.descriptor, self.fault = descriptor, fault
        with self.connection() as db:
            db.executescript(SCHEMA)
            db.execute("BEGIN IMMEDIATE")
            identity = canonical(
                [descriptor.library_uuid, descriptor.epoch, descriptor.genesis]
            ).decode()
            prior = db.execute("SELECT value FROM config WHERE key='identity'").fetchone()
            if prior and prior[0] != identity:
                raise ReplicaError("Private history identity changed; recovery review required")
            db.execute("INSERT OR IGNORE INTO config VALUES ('identity', ?)", (identity,))
            db.execute("INSERT OR IGNORE INTO config VALUES ('replica', ?)", (uuid4().hex,))

    # FULL durability keeps save/outbox/projection in one local crash boundary
    @contextmanager
    def connection(self, *, readonly: bool = False) -> Iterator[sqlite3.Connection]:
        try:
            info = self.path.parent.stat(follow_symlinks=False)
        except OSError as error:
            raise ReplicaError(
                "Private metadata storage unavailable; your draft is retained"
            ) from error
        if (
            self.path.parent.resolve() != self.path.parent
            or self._directory_identity != (info.st_dev, info.st_ino)
            or any(
                Path(str(self.path) + suffix).is_symlink()
                for suffix in ("", "-wal", "-shm", "-journal")
            )
        ):
            raise ReplicaError("Private metadata storage changed; recovery review required")
        try:
            db = sqlite3.connect(self.path, timeout=10)
        except sqlite3.Error as error:
            raise ReplicaError(
                "Private metadata storage unavailable; your draft is retained"
            ) from error
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN" if readonly else "BEGIN IMMEDIATE")
            yield db
            db.commit()
        except sqlite3.Error as error:
            with suppress(sqlite3.Error):
                db.rollback()
            raise ReplicaError(
                "Private metadata transaction failed; your draft is retained"
            ) from error
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()


# The protocol-one store cannot be used for a richer catalog package
class Store(PrivateStore):
    descriptor: Descriptor

    # Keep the bounded API and decoder bound to their original capability
    def __init__(
        self,
        directory: Path,
        descriptor: Descriptor,
        *,
        fault: Callable[[str], None] = no_fault,
    ) -> None:
        if not isinstance(descriptor, Descriptor):
            raise ReplicaError("This metadata API requires bundle_metadata_v1")
        super().__init__(directory, descriptor, fault=fault)

    # Active revision IDs are the bounded editor precondition for one field
    def _tips(self, db: sqlite3.Connection, bundle: str, field: str) -> list[sqlite3.Row]:
        return db.execute(
            (
                "SELECT event,value FROM revisions WHERE bundle=? AND field=? AND "
                "active=1 ORDER BY event"
            ),
            (bundle, field),
        ).fetchall()

    # Materialize only the affected field; never replay the complete causal history
    def _project(self, db: sqlite3.Connection, bundle: str, field: FieldName) -> None:
        tips = self._tips(db, bundle, field)
        values = {row["value"] for row in tips}
        if len(values) == 1:
            db.execute(
                f"UPDATE bundles SET {field}=? WHERE id=?",
                (values.pop() if field == "notes" else json.loads(values.pop()), bundle),
            )

    # Refuse edits until the complete baseline and compatible transport are present
    def _writable(self, db: sqlite3.Connection) -> None:
        if db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone():
            raise ReplicaError("Recovery or upgrade required; your draft is retained")
        if not db.execute("SELECT 1 FROM events WHERE id=?", (self.descriptor.genesis,)).fetchone():
            raise ReplicaError("Waiting for the complete library baseline; your draft is retained")

    # Validate dependencies by indexed lookup before changing any projection row
    def _apply(
        self,
        db: sqlite3.Connection,
        event_id: str,
        body: Seed | Edit,
        raw: bytes,
        *,
        local: bool = False,
        intent: str | None = None,
    ) -> str:
        if db.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
            return "duplicate"
        if isinstance(body, Seed):
            if event_id != self.descriptor.genesis:
                raise ReplicaError("Unexpected baseline identity")
            db.execute("INSERT INTO events(id,raw,local) VALUES (?, ?, 0)", (event_id, raw))
            for bundle in body.bundles:
                db.execute(
                    "INSERT INTO bundles VALUES (?, ?, ?, ?)",
                    (bundle.id, bundle.title, canonical(bundle.notes).decode(), bundle.rating),
                )
                for field in ("title", "notes", "rating"):
                    db.execute(
                        "INSERT INTO revisions VALUES (?, ?, ?, ?, 1)",
                        (
                            event_id,
                            bundle.id,
                            field,
                            canonical(getattr(bundle, field)).decode(),
                        ),
                    )
            return "accepted"
        if not db.execute("SELECT 1 FROM events WHERE id=?", (self.descriptor.genesis,)).fetchone():
            return "waiting"
        if not db.execute("SELECT 1 FROM bundles WHERE id=?", (body.bundle,)).fetchone():
            raise ReplicaError("Unknown bundle identity; conversion is unavailable")
        prior = db.execute(
            "SELECT id FROM events WHERE replica=? AND operation=?", (body.replica, body.operation)
        ).fetchone()
        if prior:
            raise ReplicaError("Operation identity fork requires recovery review")
        for field, change in body.changes.items():
            for basis in change.basis:
                if not db.execute("SELECT 1 FROM events WHERE id=?", (basis,)).fetchone():
                    return "waiting"
                if not db.execute(
                    "SELECT 1 FROM revisions WHERE event=? AND bundle=? AND field=?",
                    (basis, body.bundle, field),
                ).fetchone():
                    raise ReplicaError("Edit basis does not belong to this bundle field")
            remaining = {row["event"] for row in self._tips(db, body.bundle, field)} - set(
                change.basis
            )
            if len(remaining) >= MAX_CANDIDATES:
                return "waiting"  # Resolve existing candidates before accepting another branch
        db.execute(
            "INSERT INTO events(id,replica,operation,intent,raw,local) VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, body.replica, body.operation, intent, raw, int(local)),
        )
        for field, change in body.changes.items():
            for basis in change.basis:
                db.execute(
                    "UPDATE revisions SET active=0 WHERE event=? AND bundle=? AND field=?",
                    (basis, body.bundle, field),
                )
            db.execute(
                "INSERT INTO revisions VALUES (?, ?, ?, ?, 1)",
                (event_id, body.bundle, field, canonical(change.value).decode()),
            )
            self._project(db, body.bundle, field)
        return "accepted"

    # Explicit field basis preserves stale intent; resolution requires every current candidate
    def save(
        self,
        bundle: str,
        changes: dict[FieldName, Change],
        operation: str,
        *,
        resolve: bool = False,
    ) -> str:
        intent = canonical(
            {
                "bundle": bundle,
                "changes": {k: v.model_dump() for k, v in changes.items()},
                "resolve": resolve,
            }
        ).decode()
        with self.connection() as db:
            replica = db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]
            prior = db.execute(
                "SELECT id,intent FROM events WHERE replica=? AND operation=?", (replica, operation)
            ).fetchone()
            if prior:
                if prior["intent"] != intent:
                    raise ReplicaError("Retry identity was reused for different work")
                return str(prior["id"])
            self._writable(db)
            if resolve:
                for field, change in changes.items():
                    if set(change.basis) != {row["event"] for row in self._tips(db, bundle, field)}:
                        raise ReplicaError(
                            "Conflict review is stale; review the current candidates"
                        )
            try:
                body = Edit(
                    protocol=1,
                    kind="edit",
                    library=self.descriptor.library_uuid,
                    epoch=self.descriptor.epoch,
                    replica=replica,
                    operation=operation,
                    bundle=bundle,
                    changes=changes,
                )
            except ValidationError as error:
                raise InputError("Invalid bundle field value; your draft is retained") from error
            event_id, raw = envelope(body)
            result = self._apply(db, event_id, body, raw, local=True, intent=intent)
            if result == "waiting":
                raise ReplicaError(
                    "Edit basis is missing or conflict capacity is reached; draft retained"
                )
            self.fault("save_before_commit")
        self.fault("save_after_commit")
        return event_id

    # Intake keeps exact bytes, including invalid artifacts, without mutating good content
    def ingest(self, raw: bytes, source: str = "") -> None:
        token, state, reason = checksum(raw), "pending", ""
        try:
            event_id, _ = decode(raw, self.descriptor)
            token = event_id
        except ReplicaError as error:
            reason = error.message
            state = "invalid" if "upgrade" in reason or "identity" in reason else "unverified"
        with self.connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO inbox(id,raw,state,reason) VALUES (?, ?, ?, ?)",
                (token, raw, state, reason),
            )
            if source:
                prior = db.execute(
                    "SELECT artifact FROM sources WHERE name=?", (source,)
                ).fetchone()
                db.execute("INSERT OR REPLACE INTO sources VALUES (?, ?)", (source, token))
                if prior and prior[0] != token and state == "pending":
                    db.execute(
                        (
                            "UPDATE inbox SET state='superseded' WHERE id=? AND "
                            "state='unverified' AND NOT EXISTS (SELECT 1 FROM sources WHERE "
                            "artifact=?)"
                        ),
                        (prior[0], prior[0]),
                    )
            if state == "invalid":
                db.execute("INSERT OR REPLACE INTO config VALUES ('blocked', ?)", (reason,))

    # Rotate incomplete rows so a missing dependency cannot starve later complete arrivals
    def import_batch(self, limit: int = 32) -> int:
        accepted = 0
        with self.connection() as db:
            pending = db.execute(
                "SELECT id,raw FROM inbox WHERE state='pending' ORDER BY attempt,id LIMIT ?",
                (limit,),
            ).fetchall()
            attempt = db.execute("SELECT COALESCE(MAX(attempt),0)+1 FROM inbox").fetchone()[0]
            for row in pending:
                try:
                    event_id, body = decode(row["raw"], self.descriptor)
                    state = self._apply(db, event_id, body, row["raw"])
                    reason = (
                        "Waiting for dependencies or conflict capacity"
                        if state == "waiting"
                        else ""
                    )
                    if state == "waiting":
                        state = "pending"
                    elif state == "accepted":
                        accepted += 1
                except ReplicaError as error:
                    state, reason = "invalid", error.message
                    db.execute("INSERT OR REPLACE INTO config VALUES ('blocked', ?)", (reason,))
                db.execute(
                    "UPDATE inbox SET state=?,reason=?,attempt=? WHERE id=?",
                    (state, reason, attempt, row["id"]),
                )
            self.fault("import_before_commit")
        self.fault("import_after_commit")
        return accepted

    # Paginate bundles and retrieve only three indexed candidate sets per visible bundle
    def bundles(self, after: str = "", limit: int = 30) -> dict[str, Any]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM bundles WHERE id>? ORDER BY id LIMIT ?", (after, limit + 1)
            ).fetchall()
            items = []
            for row in rows[:limit]:
                fields: dict[str, Any] = {}
                for field in ("title", "notes", "rating"):
                    tips = self._tips(db, row["id"], field)
                    groups: dict[str, list[str]] = {}
                    for tip in tips:
                        groups.setdefault(tip["value"], []).append(tip["event"])
                    fields[field] = {
                        "value": json.loads(row[field]) if field == "notes" else row[field],
                        "basis": [tip["event"] for tip in tips],
                        "candidates": [
                            {"value": json.loads(value), "revisions": ids}
                            for value, ids in groups.items()
                        ],
                    }
                items.append({"id": row["id"], "fields": fields})
            return {
                "items": items,
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }

    # History is retained and paginated; reapplying a value requires an ordinary explicit save
    def history(self, bundle: str, field: str, after: str = "", limit: int = 30) -> dict[str, Any]:
        with self.connection() as db:
            rows = db.execute(
                (
                    "SELECT event,value,active FROM revisions WHERE bundle=? AND field=? "
                    "AND event>? ORDER BY event LIMIT ?"
                ),
                (bundle, field, after, limit + 1),
            ).fetchall()
            return {
                "items": [
                    {
                        "revision": row["event"],
                        "value": json.loads(row["value"]),
                        "active": bool(row["active"]),
                    }
                    for row in rows[:limit]
                ],
                "next_cursor": rows[limit - 1]["event"] if len(rows) > limit else None,
            }

    # Persist each editor's work independently with monotonic compare-and-set revisions
    def draft(
        self, draft_id: str, bundle: str, revision: int, changes: dict[FieldName, Change]
    ) -> None:
        raw = canonical({key: value.model_dump() for key, value in changes.items()}).decode()
        with self.connection() as db:
            receipt = db.execute(
                "SELECT revision FROM draft_receipts WHERE id=?", (draft_id,)
            ).fetchone()
            if receipt and revision <= receipt[0]:
                return  # A delayed PUT must not resurrect an acknowledged draft
            row = db.execute("SELECT * FROM drafts WHERE id=?", (draft_id,)).fetchone()
            if row and (
                row["bundle"] != bundle
                or revision < row["revision"]
                or revision == row["revision"]
                and raw != row["body"]
            ):
                raise ReplicaError("A newer draft exists; this editor's input is retained locally")
            db.execute(
                "INSERT OR REPLACE INTO drafts VALUES (?, ?, ?, ?)",
                (draft_id, bundle, revision, raw),
            )

    # Unsaved drafts remain recoverable after application or browser restart
    def drafts(self, bundle: str, after: str = "", limit: int = 30) -> dict[str, Any]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM drafts WHERE bundle=? AND id>? ORDER BY id LIMIT ?",
                (bundle, after, limit + 1),
            ).fetchall()
            return {
                "items": [
                    {"id": r["id"], "revision": r["revision"], "changes": json.loads(r["body"])}
                    for r in rows[:limit]
                ],
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }

    # Conditional dismissal cannot remove a newer unsaved version from another request
    def dismiss_draft(self, draft_id: str, revision: int) -> None:
        with self.connection() as db:
            db.execute(
                (
                    "INSERT INTO draft_receipts VALUES (?, ?) ON CONFLICT(id) "
                    "DO UPDATE SET revision=MAX(revision,excluded.revision)"
                ),
                (draft_id, revision),
            )
            db.execute("DELETE FROM drafts WHERE id=? AND revision=?", (draft_id, revision))

    # Status distinguishes local save/publication from peer delivery, which remains unknown
    def status(self) -> dict[str, Any]:
        with self.connection() as db:
            blocked = db.execute("SELECT value FROM config WHERE key='blocked'").fetchone()
            ready = bool(
                db.execute("SELECT 1 FROM events WHERE id=?", (self.descriptor.genesis,)).fetchone()
            )
            return {
                "ready": ready,
                "blocked": blocked[0] if blocked else None,
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
                "exchange_error": (
                    db.execute("SELECT value FROM config WHERE key='exchange_error'").fetchone()
                    or [None]
                )[0],
            }
