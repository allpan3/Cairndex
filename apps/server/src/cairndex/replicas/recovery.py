"""Private backup, separate recovery preparation and reviewed generation activation"""

import os
import re
import shutil
import sqlite3
from collections.abc import Callable
from contextlib import closing
from pathlib import Path
from typing import Any
from uuid import uuid4

from cairndex.registry.library_package import read_manifest
from cairndex.replicas.binding import (
    BindingLock,
    bind,
    location,
    private_path,
    read_json,
    sync_directory,
    write_json,
)
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.private_schema import validate_schema
from cairndex.replicas.protocol import ReplicaError, canonical, checksum
from cairndex.replicas.recovery_validation import (
    Identity,
    file_hash,
    inventory,
    open_store,
    reader,
    settle,
    snapshot,
    table_hash,
    validate_snapshot,
)
from cairndex.replicas.store import no_fault
from cairndex.replicas.transport import Transport

COVERAGE = {
    "included": "One coherent private DB: immutable events/outbox, alternatives, drafts/bases, "
    "jobs/receipts, inbox, discovery candidates/reviews and local resume/cursors",
    "client_drafts": "Only server-received drafts committed at the snapshot; "
    "browser-only or offline unreceived work is excluded",
    "excluded": "Source media, conversion/legacy archives, registry, credentials, "
    "endpoint configuration and other devices",
    "rebuilt": "Media derivatives, HLS, temporary branch reconstructions "
    "and transport directory cursors",
    "revalidated": "Local availability/probes and source generation; restored progress "
    "never rebinds to different bytes automatically",
    "gap": "Unexchanged work absent from every surviving store or backup cannot be recovered",
}


# A local administrative command selects an existing capable package, never converts a library
def descriptor_at(root: Path) -> Identity:
    manifest = read_manifest(root)
    if manifest.replica is None:
        raise ReplicaError(
            "Private recovery requires an existing replica package; conversion is disabled"
        )
    return manifest.replica


# Recovery sets are create-only directories; interrupted sets have no valid completion receipt
def new_directory(path: Path, root: Path) -> Path:
    path = private_path(path, root)
    path.mkdir(parents=True, exist_ok=False, mode=0o700)
    return path


# Unknown private root artifacts must be classified instead of silently skipped by a backup
def check_store_files(path: Path) -> None:
    for item in path.iterdir():
        if item.is_symlink():
            raise ReplicaError("Linked private artifacts cannot be backed up")
        if item.name in {"replica.db", "replica.db-wal", "replica.db-shm", "replica.db-journal"}:
            if not item.is_file():
                raise ReplicaError("Unsupported private database artifact")
        elif item.is_dir() and (
            item.name in {"cache", "generations"}
            or re.fullmatch(r"recovery-[A-Za-z0-9_-]+", item.name)
        ):
            continue
        else:
            raise ReplicaError("Unknown private artifact requires classification before backup")


# Complete backup receipts bind exact bytes, capabilities and snapshot coverage
def backup(
    root: Path, base: Path, output: Path, *, fault: Callable[[str], None] = no_fault
) -> dict[str, Any]:
    descriptor = descriptor_at(root)
    base = private_path(base, root)
    source, _ = location(base, descriptor)
    check_store_files(source)
    if private_path(output, root).is_relative_to(base):
        raise ReplicaError("Backups must be outside active server data and ordinary sync trees")
    output = new_directory(output, root)
    snapshot(source / "replica.db", output / "replica.db")
    fault("backup_after_snapshot")
    report = validate_snapshot(output / "replica.db", descriptor)
    if descriptor_at(root) != descriptor:
        raise ReplicaError("Library authority changed during backup")
    receipt = {
        "format": "cairndex.private-backup",
        "version": 1,
        "descriptor": descriptor.model_dump(mode="json"),
        "database": {
            "sha256": file_hash(output / "replica.db"),
            "bytes": (output / "replica.db").stat().st_size,
        },
        "inventory": report,
        "coverage": COVERAGE,
    }
    fault("backup_before_receipt")
    write_json(output / "receipt.json", receipt)
    return receipt | {"receipt": checksum(canonical(receipt))}


