"""Strict immutable source receipts; receiving a receipt never moves source bytes."""

import json
import sqlite3
from typing import Any, Literal

from pydantic import Field, ValidationError

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.protocol import Root, UnitChange, decode
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import MAX_BYTES, Digest, ReplicaError, StrictModel, Token
from cairndex.replicas.source_files import source_path


class ContentVersion(StrictModel):
    algorithm: Literal["sha256", "tree-sha256-v1"]
    size: int = Field(ge=0, le=1024**4)
    digest: Digest


class SourceVersion(StrictModel):
    operation: Token
    version: Literal["source", "destination"]
    evidence: ContentVersion


class SourceMetadata(StrictModel):
    changes: list[UnitChange] = Field(min_length=1, max_length=4096)
    parents: list[Digest] = Field(max_length=128)
    resolve: bool
    recover: bool


class SourceReceipt(StrictModel):
    version: Literal[1]
    library: Token
    epoch: Token
    operation: Token
    action: Literal["copy", "rename", "move", "trash", "undo", "restore"]
    event: Digest | None
    source: str = Field(max_length=4096)
    destination: str = Field(max_length=4096)
    versions_before: dict[str, SourceVersion | None] = Field(min_length=1, max_length=2)
    versions_after: dict[str, SourceVersion | None] = Field(min_length=1, max_length=2)
    undo_of: Token | None
    restores: dict[str, list[Digest]] = Field(max_length=4096)
    metadata: SourceMetadata | None
    before: dict[str, str | None] = Field(max_length=4096)


def parse(store: CatalogStore, raw: str) -> SourceReceipt:
    if len(raw.encode()) > MAX_BYTES:
        raise ReplicaError("Source receipt exceeds its bounded size")
    try:
        receipt = SourceReceipt.model_validate_json(raw)
    except ValidationError as error:
        raise ReplicaError("Unsupported source receipt; retain it for recovery review") from error
    if (
        value_text(receipt.model_dump(mode="json")) != raw
        or receipt.library != store.descriptor.library_uuid
        or receipt.epoch != store.descriptor.epoch
        or set(receipt.versions_before) != set(receipt.versions_after)
        or (receipt.metadata is None) != (receipt.event is None)
        or (receipt.action == "undo") != (receipt.undo_of is not None)
    ):
        raise ReplicaError("Source receipt identity or complete intent is inconsistent")
    for path in receipt.versions_before:
        source_path(path)
    for path in (receipt.source, receipt.destination):
        if path:
            source_path(path)
    return receipt


def dependencies(store: CatalogStore, db: sqlite3.Connection, receipt: SourceReceipt) -> bool:
    """Bind inverse metadata to the actual accepted event, not an untrusted description."""
    if receipt.action != "undo" and receipt.restores:
        raise ReplicaError("Only a conditional Undo can restore prior revisions")
    if receipt.undo_of:
        row = db.execute(
            "SELECT raw FROM source_receipts WHERE id=? AND state IN ('local','accepted')",
            (receipt.undo_of,),
        ).fetchone()
        if row is None:
            return False
        prior = parse(store, row[0])
        if receipt.versions_after != prior.versions_before:
            raise ReplicaError("Undo does not restore its recorded content versions")
        changes = (
            {change.unit: change for change in prior.metadata.changes} if prior.metadata else {}
        )
        inverse = (
            {change.unit: change for change in receipt.metadata.changes} if receipt.metadata else {}
        )
        for unit, bases in receipt.restores.items():
            if (
                unit not in changes
                or bases != changes[unit].basis
                or unit not in inverse
                or inverse[unit].value != prior.before[unit]
            ):
                raise ReplicaError("Undo revision lineage differs from its recorded inverse")
    if receipt.event is None:
        if receipt.before or receipt.restores:
            raise ReplicaError("A source-only receipt cannot assert metadata history")
        return True
    row = db.execute("SELECT raw FROM events WHERE id=?", (receipt.event,)).fetchone()
    if not row:
        return False
    _, root = decode(row[0], store.descriptor)
    if (
        not isinstance(root, Root)
        or root.kind != "catalog_source_edit"
        or root.operation != receipt.operation
    ):
        raise ReplicaError("Source receipt does not name its catalog operation")
    metadata = receipt.metadata
    assert metadata is not None
    actual = [change.model_dump(mode="json") for change in store.payload_records(db, root)]
    if (
        actual != [change.model_dump(mode="json") for change in metadata.changes]
        or root.parents != metadata.parents
        or root.resolve != metadata.resolve
        or root.recover != metadata.recover
        or set(receipt.before) != {change.unit for change in metadata.changes}
    ):
        raise ReplicaError("Source receipt differs from its accepted catalog event")
    for change in metadata.changes:
        values = {
            db.execute(
                "SELECT value FROM catalog_revisions WHERE unit=? AND event=?", (change.unit, basis)
            ).fetchone()[0]
            for basis in change.basis
        }
        before = receipt.before[change.unit]
        if values and values != {before} or not values and before is not None:
            raise ReplicaError("Source inverse differs from its observed catalog basis")
    return True


