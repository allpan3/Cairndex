"""Prepare device-local bundle artwork without blocking discovery or catalog projection."""

import sqlite3
import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from cairndex.core.abort import OperationAborted, abort_scope
from cairndex.core.errors import DomainError, NotFoundError
from cairndex.media.thumbnails import ThumbnailError
from cairndex.replicas.catalog.inspector import cover
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.media_cache import (
    build_thumbnail,
    cached_thumbnail,
    foreground_covers_pending,
)

# Leave decode capacity for foreground requests even when several libraries are open.
_background_slot = threading.BoundedSemaphore(1)
PENDING = "SELECT 1 FROM cover_work WHERE state='pending' LIMIT 1"


def enqueue(db: sqlite3.Connection, bundles: Iterable[str], scan: str | None = None) -> None:
    db.executemany(
        "INSERT INTO cover_work VALUES (?,?,random(),'pending') ON CONFLICT(bundle) DO UPDATE "
        "SET scan=coalesce(excluded.scan,cover_work.scan),ticket=random(),state='pending' "
        "WHERE excluded.scan IS NULL OR cover_work.scan IS NOT excluded.scan",
        ((bundle, scan) for bundle in bundles),
    )


def changed(
    db: sqlite3.Connection,
    family: str,
    identity: str,
    old: dict[str, Any] | None,
    new: dict[str, Any] | None,
) -> None:
    if family == "asset_bundles":
        if new is None:
            db.execute("DELETE FROM cover_work WHERE bundle=?", (identity,))
        elif old is None or old["cover_file_id"] != new["cover_file_id"]:
            enqueue(db, [identity])
    elif family == "asset_files":
        fields = ("bundle_id", "role", "sequence", "relative_path", "cover_time")
        if old and new and all(old.get(key) == new.get(key) for key in fields):
            return
        enqueue(db, {row["bundle_id"] for row in (old, new) if row})


def step(store: CatalogStore, root: Path, library: str, stopped: Callable[[], bool]) -> bool:
    """Return false when foreground work or another library owns the decode capacity."""
    if foreground_covers_pending() or not _background_slot.acquire(blocking=False):
        return False
    try:
        media = ReplicaMedia(store, root, library)
        with store.connection(readonly=True) as db:
            row = db.execute(
                "SELECT bundle,ticket FROM cover_work WHERE state='pending' ORDER BY bundle LIMIT 1"
            ).fetchone()
        if not row or stopped():
            return False
        try:
            with store.connection(readonly=True) as db:
                selected = None
                if db.execute(
                    "SELECT 1 FROM catalog_rows WHERE family='asset_bundles' AND entity=?",
                    (row[0],),
                ).fetchone():
                    selected = cover(db, row[0])
                hit = cached_thumbnail(media, db, selected) if selected else None
            state = "skipped"
            if selected:
                with abort_scope(stopped):
                    if not hit:
                        build_thumbnail(media, selected["id"])
                state = "ready"
        except OperationAborted:
            return False
        except NotFoundError:
            state = "skipped"
        except (DomainError, OSError, ThumbnailError):
            state = "failed"
        if not stopped():
            with store.connection() as db:
                db.execute(
                    "UPDATE cover_work SET state=? WHERE bundle=? AND ticket=?",
                    (state, row[0], row[1]),
                )
        return True
    finally:
        _background_slot.release()
