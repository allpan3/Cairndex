"""Catalog identity rules for bounded directory source operations."""

import json
import sqlite3
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import key
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import operation_directory
from cairndex.replicas.source_journal import SourceRequest
from cairndex.replicas.source_trees import MAX_ENTRIES, read_index


def tree_index(
    root: Path, operation: str, version: str, evidence: dict[str, Any]
) -> list[dict[str, Any]]:
    with operation_directory(root, operation) as handle:
        return read_index(handle, version, evidence)


def tracked(db: sqlite3.Connection, path: str) -> list[sqlite3.Row]:
    if not path:
        return []
    from cairndex.replicas.source_plan import require_resolved_paths

    require_resolved_paths(db, path, tree=True)
    rows = db.execute(
        "SELECT family,entity,path FROM catalog_paths WHERE path=? OR (path>=? AND path<?) "
        "ORDER BY path,family,entity LIMIT ?",
        (path, path + "/", path + "0", MAX_ENTRIES + 1),
    ).fetchall()
    if len(rows) > MAX_ENTRIES:
        raise ReplicaError("Directory operation exceeds the 128-identity review limit")
    return rows


def check(
    builder: Preview, root: Path, rows: list[sqlite3.Row], path: str, manifest: list[dict[str, Any]]
) -> None:
    contents = {path + "/" + item["path"]: item for item in manifest}
    contents[path] = {"directory": True}
    for row in rows:
        item = contents.get(row["path"])
        if item is None or (row["family"] == "asset_files") == item["directory"]:
            raise ReplicaError("Directory metadata has missing or different source entries")
        scope = builder.store.scope(builder.db, [key(row["family"], row["entity"], "$alive")])
        if any(
            builder.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone()
            for unit in scope
        ):
            raise ReplicaError("Directory metadata has unresolved alternatives")
        if row["family"] != "asset_files":
            continue
        authored = builder.db.execute(
            "SELECT value FROM catalog_units WHERE unit=?",
            (key("asset_files", row["entity"], "$content"),),
        ).fetchone()
        if authored and authored[0]:
            from cairndex.replicas.discovery_sources import inspect

            expected = json.loads(authored[0])
            actual = (
                item["evidence"]
                if expected["algorithm"] == "sha256"
                else inspect(root, row["path"])["evidence"]
            )
            if actual != expected:
                raise ReplicaError("Directory content differs from the catalog; run Update first")


def prepare_tree(
    builder: Preview,
    root: Path,
    request: SourceRequest,
    source: str,
    destination: str,
    source_evidence: dict[str, Any],
    destination_evidence: dict[str, Any] | None,
) -> None:
    from cairndex.replicas.source_plan import new_copy

    source_index = tree_index(root, request.operation, "source", source_evidence)
    source_rows = tracked(builder.db, source)
    destination_rows = tracked(builder.db, destination)
    check(builder, root, source_rows, source, source_index)
    if destination_evidence:
        destination_index = tree_index(root, request.operation, "destination", destination_evidence)
        check(builder, root, destination_rows, destination, destination_index)
    elif destination_rows:
        raise ReplicaError("Destination metadata exists without source bytes")
    if request.action == "trash":
        for row in source_rows:
            builder.delete(row["family"], row["entity"])
        return
    if request.action in {"move", "rename"}:
        for row in destination_rows:
            builder.delete(row["family"], row["entity"])
        contents = {source + "/" + item["path"]: item for item in source_index}
        for row in source_rows:
            field = "relative_path" if row["family"] == "asset_files" else "directory_path"
            builder.put(
                key(row["family"], row["entity"], field), destination + row["path"][len(source) :]
            )
            if row["family"] == "asset_files":
                builder.put(
                    key("asset_files", row["entity"], "$content"), contents[row["path"]]["evidence"]
                )
        return
    target_entries = {destination + "/" + item["path"]: item for item in source_index}
    target_entries[destination] = {"directory": True}
    retained = {}
    for row in destination_rows:
        target = target_entries.get(row["path"])
        if target is None or (row["family"] == "asset_files") == target["directory"]:
            builder.delete(row["family"], row["entity"])
        elif row["family"] == "asset_files":
            if row["path"] in retained:
                raise ReplicaError("Directory destination has competing file identities")
            retained[row["path"]] = row["entity"]
    for path, item in target_entries.items():
        if not item["directory"]:
            identity = retained.get(path) or new_copy(builder, request, path)
            builder.put(key("asset_files", identity, "$content"), item["evidence"])


def restore_tree(
    builder: Preview, root: Path, request: SourceRequest, destination: str, version: dict[str, Any]
) -> None:
    from cairndex.replicas.source_plan import new_copy

    if tracked(builder.db, destination):
        raise ReplicaError("Recovery directory has catalog identities; choose another path")
    for item in tree_index(root, version["operation"], version["version"], version["evidence"]):
        if not item["directory"]:
            identity = new_copy(builder, request, destination + "/" + item["path"])
            builder.put(key("asset_files", identity, "$content"), item["evidence"])