# A receipt is checked against independently parsed bytes and the selected package authority
def verify_backup(path: Path, descriptor: Identity) -> dict[str, Any]:
    if path.resolve() != path or {item.name for item in path.iterdir()} != {
        "replica.db",
        "receipt.json",
    }:
        raise ReplicaError("Incomplete or unsupported private backup set")
    receipt = read_json(path / "receipt.json")
    if set(receipt) != {"format", "version", "descriptor", "database", "inventory", "coverage"} or (
        receipt["format"] != "cairndex.private-backup"
        or receipt["version"] != 1
        or receipt["descriptor"] != descriptor.model_dump(mode="json")
        or receipt["coverage"] != COVERAGE
    ):
        raise ReplicaError("Backup schema or library authority differs from the selected package")
    database = path / "replica.db"
    if database.is_symlink() or receipt["database"] != {
        "sha256": file_hash(database),
        "bytes": database.stat().st_size,
    }:
        raise ReplicaError("Private backup checksum or length mismatch")
    if validate_snapshot(database, descriptor) != receipt["inventory"]:
        raise ReplicaError("Private backup inventory does not match its receipt")
    return receipt


# Detect changes to the previous store without treating a damaged database as disposable
def previous_state(path: Path, output: Path, descriptor: Identity) -> dict[str, Any]:
    if not path.exists():
        return {"state": "missing", "files": {}}
    check_store_files(path)
    files = {item.name: file_hash(item) for item in path.iterdir() if item.is_file()}
    if not (path / "replica.db").is_file():
        return {"state": "missing", "files": files}
    try:
        snapshot(path / "replica.db", output)
    except ReplicaError:
        return {"state": "damaged", "files": files}
    try:
        with closing(reader(output)) as db:
            validate_schema(db, catalog=isinstance(descriptor, CatalogDescriptor))
            config = dict(db.execute("SELECT key,value FROM config"))
            if (
                config.get("identity")
                != canonical(
                    [descriptor.library_uuid, descriptor.epoch, descriptor.genesis]
                ).decode()
            ):
                raise ReplicaError("Existing private storage belongs to another authority")
            if set(config) - {"identity", "replica", "blocked", "exchange_error", "catalog_ready"}:
                raise ReplicaError("Existing private configuration requires an upgrade")
    except sqlite3.Error:
        return {"state": "damaged", "files": files}
    try:
        report = validate_snapshot(output, descriptor)
    except ReplicaError:
        return {"state": "damaged", "files": files}
    with closing(reader(output)) as db:
        digest = {name: table_hash(db, name) for name in report["tables"]}
    return {"state": "valid", "tables": digest, "inventory": report}


# A reviewed recovery cannot hide newer private work that survives in the original store
def previous_gaps(previous: Path, prepared: Path) -> dict[str, int]:
    result = {}
    with closing(reader(prepared)) as db, closing(reader(previous)) as prior:
        tables = {row[0] for row in prior.execute("SELECT name FROM sqlite_master")}
        for table, keys, columns in (
            ("events", ("id",), ("id", "raw")),
            ("inbox", ("id",), ("id", "raw")),
            ("sources", ("name",), ("name", "artifact")),
            ("recovery_receipts", ("operation",), ("operation", "intent", "event")),
            ("recovery_authors", ("replica",), ("replica",)),
            ("drafts", ("id",), ("id", "bundle", "revision", "body")),
            ("draft_receipts", ("id",), ("id", "revision")),
            ("catalog_jobs", ("id",), ("id", "intent", "result")),
            ("discovery_candidates", ("id",), ("id", "run", "path", "body")),
            ("discovery_identities", ("path", "evidence"), ("path", "evidence", "file_id")),
            ("discovery_reviews", ("id",), ("id", "intent", "prepared", "event")),
            (
                "local_progress",
                ("file_id",),
                ("file_id", "generation", "position", "duration", "completed"),
            ),
            ("local_cursors", ("bundle_id",), ("bundle_id", "file_id")),
        ):
            if table not in tables:
                continue
            missing = 0
            where = " AND ".join(key + "=?" for key in keys)
            for row in prior.execute(f"SELECT {','.join(columns)} FROM {table}"):
                candidate = db.execute(
                    f"SELECT {','.join(columns)} FROM {table} WHERE {where}",
                    tuple(row[key] for key in keys),
                ).fetchone()
                missing += candidate is None or tuple(candidate) != tuple(row)
            result[table] = missing
    return result


