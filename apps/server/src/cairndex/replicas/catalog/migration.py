"""Durable format-three preparation for disposable, quiescent legacy fixtures.

There is no registration or activation entry point. A fixture object is a test
boundary, not authority to operate on an owner's library.
"""

import hashlib
import re
import sqlite3
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from cairndex.devtools.catalog_fixture import DisposableCatalog, create_schema
from cairndex.replicas.binding import BindingLock, read_json, write_json
from cairndex.replicas.catalog.conversion import Conversion, prepare_disposable, verify_archive
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import PackageIdentity, ReplicaError, canonical, checksum
from cairndex.replicas.store import no_fault


def source_receipt(fixture: DisposableCatalog) -> dict[str, str]:
    """Hash complete fixture state; SQLite values include committed WAL records.

    This complete source read is for small synthetic fixtures only. Real-library
    inventory needs a separately reviewed, bounded checkpoint procedure.
    """
    result = {}
    for root in (fixture.source, fixture.directory / "private"):
        if root.resolve() != root.absolute():
            raise ReplicaError("Migration source must not be linked")
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise ReplicaError("Migration source must not be linked")
            relative = str(path.relative_to(fixture.directory))
            if path.is_dir():
                result[relative + "/"] = "directory"
            elif path.name in ("library.db", "plans.db"):
                digest = hashlib.sha256()
                with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
                    db.execute("BEGIN")
                    digest.update(repr(db.execute("PRAGMA user_version").fetchone()).encode())
                    for row in db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name"):
                        digest.update(repr(row).encode())
                    for (table,) in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                    ):
                        quoted = '"' + table.replace('"', '""') + '"'
                        columns = db.execute(f"PRAGMA table_info({quoted})").fetchall()
                        order = ",".join(str(i + 1) for i in range(len(columns)))
                        for row in db.execute(f"SELECT * FROM {quoted} ORDER BY {order}"):
                            digest.update(repr(row).encode())
                result[relative] = digest.hexdigest()
            elif path.name in ("library.db-wal", "library.db-shm", "plans.db-wal", "plans.db-shm"):
                # Their durable values are in the SQLite read transaction above.
                continue
            elif path.is_file():
                with path.open("rb") as stream:
                    result[relative] = hashlib.file_digest(stream, "sha256").hexdigest()
            else:
                raise ReplicaError("Unsupported source entry blocks migration")
    return result


def validate_source_schema(fixture: DisposableCatalog) -> None:
    """Refuse unqualified table definitions, indexes and schema versions.

    Column-name equality alone cannot detect changed types, constraints or
    indexes. This preparer accepts only the fixture schema that it can verify.
    """
    from cairndex.metadata.schema import table_definitions, trigger_definitions
    from cairndex.replicas.catalog.seed import validate_checkpoint

    source = fixture.source / ".cairndex/library.db"
    plans = fixture.directory / "private/plans.db"
    with (
        sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as db,
        sqlite3.connect(":memory:") as expected,
    ):
        db.execute("ATTACH DATABASE ? AS plans", (plans.as_uri() + "?mode=ro",))
        db.execute("BEGIN")
        expected.execute("ATTACH DATABASE ':memory:' AS plans")
        create_schema(expected)
        validate_checkpoint(db)
        for name in ("main", "plans"):
            if db.execute(f"PRAGMA {name}.user_version").fetchone()[0] != 0:
                raise ReplicaError("Unqualified source schema version blocks migration")
            query = f"SELECT name,sql FROM {name}.sqlite_master WHERE sql IS NOT NULL"
            known = dict(expected.execute(query))
            actual = dict(db.execute(query))
            tables = table_definitions(name)
            if any(table in actual for table in tables):
                known.update(tables)
                known.update(trigger_definitions(name))
                if name == "main":
                    known["ix_metadata_pending_grouping"] = (
                        "CREATE INDEX ix_metadata_pending_grouping "
                        "ON metadata_receipts(operation) WHERE grouping_settlement IS NOT NULL"
                    )
            if actual != known:
                raise ReplicaError("Unqualified source schema definition blocks migration")


