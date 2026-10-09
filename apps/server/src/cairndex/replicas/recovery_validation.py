"""Coherent snapshots and independent validation of private recovery dependencies"""

import hashlib
import json
import math
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog import projection
from cairndex.replicas.catalog.protocol import CatalogDescriptor, Root
from cairndex.replicas.catalog.protocol import decode as catalog_decode
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.private_schema import validate_schema
from cairndex.replicas.protocol import Descriptor, Edit, ReplicaError, canonical, decode
from cairndex.replicas.store import Store, recovered_intent

Identity = Descriptor | CatalogDescriptor
Replica = Store | CatalogStore


# SQLite online backup pins one read transaction, including committed WAL bytes during writes
def snapshot(source: Path, destination: Path) -> None:
    if source.resolve() != source or not source.is_file():
        raise ReplicaError("Private database is missing or linked; select a verified backup")
    if any(Path(str(source) + suffix).is_symlink() for suffix in ("-wal", "-shm", "-journal")):
        raise ReplicaError("Private database sidecars must not be linked")
    with destination.open("xb"):
        os.chmod(destination, 0o600)
    try:
        with (
            closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src,
            closing(sqlite3.connect(destination)) as dst,
        ):
            src.execute("BEGIN")
            src.execute("SELECT count(*) FROM sqlite_master").fetchone()
            src.backup(dst, pages=256)
            dst.execute("PRAGMA journal_mode=DELETE")
        with destination.open("rb") as stream:
            os.fsync(stream.fileno())
    except sqlite3.Error as error:
        raise ReplicaError("Private snapshot failed; original state remains intact") from error


# Receipt checksums stream bytes and never load an entire private database into memory
def file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


