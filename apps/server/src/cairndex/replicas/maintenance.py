"""Explicit local media passes advance file by file on the background source worker.

The catalog job retains only the requested pass and a bounded progress cursor.
Probes and derivatives never author metadata. Ordinary catalog exchange does
not run this work, so a status request cannot start a whole-library media pass.
"""

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from pydantic import Field

from cairndex.core.abort import OperationAborted, abort_scope
from cairndex.core.errors import DomainError
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.media_observations import MediaObservation
from cairndex.replicas.protocol import StrictModel


class MaintenanceIntent(StrictModel):
    kind: Literal["probe", "storyboards"]


class MaintenanceProgress(StrictModel):
    cursor: str = ""
    upper: str = ""
    completed: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    waiting_file: str | None = None
    waiting_generation: str | None = None


def latest(store: CatalogStore) -> dict[str, Any]:
    from cairndex.replicas.catalog.jobs import job

    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT id,intent FROM catalog_jobs WHERE json_extract(intent,'$.action')="
            "'media_maintenance' ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
    return {
        "job": job(store, row[0]) if row else None,
        "kind": json.loads(row[1])["body"]["kind"] if row else None,
    }


# Source inspection runs outside the writer lock. At most 32 observations and
# their progress cursor commit together; a slow file can exceed the time budget.
PASS_SECONDS = 0.25
BATCH = 32


def advance(store: CatalogStore, root: Path, library: str, stopped: Callable[[], bool]) -> None:
    """Commit one bounded batch, yielding to saves and Release between batches."""
    step(store, root, library, stopped, limit=BATCH, deadline=time.monotonic() + PASS_SECONDS)


def step(
    store: CatalogStore,
    root: Path,
    library: str,
    stopped: Callable[[], bool],
    *,
    limit: int = 1,
    deadline: float | None = None,
) -> bool:
    """Inspect a bounded page and atomically save its observations and progress."""
    with store.connection(readonly=True) as db:
        if db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone():
            return False
        if not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone():
            return False
        row = db.execute(
            "SELECT id,intent,result FROM catalog_jobs WHERE state='queued' "
            "AND json_extract(intent,'$.action')='media_maintenance' ORDER BY sequence LIMIT 1"
        ).fetchone()
        if row is None:
            return False
        intent = MaintenanceIntent.model_validate(json.loads(row["intent"])["body"])
        progress = (
            MaintenanceProgress.model_validate_json(row["result"])
            if row["result"]
            else MaintenanceProgress(
                upper=db.execute(
                    "SELECT COALESCE(MAX(entity),'') FROM catalog_rows WHERE family='asset_files'"
                ).fetchone()[0],
                total=db.execute(
                    "SELECT COUNT(*) FROM catalog_rows WHERE family='asset_files'"
                ).fetchone()[0],
            )
        )
        files = db.execute(
            "SELECT entity FROM catalog_rows WHERE family='asset_files' AND entity>? AND entity<=? "
            "ORDER BY entity LIMIT ?",
            (progress.cursor, progress.upper, min(limit, BATCH)),
        ).fetchall()

    with store.connection(readonly=True) as checks:
        # Each cancellation SELECT needs current committed state. Autocommit
        # keeps those reads fresh while reusing SQLite's parsed schema.
        checks.rollback()

        def interrupted() -> bool:
            if stopped():
                return True
            current = checks.execute(
                "SELECT state FROM catalog_jobs WHERE id=?", (row["id"],)
            ).fetchone()
            return current is None or current[0] != "queued"

        state, advanced = "queued", False
        observations: list[MediaObservation] = []
        # A short page also proves completion. A full page leaves it to the next pass.
        pending = [*files, None] if len(files) < min(limit, BATCH) else files
        with store.connection(readonly=True) as snapshot:
            # Storyboard adapters escape to another thread; only this synchronous
            # probe page can borrow the snapshot. Cancellation reads stay fresh.
            media = ReplicaMedia(
                store, root, library, snapshot=snapshot if intent.kind == "probe" else None
            )
            for file in pending:
                try:
                    with abort_scope(interrupted):
                        if interrupted():
                            return False
                        if file is None:
                            state = "succeeded"
                            progress.total = progress.completed
                        else:
                            waiting = False
                            token = (
                                progress.waiting_generation
                                if progress.waiting_file == file[0]
                                else None
                            )
                            if token is None:
                                asset = media.file(
                                    file[0], inspect=True, probe=True, observations=observations
                                )
                                if (
                                    asset.availability != FileAvailability.AVAILABLE
                                    or asset.media_kind
                                    not in {
                                        MediaKind.VIDEO,
                                        MediaKind.IMAGE,
                                        MediaKind.AUDIO,
                                    }
                                ):
                                    progress.skipped += 1
                                elif not asset.tech_metadata:
                                    progress.failed += 1
                                elif (
                                    intent.kind == "storyboards"
                                    and asset.media_kind == MediaKind.VIDEO
                                ):
                                    token = asset.quick_fingerprint
                            if token is not None:
                                from cairndex.replicas.storyboards import get_queue

                                result = get_queue().request(media, file[0], token)
                                waiting = result.state in {"queued", "running"}
                                if waiting:
                                    progress.waiting_file = file[0]
                                    progress.waiting_generation = token
                                if result.state == "failed":
                                    progress.failed += 1
                                elif result.state == "unavailable":
                                    progress.skipped += 1
                            if not waiting:
                                progress.waiting_file = progress.waiting_generation = None
                                progress.cursor = file[0]
                                progress.completed += 1
                                advanced = True
                except OperationAborted:
                    return False
                except (DomainError, OSError):
                    # Errors can quote source paths. Keep a count, never the raw exception.
                    if file is not None:
                        progress.waiting_file = progress.waiting_generation = None
                        progress.cursor = file[0]
                        progress.completed += 1
                        progress.failed += 1
                if state == "succeeded" or progress.waiting_file is not None:
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    break
        progress.total = max(progress.total, progress.completed)
        raw = value_text(progress.model_dump())
        if state == "queued" and raw == row["result"]:
            return False
        if interrupted():
            return False
    with store.connection() as db:
        # Cancellation or another worker's cursor wins over a completed probe page.
        current = db.execute(
            "SELECT state,result FROM catalog_jobs WHERE id=?", (row["id"],)
        ).fetchone()
        if current is None or current["state"] != "queued" or current["result"] != row["result"]:
            return False
        for observation in observations:
            observation.save(db)
        db.execute(
            "UPDATE catalog_jobs SET state=?,result=? WHERE id=? AND state='queued'",
            (state, raw, row["id"]),
        )
    return advanced
