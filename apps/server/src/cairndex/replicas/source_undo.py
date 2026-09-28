"""Conditional source inverses preserve later work and retain every content version."""

import json
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import key, split_key
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import observation, snapshot
from cairndex.replicas.source_journal import SourceRequest, retain_version


def receipt(db: sqlite3.Connection, operation: str | None) -> dict[str, Any]:
    row = db.execute(
        "SELECT raw FROM source_receipts WHERE id=? AND state IN ('local','accepted')", (operation,)
    ).fetchone()
    if row is None:
        raise ReplicaError("The complete source operation receipt is unavailable")
    return dict(json.loads(row[0]))


def restored_event(
    db: sqlite3.Connection, unit: str, event: str, expected: str, depth: int = 0
) -> bool:
    """A known conditional inverse can restore a preceding operation's exact basis."""
    if event == expected:
        return True
    if depth >= 64:
        return False
    row = db.execute(
        "SELECT raw FROM source_receipts WHERE json_extract(raw,'$.event')=? "
        "AND state IN ('local','accepted') LIMIT 1",
        (event,),
    ).fetchone()
    if not row:
        return False
    value = json.loads(row[0])
    bases = value.get("restores", {}).get(unit, [])
    return bool(value.get("undo_of") and bases) and all(
        restored_event(db, unit, basis, expected, depth + 1) for basis in bases
    )


def inverse_metadata(
    store: CatalogStore, db: sqlite3.Connection, root: Path, prior: dict[str, Any]
) -> tuple[dict[str, Any] | None, dict[str, Any], dict[str, Any]]:
    metadata = prior["metadata"]
    if metadata is None:
        return None, {}, {}
    builder = Preview(store, db)
    created = set()
    restores = {}
    for change in metadata["changes"]:
        unit, value = change["unit"], change["value"]
        old = prior["before"][unit]
        if old == value:
            continue
        current = db.execute("SELECT value FROM catalog_units WHERE unit=?", (unit,)).fetchone()
        tips = store.tips(db, unit)
        if (
            not current
            or current[0] != value
            or not tips
            or not all(restored_event(db, unit, tip["event"], prior["event"]) for tip in tips)
        ):
            raise ReplicaError("Later metadata changed this operation; Undo requires a new review")
        family, identity, field = split_key(unit)
        if old is None and field == "$alive":
            created.add((family, identity))
        elif old is None and field == "$content":
            path = (
                prior["destination"] if prior["action"] in ("copy", "restore") else prior["source"]
            )
            version = prior["versions_before"].get(path)
            if version:
                evidence = version["evidence"]
                if evidence["algorithm"] == "tree-sha256-v1":
                    from cairndex.replicas.source_catalog import tree_index

                    path_unit = key(family, identity, "relative_path")
                    previous_path = prior["before"].get(path_unit)
                    if previous_path is None:
                        row = db.execute(
                            "SELECT value FROM catalog_units WHERE unit=?", (path_unit,)
                        ).fetchone()
                        previous_path = row[0] if row else None
                    file_path = json.loads(previous_path) if previous_path else None
                    entries = tree_index(root, version["operation"], version["version"], evidence)
                    match = next(
                        (
                            item
                            for item in entries
                            if not item["directory"] and path + "/" + item["path"] == file_path
                        ),
                        None,
                    )
                    if match is None:
                        raise ReplicaError("Retained directory has no matching file content")
                    evidence = match["evidence"]
                builder.put(unit, evidence)
        elif old is not None:
            builder.values[unit] = old
            restores[unit] = change["basis"]
    # Deleting a created bundle includes its files and relationships. Do not
    # delete another entity twice after that complete cascade.
    for family, identity in sorted(created, key=lambda item: item[0] != "asset_bundles"):
        if builder.values.get(key(family, identity, "$alive")) != "false":
            builder.delete(family, identity)
    prepared = builder.receipt(recover=True) if builder.values else None
    before = {}
    for change in prepared["changes"] if prepared else []:
        row = db.execute(
            "SELECT value FROM catalog_units WHERE unit=?", (change["unit"],)
        ).fetchone()
        before[change["unit"]] = row[0] if row else None
    return prepared, before, restores


def prepare_undo(
    store: CatalogStore, root: Path, request: SourceRequest, progress: Callable[[int], None]
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        prior = receipt(db, request.prior)
        if db.execute(
            "SELECT 1 FROM source_receipts WHERE json_extract(raw,'$.undo_of')=? "
            "AND state IN ('local','accepted')",
            (request.prior,),
        ).fetchone():
            raise ReplicaError("This operation already has a completed Undo")
    conditions: dict[str, Any] = {}
    captures: list[dict[str, Any]] = []
    versions_before: dict[str, Any] = {}
    total = sum(
        version["evidence"]["size"] for version in prior["versions_before"].values() if version
    )
    if total > request.byte_limit:
        raise ReplicaError("Undo exceeds the operation byte budget")
    for index, (path, expected) in enumerate(prior["versions_after"].items()):
        observed = observation(root, path)
        conditions[path] = observed
        if expected is None:
            if observed is not None:
                raise ReplicaError("Undo cannot replace a new arrival at the original path")
            versions_before[path] = None
            continue
        if observed is None:
            raise ReplicaError("Undo is waiting for the recorded source bytes")
        total += 2 * observed["size"]
        if total > request.byte_limit:
            raise ReplicaError("Undo exceeds the operation byte budget")
        name = "source" if index == 0 else "destination"
        evidence = snapshot(
            root,
            path,
            request.operation,
            name,
            observed,
            progress=progress,
            limit=request.byte_limit,
        )
        if evidence != expected["evidence"]:
            raise ReplicaError("Later source bytes differ; Undo will not overwrite them")
        retain_version(store, request.operation, path, name, evidence)
        captures.append({"name": "captured-" + name, "path": path, "expected": observed})
        versions_before[path] = {
            "operation": request.operation,
            "version": name,
            "evidence": evidence,
        }
    with store.connection() as db:
        metadata, before, restores = inverse_metadata(store, db, root, prior)
    return {
        "root_identity": [
            root.stat(follow_symlinks=False).st_dev,
            root.stat(follow_symlinks=False).st_ino,
        ],
        "skipped": False,
        "source": prior["source"],
        "destination": prior["destination"],
        "conditions": conditions,
        "captures": captures,
        "versions_before": versions_before,
        "versions_after": prior["versions_before"],
        "metadata": metadata,
        "before": before,
        "restores": restores,
    }
