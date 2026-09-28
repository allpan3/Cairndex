"""Prepare exact source and catalog conditions outside HTTP request handlers."""

import json
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.file_ops.paths import suffixed_name
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.controls import creation
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_sources import stable_id
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import observation, snapshot, source_path
from cairndex.replicas.source_journal import SourceRequest, retain_version


def require_resolved_paths(db: sqlite3.Connection, path: str, *, tree: bool = False) -> None:
    """Held path claims remain relevant when their entities have no projected row."""
    if not path:
        return
    predicate = "(r.value=? OR (r.value>=? AND r.value<?))" if tree else "r.value=?"
    values = (
        (value_text(path), value_text(path + "/"), value_text(path + "0"))
        if tree
        else (value_text(path),)
    )
    held = db.execute(
        "SELECT 1 FROM catalog_revisions r WHERE r.active=1 "
        f"AND {predicate} "
        "AND r.unit LIKE 'asset_files/%/relative_path' "
        "AND EXISTS (SELECT 1 FROM catalog_holds h WHERE h.unit IN "
        "(r.unit,substr(r.unit,1,length(r.unit)-13)||'$alive')) LIMIT 1",
        values,
    ).fetchone()
    if held:
        raise ReplicaError("Source path has unresolved catalog alternatives; review metadata first")


def path_identity(db: sqlite3.Connection, path: str) -> str | None:
    require_resolved_paths(db, path)
    rows = db.execute(
        "SELECT entity FROM catalog_paths WHERE path=? AND family='asset_files' LIMIT 2", (path,)
    ).fetchall()
    if len(rows) > 1:
        raise ReplicaError("Source path has competing catalog identities; review metadata first")
    return str(rows[0][0]) if rows else None


def new_copy(builder: Preview, request: SourceRequest, path: str) -> str:
    """Copy creates independent file and provisional bundle identities."""
    rows = {
        family: {column: json.loads(raw) for column, raw in creation(family)["cells"].items()}
        for family in ("asset_bundles", "asset_files")
    }
    for family, row in rows.items():
        row["id"] = stable_id(
            [builder.store.descriptor.library_uuid, request.operation, family, path]
        )
    bundle, file = rows["asset_bundles"], rows["asset_files"]
    bundle["title"] = path.rsplit("/", 1)[-1]
    bundle["grouping_state"] = "PROVISIONAL"
    bundle["grouping_source"] = "SCAN_SUGGESTION"
    file.update(bundle_id=bundle["id"], relative_path=path, display_title=path.rsplit("/", 1)[-1])
    builder.create("asset_bundles", bundle)
    builder.create("asset_files", file)
    return str(file["id"])


