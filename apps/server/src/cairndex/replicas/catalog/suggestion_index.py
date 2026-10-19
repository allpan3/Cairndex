"""Private filename candidates for manual grouping, independent of browse search."""

import sqlite3

SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_suggestion_paths USING fts5(
 file_id UNINDEXED, path, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS catalog_suggestion_path_insert AFTER INSERT ON catalog_paths
WHEN NEW.family='asset_files' BEGIN
 INSERT INTO catalog_suggestion_paths(rowid,file_id,path) VALUES (NEW.rowid,NEW.entity,NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS catalog_suggestion_path_delete BEFORE DELETE ON catalog_paths
WHEN OLD.family='asset_files' BEGIN
 DELETE FROM catalog_suggestion_paths WHERE rowid=OLD.rowid;
END;
"""

TABLES = {
    "catalog_suggestion_paths",
    "catalog_suggestion_paths_data",
    "catalog_suggestion_paths_idx",
    "catalog_suggestion_paths_content",
    "catalog_suggestion_paths_docsize",
    "catalog_suggestion_paths_config",
    "catalog_suggestion_path_insert",
    "catalog_suggestion_path_delete",
}


def install(db: sqlite3.Connection) -> None:
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE name='catalog_suggestion_paths'"
    ).fetchone()
    db.executescript("BEGIN IMMEDIATE;" + SCHEMA)
    if exists:
        return
    last = 0
    while rows := db.execute(
        "SELECT rowid FROM catalog_paths WHERE rowid>? ORDER BY rowid LIMIT 256", (last,)
    ).fetchall():
        last = rows[-1][0]
        db.execute(
            "INSERT INTO catalog_suggestion_paths(rowid,file_id,path) "
            "SELECT rowid,entity,path FROM catalog_paths WHERE family='asset_files' "
            "AND rowid BETWEEN ? AND ?",
            (rows[0][0], last),
        )
