"""Executable conversion and rollback restricted to complete disposable synthetic catalogs"""

import json
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from cairndex.devtools.catalog_fixture import DisposableCatalog, insert_row
from cairndex.replicas.catalog.model import AUTHORED, IDENTITIES
from cairndex.replicas.catalog.protocol import CAPABILITIES, CatalogDescriptor, payload
from cairndex.replicas.catalog.seed import seed_changes, validate_checkpoint
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import PACKAGE_FORMAT, ReplicaError, canonical, checksum


# A reviewed synthetic checkpoint owns its private recovery tree and candidate package
@dataclass(frozen=True)
class Conversion:
    fixture: DisposableCatalog
    archive: Path
    package: Path
    store: CatalogStore


# Refuse links and changed recovery files before using an archived authority
def verify_archive(archive: Path) -> None:
    receipt = json.loads((archive / "receipt.json").read_text())
    if set(receipt) != {"files"} or set(receipt["files"]) != {
        "library.db",
        "plans.db",
        "manifest.json",
        "synthetic-auth.json",
    }:
        raise ReplicaError("Unrecognized conversion recovery receipt")
    for name, digest in receipt["files"].items():
        file = archive / name
        if file.is_symlink() or checksum(file.read_bytes()) != digest:
            raise ReplicaError("Conversion recovery archive changed")


# Capture both databases from one quiescent synthetic checkpoint without mutating the source
def prepare_disposable(fixture: DisposableCatalog) -> Conversion:
    import base64

    from cairndex.replicas.catalog.model import normalize_value

    source = fixture.source / ".cairndex"
    private = fixture.directory / "private"
    if fixture.directory.is_symlink() or source.is_symlink() or private.is_symlink():
        raise ReplicaError("Disposable conversion refuses linked storage")
    manifest_raw = (source / "manifest.json").read_bytes()
    manifest = json.loads(normalize_value(manifest_raw.decode()))
    if (
        manifest.get("library_uuid") != fixture.library_uuid
        or manifest.get("format") != "cairndex.library"
    ):
        raise ReplicaError("Disposable source identity changed")
    if (
        manifest.get("format_version") != 1
        or type(manifest.get("format_version")) is not int
        or manifest.get("db") != "library.db"
        or manifest.get("content_root") != "."
    ):
        raise ReplicaError("Unsupported source format or storage layout blocks conversion")
    if set(manifest) - {"auth"} != {
        "format",
        "format_version",
        "library_uuid",
        "display_name",
        "db",
        "content_root",
        "created_at",
    }:
        raise ReplicaError("Unknown durable manifest field blocks conversion")
    if {path.name for path in source.iterdir()} - {
        "manifest.json",
        "library.db",
        "library.db-wal",
        "library.db-shm",
        "cache",
    }:
        raise ReplicaError("Unclassified package metadata blocks conversion")
    if "auth" in manifest:
        auth = manifest["auth"]
        try:
            valid = (
                isinstance(auth, dict)
                and set(auth) == {"scheme", "iterations", "salt", "hash"}
                and auth["scheme"] == "pbkdf2_sha256"
                and type(auth["iterations"]) is int
                and auth["iterations"] > 0
                and len(base64.b64decode(auth["salt"], validate=True)) == 16
                and len(base64.b64decode(auth["hash"], validate=True)) == 32
            )
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise ReplicaError("Unrecognized private auth configuration blocks conversion")
    if {path.name for path in private.iterdir()} - {
        "plans.db",
        "plans.db-wal",
        "plans.db-shm",
        "synthetic-auth.json",
    }:
        raise ReplicaError("Unclassified private state blocks disposable conversion")
    record = json.loads(normalize_value((private / "synthetic-auth.json").read_text()))
    if (
        not isinstance(record, dict)
        or set(record) != {"synthetic"}
        or not isinstance(record["synthetic"], str)
    ):
        raise ReplicaError("Unsupported private auth record blocks disposable conversion")
    for file in (
        source / "manifest.json",
        source / "library.db",
        private / "plans.db",
        private / "synthetic-auth.json",
    ):
        if file.is_symlink():
            raise ReplicaError("Disposable conversion refuses linked files")
    target = fixture.directory / f"conversion-{uuid4().hex}"
    target.mkdir()
    archive, package = target / "recovery", target / "package"
    archive.mkdir()
    with sqlite3.connect(f"file:{source / 'library.db'}?mode=ro", uri=True) as original:
        original.execute("ATTACH DATABASE ? AS plans", (f"file:{private / 'plans.db'}?mode=ro",))
        original.execute("BEGIN")
        validate_checkpoint(original)
        for schema, name in (("main", "library.db"), ("plans", "plans.db")):
            with sqlite3.connect(archive / name) as destination:
                original.backup(destination, name=schema)
        original.rollback()
    (archive / "manifest.json").write_bytes(manifest_raw)
    shutil.copyfile(private / "synthetic-auth.json", archive / "synthetic-auth.json")
    hashes = {file.name: checksum(file.read_bytes()) for file in archive.iterdir()}
    (archive / "receipt.json").write_bytes(canonical({"files": hashes}))
    verify_archive(archive)
    epoch = uuid4().hex
    objects = package / ".cairndex" / "replica" / "objects"
    objects.mkdir(parents=True)
    with sqlite3.connect(archive / "library.db") as db:
        db.execute("ATTACH DATABASE ? AS plans", (str(archive / "plans.db"),))
        validate_checkpoint(db)
        genesis = ""
        for identity, raw in payload(
            seed_changes(db),
            library=fixture.library_uuid,
            epoch=epoch,
            replica="seed",
            operation="seed",
            seed=True,
        ):
            folder = objects / identity[:2]
            folder.mkdir(exist_ok=True)
            (folder / f"{identity}.json").write_bytes(raw)
            genesis = identity
    descriptor = CatalogDescriptor(
        format=PACKAGE_FORMAT,
        format_version=2,
        protocol_version=2,
        catalog_version=1,
        minimum_reader=2,
        capabilities=CAPABILITIES,
        library_uuid=fixture.library_uuid,
        display_name="Synthetic complete catalog",
        epoch=epoch,
        genesis=genesis,
    )
    store = CatalogStore(target / "replica", descriptor)
    for file in objects.glob("*/*.json"):
        store.ingest(file.read_bytes())
    with store.connection() as db:
        count = db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0]
    for _ in range(count + 1):
        store.import_batch()
        state = store.status()
        if state["blocked"]:
            raise ReplicaError("Independent seed reconstruction failed")
        if state["ready"]:
            break
    if not store.status()["ready"]:
        raise ReplicaError("Incomplete candidate seed cannot activate")
    conversion = Conversion(fixture, archive, package, store)
    restored = export_legacy(conversion)
    compare_checkpoints(archive / "library.db", restored / "library.db")
    # Only a fully reconstructed, exactly reversible disposable package receives a descriptor
    (package / ".cairndex" / "manifest.json").write_bytes(canonical(descriptor.model_dump()))
    return conversion


