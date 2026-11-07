"""Explicit deletion of a checked original retained by a completed Trash operation."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_journal import SourceRequest
from cairndex.replicas.source_original_files import location, matches, observe, remove_entry


def prepare_purge(
    store: CatalogStore,
    root: Path,
    request: SourceRequest,
    prior: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    from cairndex.replicas.source_original import plan

    if prior["action"] != "retain" or "path" in result["location"]:
        raise ReplicaError("Only an original retained in Trash can be permanently deleted")
    seen = observe(root, result["location"])
    if not matches(seen, result["observed"]):
        raise ReplicaError("Trashed original changed; review it before permanent deletion")
    assert seen is not None
    review = plan(
        root,
        request,
        prior["source"],
        "",
        seen,
        {},
        None,
        {},
        prior["versions_before"],
        {path: None for path in prior["versions_before"]},
        result["location"],
        None,
    )
    from cairndex.replicas.source_original_files import inventory

    review["purge_entries"] = (
        inventory(root, result["location"]) if seen["kind"] == "directory" else None
    )
    review["purges"] = request.prior
    return review


def delete_original(
    store: CatalogStore,
    root: Path,
    request: SourceRequest,
    review: dict[str, Any],
    result: dict[str, Any],
    authorize: Callable[[], None],
) -> None:
    from cairndex.replicas.source_execute import checkpoint

    target = review["steps"][-1]["target"]
    from cairndex.replicas.source_original_files import inventory, remove_tree

    if not result.get("deleting"):
        if not matches(observe(root, target), review["expected"]):
            raise ReplicaError("Retained original changed before deletion")
        if (
            review["purge_entries"] is not None
            and inventory(root, target) != review["purge_entries"]
        ):
            raise ReplicaError("Retained directory changed after deletion review")
        result["deleting"] = True
        checkpoint(store, request.operation, result)
    authorize()
    current = observe(root, target)
    if current is not None:
        if review["purge_entries"] is not None:
            remove_tree(root, target, review["expected"], review["purge_entries"], authorize)
        else:
            if not matches(current, review["expected"]):
                raise ReplicaError("Retained original was replaced; deletion stopped")
            with location(root, target) as (handle, name):
                remove_entry(handle, name, review["expected"]["identity"], folder=False)
    store.fault("source_after_deletion")
    if observe(root, target) is not None:
        raise ReplicaError("Deleted original is still visible; retry after storage refresh")
    result.update(location=target, observed=None, files={})
    raw = value_text(
        {
            "version": 1,
            "library": store.descriptor.library_uuid,
            "epoch": store.descriptor.epoch,
            "operation": request.operation,
            "action": "purge",
            "event": None,
            "source": review["source"],
            "destination": "",
            "versions_before": review["versions_before"],
            "versions_after": review["versions_after"],
            "undo_of": None,
            "restores": {},
            "metadata": None,
            "before": {},
            "purges": request.prior,
        }
    )
    from cairndex.replicas.source_receipts import dependencies, parse

    with store.connection() as db:
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