def prepare(
    store: CatalogStore, root: Path, request: SourceRequest, progress: Callable[[int], None]
) -> dict[str, Any]:
    """Retain byte snapshots before preparing catalog changes with their observed bases."""
    if request.action == "undo":
        from cairndex.replicas.source_undo import prepare_undo

        return prepare_undo(store, root, request, progress)
    if request.action == "restore":
        return prepare_restore(store, root, request, progress)
    source = source_path(request.source) if request.upload is None else ""
    if request.upload is not None and (
        request.action != "copy" or request.source or request.upload == request.operation
    ):
        raise ReplicaError("An upload is copy-only and needs a separate operation identity")
    if request.upload is not None:
        with store.connection(readonly=True) as db:
            uploaded = db.execute(
                "SELECT size FROM source_uploads WHERE id=? AND state='ready'", (request.upload,)
            ).fetchone()
        source_seen = {"size": uploaded[0]} if uploaded else None
    else:
        source_seen = observation(root, source)
    if source_seen is None:
        raise ReplicaError("Source bytes are unavailable; retry after delivery")
    destination = "" if request.action == "trash" else source_path(request.destination)
    destination_seen = observation(root, destination) if destination else None
    if source == destination and request.action in ("rename", "move"):
        raise ReplicaError("Source and destination are the same path")
    if destination_seen and request.collision == "fail":
        raise ReplicaError("Destination exists; choose Replace, Skip or Keep Both")
    if destination_seen and request.collision == "skip":
        return {"skipped": True, "source": source, "destination": destination}
    if destination_seen and request.collision == "suffix":
        parent, _, name = destination.rpartition("/")
        for attempt in range(2, 1002):
            candidate = (parent + "/" if parent else "") + suffixed_name(name, attempt)
            if observation(root, candidate) is None:
                destination, destination_seen = candidate, None
                break
        else:
            raise ReplicaError("No vacant Keep Both name is available")
    is_tree = source_seen.get("kind") == "directory"
    if (
        source
        and destination
        and (
            source == destination
            or source.startswith(destination + "/")
            or destination.startswith(source + "/")
        )
    ):
        raise ReplicaError("Source and destination paths must not overlap")
    if destination_seen and is_tree != (destination_seen.get("kind") == "directory"):
        raise ReplicaError("Replace requires matching file or directory types")
    # Count independent versions, captured originals and the output copy. The
    # upload remains retained as well. This is logical storage, before compression.
    source_versions = 3 if request.upload or request.action in {"move", "rename"} else 2
    total = source_versions * source_seen["size"] + 2 * (
        destination_seen["size"] if destination_seen else 0
    )
    if total > request.byte_limit:
        raise ReplicaError("Reviewed files exceed the operation byte budget")
    # Snapshot code verifies a retained partial prefix on an exact restart.
    if request.upload is not None:
        from cairndex.replicas.source_uploads import snapshot_upload

        source_evidence = snapshot_upload(
            store, root, request.upload, request.operation, progress, request.byte_limit
        )
    else:
        source_evidence = snapshot(
            root,
            source,
            request.operation,
            "source",
            source_seen,
            progress=progress,
            limit=request.byte_limit,
        )
    destination_evidence = None
    retain_version(store, request.operation, source, "source", source_evidence)
    if destination_seen:
        destination_evidence = snapshot(
            root,
            destination,
            request.operation,
            "destination",
            destination_seen,
            progress=lambda count: progress(source_seen["size"] + count),
            limit=request.byte_limit,
        )
        retain_version(store, request.operation, destination, "destination", destination_evidence)
    with store.connection() as db:
        source_id = path_identity(db, source)
        destination_id = path_identity(db, destination) if destination else None
        if destination_id and destination_seen is None:
            raise ReplicaError(
                "Destination metadata exists but bytes are unavailable; choose another path"
            )
        from cairndex.replicas.discovery_sources import inspect

        for identity, path, evidence in (
            (source_id, source, source_evidence),
            (destination_id, destination, destination_evidence),
        ):
            if identity is None:
                continue
            authored = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (key("asset_files", identity, "$content"),),
            ).fetchone()
            if authored and authored[0]:
                expected = json.loads(authored[0])
                actual = (
                    evidence
                    if expected["algorithm"] == "sha256"
                    else inspect(root, path)["evidence"]
                )
                if actual != expected:
                    raise ReplicaError(
                        "Local bytes differ from the catalog; run Update and review content first"
                    )
        for identity in {source_id, destination_id}:
            if identity is None:
                continue
            scope = store.scope(db, [key("asset_files", identity, "$alive")])
            if any(
                db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone()
                for unit in scope
            ):
                raise ReplicaError("Source metadata has unresolved alternatives; review them first")
        builder = Preview(store, db)
        output_id = source_id
        if is_tree:
            from cairndex.replicas.source_catalog import prepare_tree

            prepare_tree(
                builder, root, request, source, destination, source_evidence, destination_evidence
            )
        elif request.action == "trash":
            if source_id:
                builder.delete("asset_files", source_id)
        elif request.action == "copy":
            output_id = destination_id or new_copy(builder, request, destination)
            builder.put(key("asset_files", output_id, "$content"), source_evidence)
        else:
            if destination_id:
                builder.delete("asset_files", destination_id)
            if source_id:
                builder.put(key("asset_files", source_id, "relative_path"), destination)
                builder.put(key("asset_files", source_id, "$content"), source_evidence)
        metadata = builder.receipt() if builder.values else None
        before = {}
        if metadata:
            for change in metadata["changes"]:
                prior = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (change["unit"],)
                ).fetchone()
                before[change["unit"]] = prior[0] if prior else None
        review: dict[str, Any] = {
            "root_identity": [
                root.stat(follow_symlinks=False).st_dev,
                root.stat(follow_symlinks=False).st_ino,
            ],
            "skipped": False,
            "source": source,
            "destination": destination,
            "source_seen": source_seen,
            "destination_seen": destination_seen,
            "source_evidence": source_evidence,
            "destination_evidence": destination_evidence,
            "source_id": source_id,
            "destination_id": destination_id,
            "output_id": output_id,
            "metadata": metadata,
            "before": before,
        }
        source_version = {
            "operation": request.operation,
            "version": "source",
            "evidence": source_evidence,
        }
        destination_version = (
            {
                "operation": request.operation,
                "version": "destination",
                "evidence": destination_evidence,
            }
            if destination_seen
            else None
        )
        versions_before: dict[str, Any] = {}
        versions_after: dict[str, Any] = {}
        conditions: dict[str, Any] = {source: source_seen} if source else {}
        captures = []
        if destination:
            conditions[destination] = destination_seen
            versions_before[destination] = destination_version
            versions_after[destination] = source_version
            if destination_seen:
                captures.append(
                    {
                        "name": "captured-destination",
                        "path": destination,
                        "expected": destination_seen,
                    }
                )
        if request.action in ("rename", "move", "trash"):
            versions_before[source] = source_version
            versions_after[source] = None
            captures.append({"name": "captured-source", "path": source, "expected": source_seen})
        review.update(
            conditions=conditions,
            captures=captures,
            versions_before=versions_before,
            versions_after=versions_after,
        )
        return review


