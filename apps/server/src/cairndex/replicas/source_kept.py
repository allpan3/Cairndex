"""Copies that earlier Copy operations kept beside the file they published.

Before a copy published its own version (``source_files.consume_output``), each
completed copy left the reviewed bytes in its operation directory: the upload
for a file sent from another computer, or the operation's snapshot of a library
file. Nothing reads them afterwards except Restore a Copy of that output, and
that file is already in the library or on the computer it came from. Undo of a
copy snapshots the published output instead, so deleting a kept copy leaves
Undo working.

These are Cairndex's private recovery bytes, not source media. Deletion is an
explicit owner action under write mode; it checks each file just before
removing it and skips any version that an unfinished operation refers to.
"""

import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import operation_directory

_UNFINISHED = "state NOT IN ('succeeded','cancelled')"


def _candidates(store: CatalogStore) -> list[dict[str, Any]]:
    with store.connection(readonly=True) as db:
        busy = {
            value
            for row in db.execute(
                "SELECT json_extract(intent,'$.prior'),json_extract(intent,'$.upload') "
                f"FROM source_operations WHERE {_UNFINISHED}"
            )
            for value in row
            if value
        }
        rows = db.execute(
            "SELECT o.id,o.intent,r.raw FROM source_operations o "
            "JOIN source_receipts r ON r.id=o.id AND r.state IN ('local','accepted') "
            "WHERE o.state='succeeded' AND json_extract(o.intent,'$.action')='copy' "
            "AND COALESCE(json_extract(o.result,'$.kept_copy'),1)!=0 ORDER BY o.sequence"
        ).fetchall()
    found = []
    for row in rows:
        intent, receipt = json.loads(row["intent"]), json.loads(row["raw"])
        version = (receipt.get("versions_after") or {}).get(receipt.get("destination"))
        if (
            not version
            or version["version"] != "source"
            or version["evidence"]["algorithm"] != "sha256"
            or version["operation"] not in (row["id"], intent.get("upload"))
            or row["id"] in busy
            or version["operation"] in busy
        ):
            continue
        found.append(
            {
                "operation": row["id"],
                "holder": version["operation"],
                "size": version["evidence"]["size"],
            }
        )
    return found


def _present(root: Path, item: dict[str, Any]) -> bool:
    try:
        with operation_directory(root, item["holder"]) as handle:
            info = os.stat("source", dir_fd=handle, follow_symlinks=False)
    except (OSError, ReplicaError):
        # An unavailable share counts nothing; deletion reports its own errors
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size == item["size"]


def _forget(store: CatalogStore, operation: str) -> None:
    with store.connection() as db:
        row = db.execute("SELECT result FROM source_operations WHERE id=?", (operation,)).fetchone()
        result = json.loads(row[0]) if row and row[0] else {}
        result["kept_copy"] = False
        db.execute(
            "UPDATE source_operations SET result=? WHERE id=?", (value_text(result), operation)
        )


def summary(store: CatalogStore, root: Path) -> dict[str, int]:
    """How many kept copies exist and their total size, checked on the share."""
    present = [item for item in _candidates(store) if _present(root, item)]
    return {"count": len(present), "size_bytes": sum(item["size"] for item in present)}


def delete(store: CatalogStore, root: Path, authorize: Callable[[], None]) -> dict[str, int]:
    """Delete every kept copy that is still exactly as its copy recorded it."""
    count = size = 0
    for item in _candidates(store):
        authorize()
        # An operation started since the listing may now refer to this version
        if item not in _candidates(store):
            continue
        with operation_directory(root, item["holder"]) as handle:
            try:
                info = os.stat("source", dir_fd=handle, follow_symlinks=False)
            except FileNotFoundError:
                _forget(store, item["operation"])
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ReplicaError("A kept copy is not a plain file; it was left in place")
            if info.st_size != item["size"]:
                raise ReplicaError("A kept copy changed size; it was left in place")
            os.unlink("source", dir_fd=handle)
        _forget(store, item["operation"])
        count += 1
        size += item["size"]
    return {"count": count, "size_bytes": size}
