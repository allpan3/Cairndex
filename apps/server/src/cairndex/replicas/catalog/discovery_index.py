"""Derived filename search for private discovery choices, rebuilt on upgrade."""

import sqlite3

SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS discovery_suggestion_paths USING fts5(
 path, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS discovery_suggestion_replace BEFORE INSERT ON discovery_plan_files
BEGIN
 DELETE FROM discovery_suggestion_paths WHERE rowid IN
 (SELECT rowid FROM discovery_plan_files WHERE run=NEW.run AND path=NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS discovery_suggestion_insert AFTER INSERT ON discovery_plan_files
WHEN NEW.owner IS NULL AND NEW.body<>'{}' BEGIN
 INSERT INTO discovery_suggestion_paths(rowid,path) VALUES (NEW.rowid,NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS discovery_suggestion_delete BEFORE DELETE ON discovery_plan_files
BEGIN
 DELETE FROM discovery_suggestion_paths WHERE rowid=OLD.rowid;
END;
"""


def install(db: sqlite3.Connection) -> None:
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE name='discovery_suggestion_paths'"
    ).fetchone()
    db.executescript("BEGIN IMMEDIATE;" + SCHEMA)
    if exists:
        return
    last = 0
    while rows := db.execute(
        "SELECT rowid FROM discovery_plan_files WHERE rowid>? ORDER BY rowid LIMIT 256", (last,)
    ).fetchall():
        last = rows[-1][0]
        db.execute(
            "INSERT INTO discovery_suggestion_paths(rowid,path) "
            "SELECT rowid,path FROM discovery_plan_files WHERE rowid BETWEEN ? AND ? "
            "AND owner IS NULL AND body<>'{}'",
            (rows[0][0], last),
        )
