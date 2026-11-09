"""Journaled filesystem phases with exact receipts and conservative restart checks."""

import errno
import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import (
    artifact_identity,
    assert_observation,
    capture,
    consume_output,
    observation,
    publish_output,
    stage_output,
)
from cairndex.replicas.source_journal import SourceRequest
from cairndex.replicas.source_plan import prepare


def checkpoint(store: CatalogStore, operation: str, result: dict[str, Any]) -> None:
    with store.connection() as db:
        state = db.execute(
            "SELECT state FROM source_operations WHERE id=?", (operation,)
        ).fetchone()
        if state is None or state[0] != "applying":
            raise ReplicaError("Source application stopped before its next filesystem step")
        db.execute(
            "UPDATE source_operations SET result=? WHERE id=?", (value_text(result), operation)
        )


def output_samples(root: Path, outputs: list[tuple[str, Any]]) -> dict[str, dict[str, Any]]:
    """Sample each published large file once, before the catalog transaction.

    A complete hash cannot be recomputed cheaply after a share is mounted again,
    so the baseline also keeps the samples an ordinary scan reads. Unreadable
    outputs simply get no sample; they then need explicit verification.
    """
    from cairndex.replicas.discovery_sources import inspect

    samples = {}
    for path, evidence in outputs:
        if evidence["algorithm"] != "sha256":
            continue
        try:
            observed = inspect(root, path)
        except (OSError, ReplicaError):
            continue
        if observed["evidence"]["algorithm"] != "sha256":
            samples[path] = observed
    return samples


def reviewed_metadata(store: CatalogStore, review: dict[str, Any]) -> None:
    """Check the reviewed causal basis immediately before the first destructive step."""
    if not review["metadata"]:
        return
    with store.connection(readonly=True) as db:
        for change in review["metadata"]["changes"]:
            if set(change["basis"]) != {tip["event"] for tip in store.tips(db, change["unit"])}:
                raise ReplicaError("Catalog changed after source review; prepare a new review")