def validate_private(db: sqlite3.Connection, store: CatalogStore) -> None:
    from cairndex.replicas.source_journal import SourceRequest

    for row in db.execute("SELECT * FROM source_uploads"):
        from cairndex.replicas.catalog.model import TOKEN

        if (
            not TOKEN.fullmatch(row["id"])
            or not 0 <= row["size"] <= 128 * 1024**3
            or row["state"] not in {"receiving", "ready", "interrupted"}
        ):
            raise ReplicaError("Private source upload state is inconsistent")
        if row["evidence"]:
            evidence = ContentVersion.model_validate_json(row["evidence"])
            if evidence.size != row["size"]:
                raise ReplicaError("Private upload evidence has a different size")
        elif row["state"] == "ready":
            raise ReplicaError("Completed upload is missing content evidence")
    for row in db.execute("SELECT * FROM source_operations"):
        request = SourceRequest.model_validate_json(row["intent"])
        if (
            request.operation != row["id"]
            or row["state"]
            not in {
                "queued",
                "preparing",
                "prepared",
                "accepted",
                "applying",
                "succeeded",
                "interrupted",
                "cancelled",
            }
            or row["phase"] not in {"prepare", "apply", "complete"}
            or row["progress"] < 0
        ):
            raise ReplicaError("Private source operation state is inconsistent")
        if row["review"]:
            review: dict[str, Any] = json.loads(row["review"])
            if not review["skipped"]:
                for path in review["conditions"]:
                    source_path(path)
                if review["metadata"]:
                    SourceMetadata.model_validate(review["metadata"])
        if row["result"]:
            result = json.loads(row["result"])
            for path, raw in result.get("retained_versions", {}).items():
                if path:
                    source_path(path)
                version = SourceVersion.model_validate(raw)
                if version.operation != request.operation:
                    raise ReplicaError("Private retained version belongs to another operation")
        if (
            row["state"] == "succeeded"
            and row["result"] != "{}"
            and not db.execute("SELECT 1 FROM source_receipts WHERE id=?", (row["id"],)).fetchone()
        ):
            raise ReplicaError("Completed source operation is missing its immutable receipt")
    for row in db.execute("SELECT * FROM source_receipts"):
        if row["state"] not in {"local", "accepted", "pending", "invalid"}:
            raise ReplicaError("Unsupported private source receipt state")
        if row["state"] == "invalid":
            continue
        receipt = parse(store, row["raw"])
        if receipt.operation != row["id"]:
            raise ReplicaError("Private source receipt has a different identity")
        if row["state"] in {"local", "accepted"} and not dependencies(store, db, receipt):
            raise ReplicaError("Source receipt is missing its catalog dependency")