# Immutable snapshots require no WAL or recovery write from the validating reader
def reader(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    return db


# Compare exact cells in deterministic order, including blobs and null-versus-empty values
def table_hash(db: sqlite3.Connection, table: str, columns: str = "*") -> str:
    names = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    selected = names if columns == "*" else columns.split(",")
    sql = ",".join(f'"{name}"' for name in selected)
    digest = hashlib.sha256()
    for row in db.execute(f'SELECT {sql} FROM "{table}" ORDER BY {sql}'):
        digest.update(
            canonical([{"blob": cell.hex()} if isinstance(cell, bytes) else cell for cell in row])
        )
        digest.update(b"\n")
    return digest.hexdigest()


# Reuse production import semantics until a complete dependency sweep makes no progress
def settle(store: Replica) -> None:
    while True:
        with store.connection(readonly=True) as db:
            count = db.execute("SELECT COUNT(*) FROM inbox WHERE state='pending'").fetchone()[0]
        if not count:
            return
        accepted = sum(store.import_batch() for _ in range((count + 31) // 32))
        if not accepted:
            return


# Constructors remain capability-specific; validators never open the source as a working store
def open_store(path: Path, descriptor: Identity) -> Replica:
    return (
        CatalogStore(path, descriptor)
        if isinstance(descriptor, CatalogDescriptor)
        else Store(path, descriptor)
    )


# Record every table count and pending category without printing private metadata text
def inventory(db: sqlite3.Connection) -> dict[str, Any]:
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    counts = {name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in tables}
    config = dict(db.execute("SELECT key,value FROM config"))
    ready = (
        "catalog_ready" in config
        if "catalog_rows" in tables
        else bool(
            db.execute(
                "SELECT 1 FROM events WHERE id=?", (json.loads(config["identity"])[2],)
            ).fetchone()
        )
    )
    return {
        "tables": counts,
        "ready": ready,
        "author": db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0],
        "outbox": db.execute(
            "SELECT COUNT(*) FROM events WHERE local=1 AND published=0"
        ).fetchone()[0],
        "waiting": db.execute(
            "SELECT COUNT(*) FROM inbox WHERE state IN ('pending','unverified')"
        ).fetchone()[0],
        "invalid": db.execute("SELECT COUNT(*) FROM inbox WHERE state='invalid'").fetchone()[0],
        "blocked": bool(db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone()),
        "jobs": dict(db.execute("SELECT state,COUNT(*) FROM catalog_jobs GROUP BY state"))
        if "catalog_jobs" in tables
        else {},
    }


# Retry mappings must identify the exact original immutable intent, not an arbitrary old event
def validate_intent(db: sqlite3.Connection, store: Replica, row: sqlite3.Row) -> None:
    if row["intent"] is None:
        if row["local"] and row["operation"]:
            raise ReplicaError("Private local operation is missing its retry intent")
        return
    if not row["operation"]:
        # Catalog payload parts retain their owner's intent but have no operation identity
        return
    if isinstance(store, CatalogStore):
        _, body = catalog_decode(row["raw"], store.descriptor)
        if not isinstance(body, Root) or body.kind not in {"catalog_edit", "catalog_source_edit"}:
            raise ReplicaError("Private retry receipt names an unsupported event")
        expected = {
            "changes": [item.model_dump() for item in store.payload_records(db, body)],
            "parents": body.parents,
            "resolve": body.resolve,
            "recover": body.recover,
            **({"source": True} if body.kind == "catalog_source_edit" else {}),
        }
    else:
        _, edit = decode(row["raw"], store.descriptor)
        if not isinstance(edit, Edit):
            raise ReplicaError("Private retry receipt names an unsupported event")
        expected = {
            "bundle": edit.bundle,
            "changes": {name: change.model_dump() for name, change in edit.changes.items()},
        }
        intent = json.loads(row["intent"])
        expected["resolve"] = intent.get("resolve")
        if type(expected["resolve"]) is not bool:
            raise ReplicaError("Invalid private resolution receipt")
    if canonical(expected).decode() != row["intent"]:
        raise ReplicaError("Private retry intent differs from its immutable event")


# Validate a separate coherent snapshot against known schema, complete history and relationships
def validate_snapshot(path: Path, descriptor: Identity) -> dict[str, Any]:
    try:
        with closing(reader(path)) as source:
            validate_schema(source, catalog=isinstance(descriptor, CatalogDescriptor))
            if list(source.execute("PRAGMA integrity_check"))[0][0] != "ok" or list(
                source.execute("PRAGMA foreign_key_check")
            ):
                raise ReplicaError("Private snapshot failed integrity or reference validation")
            config = dict(source.execute("SELECT key,value FROM config"))
            if set(config) - {"identity", "replica", "blocked", "exchange_error", "catalog_ready"}:
                raise ReplicaError("Unknown private configuration requires an upgrade")
            if (
                config.get("identity")
                != canonical(
                    [descriptor.library_uuid, descriptor.epoch, descriptor.genesis]
                ).decode()
            ):
                raise ReplicaError("Private backup belongs to another library or authority")
            if not isinstance(config.get("replica"), str) or not config["replica"]:
                raise ReplicaError("Private author identity is missing")
            with tempfile.TemporaryDirectory(prefix="cairndex-verify-") as directory:
                replay = open_store(Path(directory).resolve(), descriptor)
                for row in source.execute("SELECT * FROM events ORDER BY id"):
                    identity, body = (
                        catalog_decode(row["raw"], descriptor)
                        if isinstance(descriptor, CatalogDescriptor)
                        else decode(row["raw"], descriptor)
                    )
                    if (
                        identity != row["id"]
                        or row["local"] not in (0, 1)
                        or row["published"] not in (0, 1)
                    ):
                        raise ReplicaError("Private event identity or outbox receipt is invalid")
                    if (row["replica"], row["operation"]) != (
                        getattr(body, "replica", None),
                        getattr(body, "operation", None),
                    ):
                        raise ReplicaError(
                            "Private author receipt differs from its immutable event"
                        )
                    replay.ingest(row["raw"])
                settle(replay)
                with replay.connection() as verified:
                    if table_hash(source, "events", "id,raw") != table_hash(
                        verified, "events", "id,raw"
                    ):
                        raise ReplicaError("Private history has invalid or missing dependencies")
                    for row in source.execute("SELECT * FROM events"):
                        validate_intent(source, replay, row)
                    if "recovery_receipts" in {
                        row[0] for row in source.execute("SELECT name FROM sqlite_master")
                    }:
                        for row in source.execute(
                            "SELECT r.*,e.operation AS original,e.intent AS original_intent "
                            "FROM recovery_receipts r LEFT JOIN events e ON e.id=r.event"
                        ):
                            if row["operation"] != row["original"] or row["intent"] != (
                                row["original_intent"]
                                or recovered_intent(source, descriptor, row["event"], row["intent"])
                            ):
                                raise ReplicaError("Restored retry receipt is inconsistent")
                    if isinstance(replay, CatalogStore):
                        if (
                            source.execute(
                                "SELECT value FROM config WHERE key='catalog_ready'"
                            ).fetchone()
                            != verified.execute(
                                "SELECT value FROM config WHERE key='catalog_ready'"
                            ).fetchone()
                        ):
                            raise ReplicaError("Private readiness differs from verified history")
                        validate_catalog(source, verified)
                    else:
                        if table_hash(source, "revisions") != table_hash(verified, "revisions"):
                            raise ReplicaError("Private revisions differ from verified history")
                        for row in source.execute("SELECT * FROM bundles"):
                            for field in ("title", "notes", "rating"):
                                raw = (
                                    row[field]
                                    if field == "notes"
                                    else canonical(row[field]).decode()
                                )
                                if not source.execute(
                                    "SELECT 1 FROM revisions "
                                    "WHERE bundle=? AND field=? AND value=?",
                                    (row["id"], field, raw),
                                ).fetchone():
                                    raise ReplicaError("Private projection is not a retained value")
                validate_private(source, replay)
            return inventory(source)
    except (sqlite3.Error, ValueError, KeyError, TypeError) as error:
        raise ReplicaError("Private snapshot is corrupt or unsupported") from error


# Preserve the saved valid conflict display and rebuild derived relations from its verified cells
def validate_catalog(source: sqlite3.Connection, verified: sqlite3.Connection) -> None:
    for table in (
        "catalog_parts",
        "catalog_revisions",
        "catalog_parents",
        "catalog_frontier",
        "catalog_guards",
        "catalog_claims",
    ):
        if table_hash(source, table) != table_hash(verified, table):
            raise ReplicaError("Private causal index differs from verified history")
    if table_hash(source, "catalog_units", "unit,family,entity,field") != table_hash(
        verified, "catalog_units", "unit,family,entity,field"
    ):
        raise ReplicaError("Private unit inventory differs from verified history")
    if table_hash(source, "catalog_holds", "unit") != table_hash(verified, "catalog_holds", "unit"):
        raise ReplicaError("Private conflict review is inconsistent with verified history")
    cohort_columns = {row[1] for row in source.execute("PRAGMA table_info(catalog_cohorts)")}
    if {"anchor", "cohort"}.issubset(cohort_columns) and not source.execute(
        "SELECT 1 FROM catalog_cohorts WHERE cohort='legacy' LIMIT 1"
    ).fetchone():
        if table_hash(source, "catalog_cohorts", "event,unit,anchor,cohort") != table_hash(
            verified, "catalog_cohorts", "event,unit,anchor,cohort"
        ):
            raise ReplicaError("Private structural review index differs from verified history")
    elif table_hash(source, "catalog_cohorts", "event,unit") != table_hash(
        verified, "catalog_cohorts", "event,unit"
    ):
        raise ReplicaError("Private structural review dependencies are incomplete")
    for row in source.execute("SELECT * FROM catalog_units"):
        if (
            row["value"] is not None
            and not source.execute(
                "SELECT 1 FROM catalog_revisions WHERE unit=? AND value=?",
                (row["unit"], row["value"]),
            ).fetchone()
        ):
            raise ReplicaError("Private projection is not a retained catalog value")
    verified.execute("DELETE FROM catalog_units")
    verified.executemany(
        "INSERT INTO catalog_units VALUES (?, ?, ?, ?, ?)",
        source.execute("SELECT * FROM catalog_units"),
    )
    for table in (
        "catalog_rows",
        "catalog_placements",
        "catalog_references",
        "catalog_unique_values",
        "catalog_paths",
        "catalog_directories",
        "catalog_projected_claims",
    ):
        verified.execute(f"DELETE FROM {table}")
    projection.project_seed(verified)
    for table in (
        "catalog_rows",
        "catalog_placements",
        "catalog_references",
        "catalog_unique_values",
        "catalog_paths",
        "catalog_directories",
        "catalog_projected_claims",
    ):
        if table_hash(source, table) != table_hash(verified, table):
            raise ReplicaError("Private projection has incomplete or inconsistent references")


# Draft bodies may intentionally contain invalid editor text; preserve it without authorizing a save
def validate_private(db: sqlite3.Connection, store: Replica) -> None:
    config = dict(db.execute("SELECT key,value FROM config"))
    for row in db.execute("SELECT * FROM inbox"):
        if row["state"] not in {
            "pending",
            "unverified",
            "invalid",
            "accepted",
            "duplicate",
            "superseded",
        }:
            raise ReplicaError("Unsupported private inbox state")
        try:
            identity, _ = (
                catalog_decode(row["raw"], store.descriptor)
                if isinstance(store, CatalogStore)
                else decode(row["raw"], store.descriptor)
            )
        except ReplicaError:
            from cairndex.replicas.protocol import checksum

            if (
                row["state"] not in {"invalid", "unverified", "superseded"}
                or checksum(row["raw"]) != row["id"]
            ):
                raise ReplicaError(
                    "Private inbox checksum or validation state is inconsistent"
                ) from None
        else:
            if identity != row["id"]:
                raise ReplicaError("Private inbox identity is inconsistent")
        if row["state"] == "invalid" and "blocked" not in config:
            raise ReplicaError("Private inbox requires an upgrade or recovery fence")
        if (
            row["state"] in {"accepted", "duplicate"}
            and not db.execute("SELECT 1 FROM events WHERE id=?", (row["id"],)).fetchone()
        ):
            raise ReplicaError("Private inbox receipt is missing its accepted event")
    if db.execute(
        "SELECT 1 FROM sources s LEFT JOIN inbox i ON s.artifact=i.id WHERE i.id IS NULL LIMIT 1"
    ).fetchone():
        raise ReplicaError("Private transport source receipt is incomplete")
    if db.execute("SELECT 1 FROM draft_receipts WHERE revision<1 LIMIT 1").fetchone():
        raise ReplicaError("Private draft dismissal receipt is invalid")
    for row in db.execute("SELECT * FROM drafts"):
        if row["revision"] < 1 or not isinstance(json.loads(row["body"]), dict):
            raise ReplicaError("Invalid private draft record")
    if not isinstance(store, CatalogStore):
        return
    from cairndex.replicas.catalog.schemas import CatalogJobRequest

    if (
        "catalog_ready" in config
        and not db.execute(
            "SELECT 1 FROM events WHERE id=?", (store.descriptor.genesis,)
        ).fetchone()
    ):
        raise ReplicaError("Private readiness marker has no complete seed")
    media_tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master")}
    for table in ("local_media", "local_progress", "local_cursors"):
        if table not in media_tables:
            continue
        for row in db.execute(f"SELECT * FROM {table}"):
            if not db.execute(
                "SELECT 1 FROM catalog_units WHERE family='asset_files' "
                "AND entity=? AND field='$alive'",
                (row["file_id"],),
            ).fetchone():
                raise ReplicaError("Private media state references an unknown identity")
            if (
                table == "local_cursors"
                and not db.execute(
                    "SELECT 1 FROM catalog_units WHERE family='asset_bundles' "
                    "AND entity=? AND field='$alive'",
                    (row["bundle_id"],),
                ).fetchone()
            ):
                raise ReplicaError("Private cursor references an unknown bundle")
            if table == "local_progress" and (
                not isinstance(row["generation"], str)
                or not row["generation"]
                or not math.isfinite(row["position"])
                or row["position"] < 0
                or row["duration"] is not None
                and (not math.isfinite(row["duration"]) or row["duration"] < 0)
                or row["completed"] not in (0, 1)
            ):
                raise ReplicaError("Private resume data is invalid")

    if "discovery_runs" in media_tables:
        from cairndex.replicas.discovery_validation import validate as validate_discovery

        validate_discovery(db, store)

    if "source_operations" in media_tables:
        from cairndex.replicas.source_receipts import validate_private

        validate_private(db, store)

    for row in db.execute("SELECT * FROM catalog_jobs"):
        intent = json.loads(row["intent"])
        CatalogJobRequest.model_validate({"operation": row["id"], **intent})
        if row["state"] not in {"queued", "running", "succeeded", "failed", "cancelled"}:
            raise ReplicaError("Unsupported private job state")
        if intent["action"] == "commit_preview":
            body = intent["body"]
            prior = db.execute(
                "SELECT result FROM catalog_jobs WHERE id=?", (body.get("job"),)
            ).fetchone()
            if not prior or not prior[0]:
                raise ReplicaError("Private job is missing its reviewed preview")
            from cairndex.replicas.protocol import checksum

            if checksum(prior[0].encode()) != body.get("receipt"):
                raise ReplicaError("Private job preview receipt is inconsistent")
        if row["state"] == "succeeded" and intent["action"] in {"save", "commit_preview"}:
            result = json.loads(row["result"])
            if not db.execute(
                "SELECT 1 FROM events WHERE id=? AND operation=?", (result.get("event"), row["id"])
            ).fetchone():
                raise ReplicaError("Private job is missing its committed event")