def apply(
    store: CatalogStore,
    root: Path,
    request: SourceRequest,
    review: dict[str, Any],
    result: dict[str, Any],
    progress: Callable[[int], None],
    authorize: Callable[[], None],
) -> None:
    if request.action in {"relocate", "retain", "return", "purge"}:
        from cairndex.replicas.source_original import apply_original

        apply_original(store, root, request, review, result, authorize)
        return
    if review["skipped"]:
        with store.connection() as db:
            db.execute(
                "UPDATE source_operations SET state='succeeded',result='{}' WHERE id=?",
                (request.operation,),
            )
        return
    info = root.stat(follow_symlinks=False)
    if [info.st_dev, info.st_ino] != review["root_identity"]:
        raise ReplicaError("Library root changed after review; source operations are stopped")
    if "parent_identity" in review:
        from cairndex.replicas.source_files import parent

        with parent(root, review["destination"]) as (handle, _):
            info = os.fstat(handle)
            if [info.st_dev, info.st_ino] != review["parent_identity"]:
                raise ReplicaError(
                    "Destination parent changed after review; create a new operation"
                )
    outputs = [(path, version) for path, version in review["versions_after"].items() if version]
    if not result.get("started"):
        from cairndex.replicas.source_claims import probe

        probe(root, request.operation)
        if request.action == "undo":
            with store.connection(readonly=True) as db:
                if db.execute(
                    "SELECT 1 FROM source_receipts WHERE json_extract(raw,'$.undo_of')=? "
                    "AND state IN ('local','accepted')",
                    (request.prior,),
                ).fetchone():
                    raise ReplicaError("This operation already has a completed Undo")
        reviewed_metadata(store, review)
        for path, expected in review["conditions"].items():
            assert_observation(root, path, expected)
        result["outputs"] = {}
        for index, (path, version) in enumerate(outputs):
            name = f"output-stage-{index}"
            if (
                request.action == "copy"
                and "version_stamp" in review
                and version["version"] == "source"
                and version["operation"] in (request.operation, request.upload)
                and version["evidence"]["algorithm"] == "sha256"
            ):
                # The copy's own version becomes its output; no duplicate is kept.
                # Reviews from before the stamp keep the independent copy.
                result["outputs"][path] = consume_output(
                    root,
                    request.operation,
                    version["operation"],
                    version["evidence"],
                    review["version_stamp"],
                    progress,
                    request.byte_limit,
                    name,
                )
                result["kept_copy"] = False
                continue
            result["outputs"][path] = stage_output(
                root,
                request.operation,
                version["operation"],
                version["version"],
                version["evidence"],
                progress,
                request.byte_limit,
                name,
            )
        # Staging can take substantial time. Do not capture originals against
        # conditions checked only before that copy began.
        reviewed_metadata(store, review)
        for path, expected in review["conditions"].items():
            assert_observation(root, path, expected)
        result["started"] = True
        checkpoint(store, request.operation, result)
        store.fault("source_before_capture")
    for item in review["captures"]:
        authorize()
        name, path, expected = item["name"], item["path"], item["expected"]
        prior = artifact_identity(root, request.operation, name)
        if name in result:
            if prior != expected["identity"]:
                raise ReplicaError("Captured bytes changed; retain them for recovery review")
            continue
        if prior is None:
            capture(root, path, request.operation, name, expected)
        elif prior != expected["identity"]:
            raise ReplicaError("Captured bytes changed; retain them for recovery review")
        result[name] = True
        store.fault("source_after_" + name.replace("-", "_"))
        checkpoint(store, request.operation, result)
    for index, (path, _) in enumerate(outputs):
        authorize()
        marker = f"published-{index}"
        if result.get(marker):
            continue
        publish_output(
            root,
            request.operation,
            path,
            result["outputs"][path],
            f"output-stage-{index}",
            parent_identity=review.get("parent_identity"),
        )
        store.fault("source_after_publication")
        result[marker] = True
        checkpoint(store, request.operation, result)
    file_outputs = []
    for path, version in outputs:
        if version["evidence"]["algorithm"] == "tree-sha256-v1":
            from cairndex.replicas.source_catalog import tree_index

            for item in tree_index(
                root, version["operation"], version["version"], version["evidence"]
            ):
                if not item["directory"]:
                    file_outputs.append((path + "/" + item["path"], item["evidence"]))
        else:
            file_outputs.append((path, version["evidence"]))
    samples = output_samples(root, file_outputs)
    with store.connection() as db:
        event = None
        metadata = review["metadata"]
        if metadata:
            event = store.save_in(
                db,
                [UnitChange.model_validate(change) for change in metadata["changes"]],
                request.operation,
                parents=metadata["parents"],
                resolve=metadata["resolve"],
                recover=metadata["recover"],
                source=True,
            )
        result["event"] = event
        result["after"] = {path: observation(root, path) for path in review["versions_after"]}
        for path, version in review["versions_after"].items():
            if version is None and result["after"][path] is not None:
                raise ReplicaError(
                    "New source bytes arrived before catalog commit; recovery review is required"
                )
        for path, _ in outputs:
            seen = result["after"][path]
            if seen is None or seen["identity"] != result["outputs"][path]:
                raise ReplicaError(
                    "Output changed before catalog commit; recovery review is required"
                )
        from cairndex.replicas.source_plan import path_identity

        allowed_generations = {seen["generation"] for seen in review["conditions"].values() if seen}
        allowed_generations.update(review.get("file_generations", []))
        if request.action == "undo":
            prior = db.execute(
                "SELECT review FROM source_operations WHERE id=?", (request.prior,)
            ).fetchone()
            if prior and prior[0]:
                allowed_generations.update(json.loads(prior[0]).get("file_generations", []))
                allowed_generations.update(
                    seen["generation"]
                    for seen in json.loads(prior[0])["conditions"].values()
                    if seen
                )
        for path, evidence in file_outputs:
            identity = path_identity(db, path)
            seen = observation(root, path)
            if identity and seen:
                from cairndex.replicas.source_files import parent

                with parent(root, path) as (parent_fd, name):
                    info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                baseline = {
                    "path": path,
                    "generation": seen["generation"],
                    "evidence": evidence,
                    "device": info.st_dev,
                    "inode": info.st_ino,
                    "mtime": info.st_mtime_ns,
                }
                sampled = samples.get(path)
                if sampled and sampled["generation"] == seen["generation"]:
                    baseline["sample"] = sampled["evidence"]
                db.execute(
                    "INSERT OR REPLACE INTO discovery_baselines VALUES (?,?)",
                    (identity, value_text(baseline)),
                )
                previous = db.execute(
                    "SELECT generation FROM local_progress WHERE file_id=?", (identity,)
                ).fetchone()
                if previous and previous[0] in allowed_generations:
                    db.execute(
                        "UPDATE local_progress SET generation=? WHERE file_id=?",
                        (seen["generation"], identity),
                    )
                db.execute("DELETE FROM local_media WHERE file_id=?", (identity,))
        receipt = {
            "version": 1,
            "library": store.descriptor.library_uuid,
            "epoch": store.descriptor.epoch,
            "operation": request.operation,
            "action": request.action,
            "event": event,
            "source": review["source"],
            "destination": review["destination"],
            "versions_before": review["versions_before"],
            "versions_after": review["versions_after"],
            "undo_of": request.prior if request.action == "undo" else None,
            "restores": review.get("restores", {}),
            "metadata": metadata,
            "before": review["before"],
        }
        from cairndex.replicas.source_receipts import dependencies, parse

        raw_receipt = value_text(receipt)
        dependencies(store, db, parse(store, raw_receipt))
        db.execute(
            "INSERT INTO source_receipts VALUES (?,?,'local',NULL)",
            (request.operation, raw_receipt),
        )
        db.execute(
            "UPDATE source_operations SET state='succeeded',phase='complete',result=?,error=NULL "
            "WHERE id=?",
            (value_text(result), request.operation),
        )
        store.fault("source_before_catalog_commit")
    store.fault("source_after_catalog_commit")


