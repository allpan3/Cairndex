"""Phase-local Update counters, committed with each bounded worker batch."""

import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_progress (
    run TEXT PRIMARY KEY, phase TEXT NOT NULL, completed INTEGER NOT NULL, total INTEGER NOT NULL);
"""


def advance(
    db: sqlite3.Connection,
    run: str,
    phase: str,
    count: int,
    total_query: str,
    parameters: tuple[Any, ...] = (),
) -> None:
    """Count a phase's population once, before its first batch changes that population."""
    prior = db.execute("SELECT phase FROM discovery_progress WHERE run=?", (run,)).fetchone()
    if prior is None or prior[0] != phase:
        total = db.execute(total_query, parameters).fetchone()[0]
        db.execute(
            "INSERT OR REPLACE INTO discovery_progress VALUES (?,?,0,?)", (run, phase, total)
        )
    db.execute(
        "UPDATE discovery_progress SET completed=min(total,completed+?) WHERE run=?",
        (count, run),
    )