# Export the valid projection into a separate copy while archiving all new branches and drafts
def export_legacy(conversion: Conversion) -> Path:
    verify_archive(conversion.archive)
    output = conversion.archive.parent / f"rollback-{uuid4().hex}"
    output.mkdir()
    for name in ("library.db", "plans.db", "manifest.json", "synthetic-auth.json"):
        shutil.copyfile(conversion.archive / name, output / name)
    with conversion.store.connection() as replica:
        # Preserve all unpublished events, conflict branches, drafts and receipts at this checkpoint
        # A second read connection allows the backup API while the first excludes new writers
        with (
            sqlite3.connect(conversion.store.path) as reader,
            sqlite3.connect(output / "replica-recovery.db") as backup,
        ):
            reader.backup(backup)
        with sqlite3.connect(output / "library.db") as legacy:
            legacy.row_factory = sqlite3.Row
            legacy.execute("BEGIN IMMEDIATE")
            for family in AUTHORED:
                identities = IDENTITIES[family]
                where = " AND ".join(f'"{column}"=?' for column in identities)
                legacy.execute(f"CREATE TEMP TABLE saved_{family} AS SELECT * FROM {family}")
                legacy.execute(f"DELETE FROM {family}")
                for (body,) in replica.execute(
                    "SELECT body FROM catalog_rows WHERE family=? ORDER BY entity", (family,)
                ):
                    authored = json.loads(body)
                    prior = legacy.execute(
                        f"SELECT * FROM saved_{family} WHERE {where}",
                        tuple(authored[column] for column in identities),
                    ).fetchone()
                    if prior is None and family in ("asset_bundles", "asset_files"):
                        from cairndex.devtools.catalog_fixture import synthetic_row

                        # New synthetic catalog identities have no inherited device observations
                        complete = synthetic_row(family, authored["id"])
                        if family == "asset_files":
                            complete.update(
                                availability="MISSING", directory_path="", media_kind="OTHER"
                            )
                    else:
                        complete = dict(prior) if prior else {}
                    complete.update(authored)
                    insert_row(legacy, family, complete)
            # Old resume records remain in the immutable archive when their file is deleted
            legacy.execute(
                "DELETE FROM playback_progress WHERE file_id NOT IN (SELECT id FROM asset_files)"
            )
            legacy.execute(
                "UPDATE playback_progress SET bundle_id="
                "(SELECT bundle_id FROM asset_files WHERE id=file_id)"
            )
            legacy.execute(
                "DELETE FROM bundle_cursors WHERE file_id NOT IN (SELECT id FROM asset_files) "
                "OR bundle_id NOT IN (SELECT id FROM asset_bundles)"
            )
            if legacy.execute("PRAGMA foreign_key_check").fetchone():
                raise ReplicaError("Rollback projection contains unresolved relationships")
            if legacy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ReplicaError("Rollback integrity check failed")
        counts = {
            "events": replica.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            "drafts": replica.execute("SELECT COUNT(*) FROM drafts").fetchone()[0],
            "held_units": replica.execute("SELECT COUNT(*) FROM catalog_holds").fetchone()[0],
        }
    (output / "rollback-receipt.json").write_bytes(
        canonical(
            {
                "private_recovery": "replica-recovery.db",
                "projection": "last valid local view",
                "retained": counts,
                "real_activation_available": False,
            }
        )
    )
    return output


# Full row/cell comparison preserves relationships, NULL, order, timestamps and numeric values
def compare_checkpoints(first: Path, second: Path) -> None:
    with sqlite3.connect(first) as left, sqlite3.connect(second) as right:
        tables = [
            row[0]
            for row in left.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        other = [
            row[0]
            for row in right.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        if tables != other:
            raise ReplicaError("Reversible checkpoint table mismatch")
        for table in tables:
            columns = [row[1] for row in left.execute(f'PRAGMA table_info("{table}")')]
            if columns != [row[1] for row in right.execute(f'PRAGMA table_info("{table}")')]:
                raise ReplicaError("Reversible checkpoint column mismatch")
            order = ",".join(f'"{column}"' for column in columns)
            a = left.execute(f'SELECT * FROM "{table}" ORDER BY {order}')
            b = right.execute(f'SELECT * FROM "{table}" ORDER BY {order}')
            while True:
                rows_a, rows_b = a.fetchmany(256), b.fetchmany(256)
                if rows_a != rows_b:
                    raise ReplicaError("Reversible checkpoint changed durable values")
                if not rows_a:
                    break
