"""Prepare an empty directory through the existing retained-version publication path."""

import os
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from cairndex.core.paths import PathSafetyError
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import observation, operation_directory, parent, source_path
from cairndex.replicas.source_journal import SourceRequest, retain_version
from cairndex.replicas.source_plan import path_identity, require_resolved_paths
from cairndex.replicas.source_trees import descend, entries, evidence, save_index


def prepare_directory(
    store: CatalogStore, root: Path, request: SourceRequest, progress: Callable[[int], None]
) -> dict[str, Any]:
    if request.source or request.upload or request.prior or request.collision != "fail":
        raise ReplicaError("New Folder requires a vacant destination and no source")
    try:
        destination = source_path(request.destination)
    except PathSafetyError as error:
        raise ReplicaError("Folder name or path is not allowed") from error
    with parent(root, destination) as (handle, _):
        info = os.fstat(handle)
        parent_identity = [info.st_dev, info.st_ino]
    if observation(root, destination) is not None:
        raise ReplicaError("Folder name is already in use; choose another name")
    with store.connection(readonly=True) as db:
        require_resolved_paths(db, destination, tree=True)
        if (
            path_identity(db, destination)
            or db.execute(
                "SELECT 1 FROM catalog_paths WHERE path>=? AND path<? LIMIT 1",
                (destination + "/", destination + "0"),
            ).fetchone()
        ):
            raise ReplicaError("Folder path has catalog entries; choose another name")
    progress(0)
    # A retained empty tree lets apply/retry/Undo use the same no-replace
    # publication and exact identity checks as directory copies.
    with operation_directory(root, request.operation, create=True) as handle:
        with suppress(FileExistsError):
            os.mkdir("source", 0o700, dir_fd=handle)
        with descend(handle, "source") as folder:
            if entries(folder):
                raise ReplicaError("Retained new folder is no longer empty")
            os.fsync(folder)
        save_index(handle, "source", [])
        os.fsync(handle)
    version: dict[str, Any] = {
        "operation": request.operation,
        "version": "source",
        "evidence": evidence([]),
    }
    retain_version(store, request.operation, destination, "source", version["evidence"])
    info = root.stat(follow_symlinks=False)
    return {
        "root_identity": [info.st_dev, info.st_ino],
        "parent_identity": parent_identity,
        "skipped": False,
        "source": "",
        "destination": destination,
        "conditions": {destination: None},
        "captures": [],
        "versions_before": {destination: None},
        "versions_after": {destination: version},
        "metadata": None,
        "before": {},
    }