# Prepare restores only into a new private directory and never publishes package objects
def prepare(
    root: Path,
    base: Path,
    backup_path: Path | None = None,
    *,
    fault: Callable[[str], None] = no_fault,
) -> dict[str, Any]:
    descriptor = descriptor_at(root)
    base = private_path(base, root)
    source, binding = location(base, descriptor)
    recovery_id = uuid4().hex
    directory = new_directory(base / "replica-recoveries" / recovery_id, root)
    original = previous_state(source, directory / "previous.db", descriptor)
    candidate = new_directory(directory / "candidate", root)
    backup_receipt = None
    if backup_path:
        backup_path = private_path(backup_path, root)
        backup_receipt = verify_backup(backup_path, descriptor)
        snapshot(backup_path / "replica.db", candidate / "replica.db")
    store = open_store(candidate, descriptor)
    with store.connection() as db:
        # Receipt aliases preserve already committed operations across every restored incarnation
        db.execute(
            "INSERT OR IGNORE INTO recovery_receipts SELECT operation,intent,id FROM events "
            "WHERE local=1 AND operation IS NOT NULL AND intent IS NOT NULL"
        )
        db.execute(
            "INSERT OR IGNORE INTO recovery_authors SELECT value FROM config WHERE key='replica'"
        )
        author = uuid4().hex
        db.execute("UPDATE config SET value=? WHERE key='replica'", (author,))
        if isinstance(store, CatalogStore):
            db.execute(
                "UPDATE catalog_jobs SET state='failed',error='Recovered pending work; "
                "review its exact intent and explicitly retry' WHERE state IN ('queued','running')"
            )
            db.execute(
                "UPDATE local_media SET generation=NULL,state='unknown',metadata=NULL,error=NULL"
            )
            db.execute("DELETE FROM discovery_baselines")
            db.execute(
                "UPDATE discovery_runs SET state='failed',error='Recovered "
                "Update; run Update again' WHERE state='running'"
            )
            db.execute(
                "UPDATE discovery_reviews SET state='failed',error='Recovered "
                "review; run Update and prepare again' WHERE state IN "
                "('queued','ready','apply_queued')"
            )
    fault("prepare_after_copy")
    transport = Transport(root, store)
    try:
        for name, raw in transport._objects():
            if name != "ignored":
                store.ingest(raw, f"recovery-{recovery_id}/{name}")
        settle(store)
    finally:
        transport.close()
    with store.connection(readonly=True) as db:
        only_backup = (
            db.execute(
                "SELECT COUNT(*) FROM events e WHERE NOT EXISTS "
                "(SELECT 1 FROM sources s WHERE s.artifact=e.id AND s.name LIKE ?)",
                (f"recovery-{recovery_id}/%",),
            ).fetchone()[0]
            if backup_path
            else 0
        )
        report = inventory(db)
    # Canonical immutable candidate snapshot is preserved when activation creates its live copy
    snapshot(store.path, directory / "prepared.db")
    validate_snapshot(directory / "prepared.db", descriptor)
    gaps = (
        previous_gaps(directory / "previous.db", directory / "prepared.db")
        if original["state"] == "valid"
        else {}
    )
    status = store.status()
    ready = status["ready"] and not (
        status["waiting"] or status["invalid"] or status["blocked"] or any(gaps.values())
    )
    if descriptor_at(root) != descriptor:
        raise ReplicaError("Library authority changed during recovery preparation")
    review = {
        "format": "cairndex.private-recovery",
        "version": 1,
        "id": recovery_id,
        "descriptor": descriptor.model_dump(mode="json"),
        "previous_binding": binding,
        "previous": original,
        "previous_database": file_hash(directory / "previous.db")
        if original["state"] == "valid"
        else None,
        "previous_private_gaps": gaps,
        "backup_receipt": checksum(canonical(backup_receipt)) if backup_receipt else None,
        "database": file_hash(directory / "prepared.db"),
        "inventory": report,
        "backup_only_events": only_backup,
        "coverage": COVERAGE,
        "state": "prepared" if ready else "blocked",
        "status": status,
        "pending_jobs": "Recovered queued/running jobs are retained as failed until "
        "exact-intent retry; drafts are never submitted automatically",
        "previous_store": "Original bytes remain at their existing private generation; "
        "a valid checkpoint is also retained in this recovery set",
    }
    fault("prepare_before_receipt")
    write_json(directory / "review.json", review)
    return review | {"receipt": checksum(canonical(review))}


# Recovery IDs select managed directories, never arbitrary server filesystem paths
def review_at(base: Path, identity: str) -> tuple[Path, dict[str, Any]]:
    if not re.fullmatch(r"[a-f0-9]{32}", identity):
        raise ReplicaError("Invalid private recovery identity")
    directory = base / "replica-recoveries" / identity
    if directory.resolve() != directory:
        raise ReplicaError("Recovery directory must not be linked")
    review = read_json(directory / "review.json")
    if set(review) != {
        "format",
        "version",
        "id",
        "descriptor",
        "previous_binding",
        "previous",
        "previous_database",
        "previous_private_gaps",
        "backup_receipt",
        "database",
        "inventory",
        "backup_only_events",
        "coverage",
        "state",
        "status",
        "pending_jobs",
        "previous_store",
    } or (
        review.get("format") != "cairndex.private-recovery"
        or review.get("version") != 1
        or review.get("id") != identity
    ):
        raise ReplicaError("Unknown private recovery review")
    return directory, review