def prepare_restore(
    store: CatalogStore, root: Path, request: SourceRequest, progress: Callable[[int], None]
) -> dict[str, Any]:
    """Recover a separate copy without overwriting the original catalog identity."""
    from cairndex.replicas.source_undo import receipt

    with store.connection(readonly=True) as db:
        try:
            prior = receipt(db, request.prior)
        except ReplicaError:
            row = db.execute(
                "SELECT intent,result FROM source_operations WHERE id=?", (request.prior,)
            ).fetchone()
            retained = json.loads(row["result"] or "{}").get("retained_versions", {}) if row else {}
            if not retained:
                raise
            intent = json.loads(row["intent"])
            prior = {"source": intent["source"], "versions_before": retained, "versions_after": {}}
    candidates = [
        version
        for version in prior[
            "versions_after" if request.version == "output" else "versions_before"
        ].values()
        if version and (request.version == "output" or version["version"] == request.version)
    ]
    if not candidates:
        raise ReplicaError("This receipt does not contain the selected recovery version")
    version = candidates[0]
    if version["evidence"]["size"] > request.byte_limit:
        raise ReplicaError("Recovery copy exceeds the operation byte budget")
    destination = source_path(request.destination)
    seen = observation(root, destination)
    if seen and request.collision == "skip":
        return {"skipped": True, "source": prior["source"], "destination": destination}
    if seen and request.collision != "suffix":
        # Restore copy deliberately requires a vacant path. Replace is already
        # available through a reviewed Copy after the recovered copy is visible.
        raise ReplicaError("Recovery copy requires a vacant path or Keep Both")
    if seen:
        directory, _, name = destination.rpartition("/")
        for attempt in range(2, 1002):
            destination = (directory + "/" if directory else "") + suffixed_name(name, attempt)
            seen = observation(root, destination)
            if seen is None:
                break
        else:
            raise ReplicaError("No vacant recovery name is available")
    with store.connection() as db:
        if path_identity(db, destination):
            raise ReplicaError("Recovery destination has a catalog identity; choose another path")
        builder = Preview(store, db)
        output_id = None
        if version["evidence"]["algorithm"] == "tree-sha256-v1":
            from cairndex.replicas.source_catalog import restore_tree

            restore_tree(builder, root, request, destination, version)
        else:
            output_id = new_copy(builder, request, destination)
            builder.put(key("asset_files", output_id, "$content"), version["evidence"])
        metadata = builder.receipt() if builder.values else None
    info = root.stat(follow_symlinks=False)
    return {
        "root_identity": [info.st_dev, info.st_ino],
        "skipped": False,
        "source": prior["source"],
        "destination": destination,
        "output_id": output_id,
        "conditions": {destination: None},
        "captures": [],
        "versions_before": {destination: None},
        "versions_after": {destination: version},
        "metadata": metadata,
        "before": {change["unit"]: None for change in metadata["changes"]} if metadata else {},
    }
