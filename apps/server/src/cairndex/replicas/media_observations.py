"""Commit bounded local media observations after source inspection has finished."""

import sqlite3
from dataclasses import dataclass
from typing import Any

from cairndex.replicas.catalog.local_history import observed
from cairndex.replicas.catalog.projection import read_row


@dataclass(frozen=True)
class MediaObservation:
    identity: str
    path: str
    generation: str | None
    state: str
    metadata: str | None
    error: str | None
    facts: tuple[int, int] | None
    previous: tuple[Any, ...] | None

    def save(self, db: sqlite3.Connection) -> None:
        # Playback or an authored path edit can overtake a maintenance batch.
        # Never replace that newer observation with a delayed probe result.
        row = read_row(db, "asset_files", self.identity)
        cached = db.execute(
            "SELECT * FROM local_media WHERE file_id=?", (self.identity,)
        ).fetchone()
        if (
            row is None
            or row["relative_path"] != self.path
            or (tuple(cached) if cached else None) != self.previous
        ):
            return
        if self.state == "available" and self.facts is not None:
            observed(db, self.identity, self.path, *self.facts)
        else:
            db.execute("DELETE FROM local_file_facts WHERE file_id=?", (self.identity,))
        db.execute(
            "INSERT INTO local_media VALUES (?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE "
            "SET generation=excluded.generation,state=excluded.state,metadata=excluded.metadata,"
            "error=excluded.error WHERE local_media.generation IS NOT excluded.generation "
            "OR local_media.state IS NOT excluded.state OR local_media.metadata IS NOT "
            "excluded.metadata OR local_media.error IS NOT excluded.error",
            (self.identity, self.generation, self.state, self.metadata, self.error),
        )