# Explicit activation pins a reviewed candidate while the runtime lock excludes all server work
def activate(
    root: Path, base: Path, identity: str, receipt: str, *, fault: Callable[[str], None] = no_fault
) -> dict[str, Any]:
    descriptor = descriptor_at(root)
    base = private_path(base, root)
    guard = BindingLock(base, descriptor)
    try:
        directory, review = review_at(base, identity)
        if checksum(canonical(review)) != receipt or review["descriptor"] != descriptor.model_dump(
            mode="json"
        ):
            raise ReplicaError("Recovery review or authority changed; prepare and review again")
        if (directory / "cancelled.json").exists() or review["state"] != "prepared":
            raise ReplicaError(
                "Recovery is cancelled or blocked by incomplete history or private work"
            )
        source, binding = location(
            base, descriptor, pending=identity if review["previous_binding"] == "unbound" else None
        )
        target = base / "replicas" / descriptor.library_uuid / "generations" / identity
        if source == target:
            current = directory / f"active-{uuid4().hex}.db"
            snapshot(target / "replica.db", current)
            report = validate_snapshot(current, descriptor)
            return {"state": "active", "id": identity, "receipt": receipt, "inventory": report}
        if binding != review["previous_binding"]:
            raise ReplicaError("Active private generation changed; prepare a new recovery review")
        current = directory / f"check-{uuid4().hex}.db"
        if previous_state(source, current, descriptor) != review["previous"]:
            raise ReplicaError(
                "Original private state changed after review; prepare again to preserve new work"
            )
        prepared = directory / "prepared.db"
        if prepared.is_symlink() or file_hash(prepared) != review["database"]:
            raise ReplicaError("Prepared recovery checksum changed")
        report = validate_snapshot(prepared, descriptor)
        if report != review["inventory"]:
            raise ReplicaError("Prepared recovery inventory changed")
        if not report["ready"] or report["waiting"] or report["invalid"] or report["blocked"]:
            raise ReplicaError("Prepared recovery is blocked by incomplete history")
        if review["previous"]["state"] == "valid" and any(
            previous_gaps(current, prepared).values()
        ):
            raise ReplicaError("Prepared recovery is blocked by surviving original private work")
        if target.exists():
            # Interrupted activation may leave a complete unpublished generation, never overwrite it
            if file_hash(target / "replica.db") != review["database"]:
                raise ReplicaError("Interrupted recovery target changed; prepare a new recovery")
        else:
            new_directory(target, root)
            # These immutable verified bytes install into a new generation, never over a live DB
            with prepared.open("rb") as source_file, (target / "replica.db").open("xb") as dest:
                os.chmod(target / "replica.db", 0o600)
                shutil.copyfileobj(source_file, dest)
                dest.flush()
                os.fsync(dest.fileno())
            if file_hash(target / "replica.db") != review["database"]:
                raise ReplicaError("Recovery installation checksum changed")
            sync_directory(target)
        fault("activate_before_binding")
        if descriptor_at(root) != descriptor:
            raise ReplicaError("Library authority changed during activation")
        bind(base, descriptor, identity, receipt)
        fault("activate_after_binding")
        return {
            "state": "active",
            "id": identity,
            "receipt": receipt,
            "author": review["inventory"]["author"],
        }
    finally:
        guard.close()


# Cancellation is durable and leaves the candidate and original evidence available for inspection
def cancel(root: Path, base: Path, identity: str, receipt: str) -> dict[str, Any]:
    descriptor = descriptor_at(root)
    base = private_path(base, root)
    guard = BindingLock(base, descriptor)
    try:
        directory, review = review_at(base, identity)
        if checksum(canonical(review)) != receipt:
            raise ReplicaError("Recovery review changed")
        active, _ = location(base, descriptor)
        if active.name == identity:
            raise ReplicaError(
                "An active recovery cannot be cancelled; prepare a separate recovery"
            )
        if not (directory / "cancelled.json").exists():
            write_json(directory / "cancelled.json", {"receipt": receipt})
        return {"state": "cancelled", "id": identity}
    finally:
        guard.close()