def prepare(fixture: DisposableCatalog, *, fault: Callable[[str], None] = no_fault) -> Conversion:
    """Prepare or verify one exact format-three intent without changing its source.

    Each interrupted attempt remains intact. Retry uses the original epoch and
    checkpoint values in a new attempt. Completed retries reuse the same result.
    """
    directory = fixture.directory / "migration"
    if directory.resolve() != directory.absolute():
        raise ReplicaError("Migration state must not be linked")
    directory.mkdir(mode=0o700, exist_ok=True)
    identity = PackageIdentity(
        format="cairndex.replica-library",
        library_uuid=fixture.library_uuid,
        display_name="Synthetic migration",
        epoch="preparation",
        genesis="0" * 64,
    )
    lock = BindingLock(directory, identity)
    try:
        intent_path = directory / "intent.json"
        sources = source_receipt(fixture)
        validate_source_schema(fixture)
        if not intent_path.exists():
            if any(path.name != "replica-bindings" for path in directory.iterdir()):
                raise ReplicaError("Migration intent is missing; retain the incomplete work")
            write_json(
                intent_path,
                {
                    "version": 1,
                    "library_uuid": fixture.library_uuid,
                    "epoch": uuid4().hex,
                    "sources": sources,
                },
            )
        intent = read_json(intent_path)
        if (
            set(intent) != {"version", "library_uuid", "epoch", "sources"}
            or type(intent["version"]) is not int
            or intent["version"] != 1
            or intent["library_uuid"] != fixture.library_uuid
            or intent["sources"] != sources
            or not isinstance(intent["epoch"], str)
            or re.fullmatch(r"[a-f0-9]{32}", intent["epoch"]) is None
        ):
            raise ReplicaError("Migration checkpoint changed; retain the original intent")
        fault("intent_complete")
        receipt_path = directory / "prepared.json"
        if receipt_path.exists():
            receipt = read_json(receipt_path)
            if (
                set(receipt) != {"intent", "attempt", "descriptor", "objects"}
                or receipt["intent"] != checksum(canonical(intent))
                or not isinstance(receipt["attempt"], str)
                or not re.fullmatch(r"conversion-[a-f0-9]{32}", receipt["attempt"])
            ):
                raise ReplicaError("Migration preparation receipt changed")
            target = fixture.directory / receipt["attempt"]
            if target.resolve() != target:
                raise ReplicaError("Migration candidate must not be linked")
            archive, package = target / "recovery", target / "package"
            verify_archive(archive)
            descriptor = CatalogDescriptor.model_validate(receipt["descriptor"])
            if read_json(package / ".cairndex/manifest.json") != descriptor.model_dump():
                raise ReplicaError("Migration descriptor changed")
            if (
                descriptor.library_uuid != fixture.library_uuid
                or descriptor.epoch != intent["epoch"]
                or descriptor.format_version != 3
            ):
                raise ReplicaError("Migration candidate identity changed")
            objects = object_receipt(package)
            if objects != receipt["objects"]:
                raise ReplicaError("Migration seed objects changed")
            store = CatalogStore(target / "replica", descriptor)
            if not store.status()["ready"] or store.status()["blocked"]:
                raise ReplicaError("Migration private candidate requires recovery")
            return Conversion(fixture, archive, package, store)
        converted = prepare_disposable(
            fixture, format_version=3, epoch=intent["epoch"], fault=fault
        )
        if source_receipt(fixture) != sources:
            raise ReplicaError("Migration source changed during preparation")
        fault("before_receipt")
        write_json(
            receipt_path,
            {
                "intent": checksum(canonical(intent)),
                "attempt": converted.archive.parent.name,
                "descriptor": converted.store.descriptor.model_dump(),
                "objects": object_receipt(converted.package),
            },
        )
        fault("after_receipt")
        return converted
    finally:
        lock.close()


def object_receipt(package: Path) -> dict[str, str]:
    """Require exact seed bytes and refuse linked metadata before a completed retry."""
    result = {}
    metadata = package / ".cairndex"
    if metadata.resolve() != metadata:
        raise ReplicaError("Migration metadata must not be linked")
    for path in metadata.rglob("*"):
        if path.is_symlink():
            raise ReplicaError("Migration metadata must not be linked")
        if path.is_file():
            result[str(path.relative_to(metadata))] = checksum(path.read_bytes())
    return result