def run_one(
    store: CatalogStore,
    root: Path,
    authorize: Callable[[], None],
    before_apply: Callable[[], None] = lambda: None,
) -> None:
    """One worker claims each intent; each byte block rechecks cancellation and permission."""
    with store.connection() as db:
        row = db.execute(
            "SELECT * FROM source_operations WHERE state IN ('queued','accepted') "
            "ORDER BY sequence LIMIT 1"
        ).fetchone()
        if row is None:
            return
        state = "preparing" if row["state"] == "queued" else "applying"
        db.execute("UPDATE source_operations SET state=? WHERE id=?", (state, row["id"]))
    request = SourceRequest.model_validate_json(row["intent"])

    reported_at = 0.0
    latest_count = row["progress"]

    def progress(count: int) -> None:
        nonlocal reported_at, latest_count
        authorize()
        latest_count = count
        # Progress is display telemetry, not a recovery checkpoint. Keep the
        # cancellation read on every block without a durable commit per MiB.
        with store.connection(readonly=True) as db:
            current = db.execute(
                "SELECT state FROM source_operations WHERE id=?", (request.operation,)
            ).fetchone()[0]
            if current == "cancelled":
                raise ReplicaError(
                    "Source operation was cancelled; completed versions remain available"
                )
        now = time.monotonic()
        if now - reported_at >= 0.25:
            with store.connection() as db:
                db.execute(
                    "UPDATE source_operations SET progress=? WHERE id=?", (count, request.operation)
                )
            reported_at = time.monotonic()

    step = "authorization"
    try:
        authorize()
        from cairndex.replicas.source_claims import claim

        # Relocations claim their operation directory only when their plan uses it
        if request.action not in {"relocate", "return"}:
            step = "claim"
            claim(store, root, request.operation, request.model_dump(mode="json"))
        if state == "preparing":
            step = "prepare"
            review = prepare(store, root, request, progress)
            from cairndex.replicas.source_catalog import tracked

            review["file_generations"] = []
            with store.connection(readonly=True) as db:
                for path, seen in review.get("conditions", {}).items():
                    if (
                        request.action in {"relocate", "retain", "return", "purge"}
                        or not seen
                        or seen.get("kind") != "directory"
                    ):
                        continue
                    for item in tracked(db, path):
                        if item["family"] == "asset_files":
                            current = observation(root, item["path"])
                            if current:
                                review["file_generations"].append(current["generation"])
            from cairndex.replicas.protocol import MAX_BYTES
            from cairndex.replicas.source_receipts import SourceMetadata

            if len(value_text(review).encode()) > MAX_BYTES // 2:
                raise ReplicaError(
                    "Source review exceeds its metadata limit; use smaller operations"
                )
            if review.get("metadata"):
                if len(review["metadata"]["changes"]) > 4096:
                    raise ReplicaError(
                        "Source review exceeds its metadata limit; use smaller operations"
                    )
                SourceMetadata.model_validate(review["metadata"])
            with store.connection() as db:
                db.execute(
                    "UPDATE source_operations SET state='prepared',review=?,error=NULL "
                    "WHERE id=? AND state='preparing'",
                    (value_text(review), request.operation),
                )
        else:
            step = "apply"
            before_apply()
            apply(
                store,
                root,
                request,
                json.loads(row["review"]),
                json.loads(row["result"] or "{}"),
                progress,
                authorize,
            )
    except (OSError, DomainError) as error:
        from cairndex.file_ops.smb_transport import access_message, access_problem

        access = access_problem(error)
        message = (
            error.message
            if isinstance(error, DomainError)
            else access_message(error)
            if access
            else {
                errno.EACCES: "Storage denied access; check write permissions and retry",
                errno.EPERM: "Storage denied access; check write permissions and retry",
                errno.ENOSPC: "Storage is full; free space and retry the retained operation",
                errno.EROFS: "Storage is read-only; enable writes and retry",
                errno.ENOTSUP: "Storage lacks a required safe operation; intent retained",
            }.get(
                error.errno or 0,
                "Source storage is unavailable; retained intent and versions require retry",
            )
        )
        with store.connection() as db:
            completed = db.execute(
                "SELECT state FROM source_operations WHERE id=?", (request.operation,)
            ).fetchone()
            if completed and completed[0] == "succeeded":
                # A lost acknowledgement after the durable commit cannot turn
                # completed work into another application of the same intent.
                return
            if isinstance(error, OSError):
                current = db.execute(
                    "SELECT result FROM source_operations WHERE id=?", (request.operation,)
                ).fetchone()
                result = json.loads(current[0] or "{}")
                # Numeric protocol codes and fixed phases aid diagnosis without
                # retaining exception text, source paths or network identities.
                result["storage_failure"] = {
                    "step": step,
                    "errno": error.errno,
                    "ntstatus": getattr(error, "ntstatus", None),
                    "access": access,
                }
                db.execute(
                    "UPDATE source_operations SET result=? WHERE id=?",
                    (value_text(result), request.operation),
                )
            db.execute(
                "UPDATE source_operations SET state='interrupted',error=? "
                "WHERE id=? AND state!='cancelled'",
                (message, request.operation),
            )
    finally:
        with store.connection() as db:
            db.execute(
                "UPDATE source_operations SET progress=? WHERE id=?",
                (latest_count, request.operation),
            )
