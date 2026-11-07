"""Journaled relocation of originals with conditional inverse and unchanged content claims."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.file_ops.paths import suffixed_name
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_claims import claim
from cairndex.replicas.source_files import source_path
from cairndex.replicas.source_journal import SourceRequest
from cairndex.replicas.source_original_files import matches, move, observe, parent_identity

ACTIONS = {"relocate", "retain", "return", "purge"}


def tracked(store: CatalogStore, path: str) -> list[dict[str, str]]:
    from cairndex.replicas.source_plan import require_resolved_paths

    with store.connection(readonly=True) as db:
        require_resolved_paths(db, path, tree=True)
        rows = db.execute(
            "SELECT family,entity,path FROM catalog_paths WHERE path=? OR (path>=? AND path<?) "
            "ORDER BY path,family,entity LIMIT 1025",
            (path, path + "/", path + "0"),
        ).fetchall()
        if len(rows) > 1024:
            raise ReplicaError("Directory relocation exceeds the bounded catalog review")
        return [dict(row) for row in rows]


def prepare_original(store: CatalogStore, root: Path, request: SourceRequest) -> dict[str, Any]:
    if request.upload or request.collision == "replace":
        raise ReplicaError("Replace requires the independent-copy operation")
    if request.action in {"return", "purge"}:
        return prepare_return(store, root, request)
    source = source_path(request.source)
    destination = source_path(request.destination) if request.action == "relocate" else ""
    if destination and (
        source == destination
        or source.startswith(destination + "/")
        or destination.startswith(source + "/")
    ):
        raise ReplicaError("Source and destination paths must not overlap")
    seen = observe(root, {"path": source})
    if seen is None:
        raise ReplicaError("The file is no longer at this location; refresh before trying again")
    destination_seen = observe(root, {"path": destination}) if destination else None
    case_change = bool(
        destination_seen
        and matches(destination_seen, seen)
        and source.casefold() == destination.casefold()
    )
    if destination_seen and not case_change:
        if request.collision == "skip":
            return {"skipped": True, "source": source, "destination": destination}
        if request.collision != "suffix":
            raise ReplicaError("Destination exists; choose Replace, Skip or Keep Both")
        folder, _, name = destination.rpartition("/")
        for attempt in range(2, 1002):
            candidate = (folder + "/" if folder else "") + suffixed_name(name, attempt)
            if observe(root, {"path": candidate}) is None:
                destination = candidate
                break
        else:
            raise ReplicaError("No vacant Keep Both name is available")
    rows = tracked(store, source)
    destinations = tracked(store, destination) if destination else []
    if destinations:
        raise ReplicaError("Destination metadata exists; choose another path")
    files = {}
    for row in rows:
        current = observe(root, {"path": row["path"]})
        if current is None:
            raise ReplicaError("A tracked source entry is unavailable; review before moving it")
        if row["family"] == "asset_files" and current["kind"] != "file":
            raise ReplicaError("Source entry type differs from the catalog")
        files[row["path"]] = {"family": row["family"], "id": row["entity"], "seen": current}
    with store.connection() as db:
        builder = Preview(store, db)
        for row in rows:
            scope = store.scope(db, [key(row["family"], row["entity"], "$alive")])
            if any(
                db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone()
                for unit in scope
            ):
                raise ReplicaError("Source metadata has unresolved alternatives; review them first")
            if request.action == "retain":
                builder.delete(row["family"], row["entity"])
            else:
                field = "relative_path" if row["family"] == "asset_files" else "directory_path"
                builder.put(
                    key(row["family"], row["entity"], field),
                    destination + row["path"][len(source) :],
                )
        metadata = builder.receipt() if builder.values else None
        before = {}
        for change in metadata["changes"] if metadata else []:
            prior = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (change["unit"],)
            ).fetchone()
            before[change["unit"]] = prior[0] if prior else None
    version = {"operation": request.operation, "version": "original", "kind": seen["kind"]}
    versions_before: dict[str, Any] = {source: version}
    versions_after: dict[str, Any] = {source: None}
    if destination:
        versions_before[destination] = None
        versions_after[destination] = version
    return plan(
        store,
        root,
        request,
        source,
        destination,
        seen,
        files,
        metadata,
        before,
        versions_before,
        versions_after,
        {"path": source},
        {"path": destination} if destination else None,
        case_change=case_change,
    )


def plan(
    store: CatalogStore,
    root: Path,
    request: SourceRequest,
    source: str,
    destination: str,
    seen: dict[str, Any],
    files: dict[str, Any],
    metadata: dict[str, Any] | None,
    before: dict[str, Any],
    versions_before: dict[str, Any],
    versions_after: dict[str, Any],
    origin: dict[str, str],
    target: dict[str, str] | None,
    *,
    case_change: bool = False,
) -> dict[str, Any]:
    # A move between library paths is one no-replace rename: a lost reply is
    # resolved by finding the object at origin or target, and Undo renames it
    # back. Only Trash, Empty Trash and a case-only rename stop in the
    # operation's own directory. The worker claims it for Trash and Empty
    # Trash; a relocation claims it here, only when it needs it.
    if target and not case_change:
        steps: list[dict[str, Any]] = [{"origin": origin, "target": target}]
    else:
        if request.action in {"relocate", "return"}:
            claim(store, root, request.operation, request.model_dump(mode="json"))
        stage = {"operation": request.operation, "name": "original"}
        steps = [{"origin": origin, "target": stage}]
        if target:
            steps.append({"origin": stage, "target": target})
    for step in steps:
        step["origin_parent"] = parent_identity(root, step["origin"])
        step["target_parent"] = parent_identity(root, step["target"])
    info = root.stat(follow_symlinks=False)
    return {
        "root_identity": [info.st_dev, info.st_ino],
        "skipped": False,
        "source": source,
        "destination": destination,
        "expected": seen,
        "files": files,
        "metadata": metadata,
        "before": before,
        "versions_before": versions_before,
        "versions_after": versions_after,
        "steps": steps,
        "case_change": case_change,
        "conditions": {source: seen} if source else {},
        "output_id": next(
            (
                entry["id"]
                for path, entry in files.items()
                if path == source and entry["family"] == "asset_files"
            ),
            None,
        ),
    }


def prepare_return(store: CatalogStore, root: Path, request: SourceRequest) -> dict[str, Any]:
    from cairndex.replicas.source_undo import inverse_metadata, receipt

    with store.connection(readonly=True) as db:
        prior = receipt(db, request.prior)
        if prior["action"] not in {"relocate", "retain", "return"}:
            raise ReplicaError("This operation uses the independent-copy recovery path")
        row = db.execute(
            "SELECT review,result FROM source_operations WHERE id=? AND state='succeeded'",
            (request.prior,),
        ).fetchone()
        if row is None:
            raise ReplicaError(
                "Original recovery needs this server's recorded physical observation"
            )
        original_review, result = json.loads(row[0]), json.loads(row[1])
        if db.execute(
            "SELECT 1 FROM source_receipts WHERE json_extract(raw,'$.undo_of')=? "
            "AND state IN ('local','accepted')",
            (request.prior,),
        ).fetchone():
            raise ReplicaError("This operation already has a completed Undo")
    with store.connection(readonly=True) as db:
        if db.execute(
            "SELECT 1 FROM source_receipts WHERE json_extract(raw,'$.purges')=? "
            "AND state IN ('local','accepted')",
            (request.prior,),
        ).fetchone():
            raise ReplicaError("This retained original was permanently deleted")
    if request.action == "purge":
        from cairndex.replicas.source_purge import prepare_purge

        return prepare_purge(store, root, request, prior, result)
    origin = result["location"]
    seen = observe(root, origin)
    if not matches(seen, result["observed"]):
        raise ReplicaError("Retained original changed; Put Back requires recovery review")
    assert seen is not None
    # A return reverses one relocation, including a prior return. The destination
    # is always the original library path; retained artifacts are never client paths.
    if "path" not in original_review["steps"][0]["origin"]:
        target = None
        destination = ""
    else:
        destination = original_review["steps"][0]["origin"]["path"]
        target = {"path": destination}
        occupying = observe(root, target)
        case_change = bool(
            "path" in origin
            and origin["path"].casefold() == destination.casefold()
            and matches(occupying, seen)
        )
        if occupying is not None and not case_change:
            raise ReplicaError("Undo cannot replace a new arrival at the original path")
    case_change = bool(
        target and "path" in origin and origin["path"].casefold() == destination.casefold()
    )
    files = result["files"]
    for path, entry in files.items():
        loc = (
            {"path": path}
            if "path" in origin
            else origin | {"relative": path[len(original_review["source"]) :].lstrip("/")}
        )
        if not matches(observe(root, loc), entry["seen"]):
            raise ReplicaError("Later source changes require recovery review")
    with store.connection() as db:
        metadata, before, restores = inverse_metadata(store, db, root, prior)
    review = plan(
        store,
        root,
        request,
        origin.get("path", prior["source"]),
        destination,
        seen,
        files,
        metadata,
        before,
        prior["versions_after"],
        prior["versions_before"],
        origin,
        target,
        case_change=case_change,
    )
    review["restores"] = restores
    return review


def apply_original(
    store: CatalogStore,
    root: Path,
    request: SourceRequest,
    review: dict[str, Any],
    result: dict[str, Any],
    authorize: Callable[[], None],
) -> None:
    from cairndex.replicas.source_execute import checkpoint, reviewed_metadata

    if review["skipped"]:
        with store.connection() as db:
            db.execute(
                "UPDATE source_operations SET state='succeeded',result='{}' WHERE id=?",
                (request.operation,),
            )
        return
    info = root.stat(follow_symlinks=False)
    if [info.st_dev, info.st_ino] != review["root_identity"]:
        raise ReplicaError("Library root changed; recovery review is required")
    if not result.get("started"):
        reviewed_metadata(store, review)
        origin = review["steps"][0]["origin"]
        for path, entry in review["files"].items():
            loc = (
                {"path": path}
                if "path" in origin
                else origin | {"relative": path[len(review["source"]) :].lstrip("/")}
            )
            if not matches(observe(root, loc), entry["seen"]):
                raise ReplicaError("Source changed after review")
        result["started"] = True
        checkpoint(store, request.operation, result)
        store.fault("source_before_capture")
    for index, step in enumerate(review["steps"]):
        if index < result.get("step", 0):
            continue
        authorize()
        move(
            root,
            step["origin"],
            step["target"],
            review["expected"],
            step["origin_parent"],
            step["target_parent"],
        )
        published = "path" in step["target"]
        store.fault("source_after_publication" if published else "source_after_capture")
        result["step"] = index + 1
        checkpoint(store, request.operation, result)
    target = review["steps"][-1]["target"]
    if request.action == "purge":
        from cairndex.replicas.source_purge import delete_original

        delete_original(store, root, request, review, result, authorize)
        return
    seen = observe(root, target)
    if not matches(seen, review["expected"]):
        raise ReplicaError("Original changed before catalog commit; recovery review is required")
    origin = review["steps"][0]["origin"]
    if "path" in origin and not review["case_change"] and observe(root, origin) is not None:
        raise ReplicaError("A new source arrived before commit; recovery review is required")
    result.update(location=target, observed=seen)
    # Network observations must not hold SQLite's writer while metadata saves
    # wait. The catalog commit below still checks every reviewed causal basis.
    files = observed_outputs(root, review, target)
    with store.connection() as db:
        metadata = review["metadata"]
        event = (
            store.save_in(
                db,
                [UnitChange.model_validate(change) for change in metadata["changes"]],
                request.operation,
                parents=metadata["parents"],
                resolve=metadata["resolve"],
                recover=metadata["recover"],
                source=True,
            )
            if metadata
            else None
        )
        update_local(db, review, files)
        result["files"] = files
        raw = value_text(
            {
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
                "undo_of": request.prior if request.action == "return" else None,
                "restores": review.get("restores", {}),
                "metadata": metadata,
                "before": review["before"],
                "purges": None,
            }
        )
        from cairndex.replicas.source_receipts import dependencies, parse

        dependencies(store, db, parse(store, raw))
        db.execute(
            "INSERT INTO source_receipts VALUES (?,?,'local',NULL)", (request.operation, raw)
        )
        db.execute(
            "UPDATE source_operations SET state='succeeded',phase='complete',"
            "result=?,error=NULL WHERE id=?",
            (value_text(result), request.operation),
        )
        store.fault("source_before_catalog_commit")
    store.fault("source_after_catalog_commit")


def observed_outputs(root: Path, review: dict[str, Any], target: dict[str, str]) -> dict[str, Any]:
    files = {}
    for path, entry in review["files"].items():
        if "path" not in target:
            files[path] = entry
            continue
        output = target["path"] + path[len(review["source"]) :]
        seen = observe(root, {"path": output})
        if not matches(seen, entry["seen"]):
            raise ReplicaError("A moved catalog file changed before commit")
        assert seen is not None
        files[output] = entry | {"seen": seen}
    return files


def update_local(db: Any, review: dict[str, Any], files: dict[str, Any]) -> None:
    """Carry evidence only from a matching prior local generation; never invent a hash."""
    prior = {entry["id"]: entry for entry in review["files"].values()}
    for output, entry in files.items():
        seen = entry["seen"]
        old = prior[entry["id"]]["seen"]
        if entry["family"] != "asset_files" or seen["generation"] == old["generation"]:
            continue
        identity = entry["id"]
        baseline = db.execute(
            "SELECT body FROM discovery_baselines WHERE file_id=?", (identity,)
        ).fetchone()
        if baseline:
            body = json.loads(baseline[0])
            if body["generation"] == old["generation"]:
                body.update(
                    path=output,
                    generation=seen["generation"],
                    device=seen["device"],
                    inode=seen["inode"],
                    mtime=seen["mtime"],
                )
                db.execute(
                    "UPDATE discovery_baselines SET body=? WHERE file_id=?",
                    (value_text(body), identity),
                )
        for table in ("local_progress", "local_media"):
            db.execute(
                f"UPDATE {table} SET generation=? WHERE file_id=? AND generation=?",
                (seen["generation"], identity, old["generation"]),
            )
