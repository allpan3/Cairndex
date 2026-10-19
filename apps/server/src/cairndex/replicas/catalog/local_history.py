"""Device-local opening history and file facts; never authored catalog units."""

import sqlite3
from datetime import UTC, datetime
from typing import Any

from cairndex.core.time import utcnow

SCHEMA = """
CREATE TABLE IF NOT EXISTS local_file_facts (
    file_id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, modified_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_bundle_history (
    bundle_id TEXT PRIMARY KEY, opened_at TEXT, modified_at TEXT);
"""


def opened(db: sqlite3.Connection, bundle: str) -> None:
    db.execute(
        "INSERT INTO local_bundle_history(bundle_id,opened_at) VALUES (?,?) "
        "ON CONFLICT(bundle_id) DO UPDATE SET opened_at=excluded.opened_at",
        (bundle, utcnow().isoformat()),
    )


def changed(
    db: sqlite3.Connection,
    family: str,
    identity: str,
    previous: dict[str, Any] | None,
    current: dict[str, Any] | None,
) -> None:
    """Observe real projected edits, excluding unchanged guards and initial seed replay."""
    if (
        previous == current
        or not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone()
    ):
        return
    owners = (
        {identity}
        if family == "asset_bundles"
        else {row["bundle_id"] for row in (previous, current) if row and "bundle_id" in row}
    )
    now = utcnow().isoformat()
    db.executemany(
        "INSERT INTO local_bundle_history(bundle_id,modified_at) VALUES (?,?) "
        "ON CONFLICT(bundle_id) DO UPDATE SET modified_at=excluded.modified_at",
        ((owner, now) for owner in owners),
    )


def observed(
    db: sqlite3.Connection,
    file_id: str,
    path: str,
    size: int,
    mtime_ns: int,
) -> None:
    db.execute(
        "INSERT OR REPLACE INTO local_file_facts VALUES (?,?,?,?)",
        (file_id, path, size, datetime.fromtimestamp(mtime_ns / 1_000_000_000, UTC).isoformat()),
    )


# Correlated only through indexed bundle members; no source reads during sorting.
SIZE_SQL = """(SELECT CASE WHEN count(*)=count(s.file_id) THEN coalesce(sum(s.size),0) END
FROM catalog_rows f LEFT JOIN local_file_facts s ON s.file_id=f.entity
AND s.path=json_extract(f.body,'$.relative_path')
WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity)"""
OPENED_SQL = "(SELECT opened_at FROM local_bundle_history WHERE bundle_id=b.entity)"
MODIFIED_SQL = """coalesce((SELECT modified_at FROM local_bundle_history WHERE bundle_id=b.entity),
json_extract(b.body,'$.updated_at'))"""
