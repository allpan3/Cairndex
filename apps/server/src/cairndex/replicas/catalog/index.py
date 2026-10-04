"""Derived catalog search index, preserved across private schema upgrades."""

import sqlite3

INDEX_SCHEMA = """
CREATE INDEX IF NOT EXISTS catalog_file_bundle ON catalog_rows(
    json_extract(body,'$.bundle_id')) WHERE family='asset_files';
CREATE INDEX IF NOT EXISTS catalog_moment_file ON catalog_rows(
    json_extract(body,'$.file_id')) WHERE family='moments';
CREATE VIEW IF NOT EXISTS catalog_search_source AS
SELECT b.rowid AS id, b.entity AS bundle_id,
 coalesce(json_extract(b.body,'$.title'),'') AS title,
 coalesce((SELECT group_concat(value,' ')
 FROM json_each(json_extract(b.body,'$.notes'))),'') AS notes,
 coalesce((SELECT group_concat(json_extract(f.body,'$.note'),' ') FROM catalog_rows f
 WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity),'') AS file_notes,
 coalesce((SELECT group_concat(json_extract(m.body,'$.comment'),' ') FROM catalog_rows f
 JOIN catalog_rows m ON m.family='moments' AND json_extract(m.body,'$.file_id')=f.entity
 WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity),'') AS moments
FROM catalog_rows b WHERE b.family='asset_bundles';
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search USING fts5(
 bundle_id UNINDEXED, title, notes, file_notes, moments,
 tokenize='unicode61 remove_diacritics 2');
"""


def _owner(row: str) -> str:
    return (
        f"CASE {row}.family WHEN 'asset_bundles' THEN {row}.entity "
        f"WHEN 'asset_files' THEN json_extract({row}.body,'$.bundle_id') "
        f"WHEN 'moments' THEN (SELECT json_extract(body,'$.bundle_id') FROM catalog_rows "
        f"WHERE family='asset_files' AND entity=json_extract({row}.body,'$.file_id')) END"
    )


def _refresh(owner: str) -> str:
    rowid = f"(SELECT rowid FROM catalog_rows WHERE family='asset_bundles' AND entity={owner})"
    return (
        f"DELETE FROM catalog_search WHERE rowid={rowid}; "
        f"INSERT INTO catalog_search(rowid,bundle_id,title,notes,file_notes,moments) "
        f"SELECT * FROM catalog_search_source WHERE id={rowid}; "
    )


# Projection replacement uses DELETE then INSERT in the same writer transaction.
INDEX_SCHEMA += (
    "CREATE TRIGGER IF NOT EXISTS catalog_search_delete BEFORE DELETE ON catalog_rows "
    "WHEN OLD.family='asset_bundles' BEGIN DELETE FROM catalog_search WHERE rowid=OLD.rowid; END;"
    "CREATE TRIGGER IF NOT EXISTS catalog_search_insert AFTER INSERT ON catalog_rows "
    "WHEN NEW.family IN ('asset_bundles','asset_files','moments') BEGIN "
    + _refresh(_owner("NEW"))
    + "END; CREATE TRIGGER IF NOT EXISTS catalog_search_remove AFTER DELETE ON catalog_rows "
    "WHEN OLD.family IN ('asset_files','moments') BEGIN " + _refresh(_owner("OLD")) + "END;"
)


def install(db: sqlite3.Connection) -> None:
    """Build an older store's derived index in bounded batches before serving it."""
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='catalog_search'").fetchone()
    db.executescript("BEGIN IMMEDIATE;" + INDEX_SCHEMA)
    if exists:
        return
    last = 0
    while rows := db.execute(
        "SELECT rowid FROM catalog_rows WHERE family='asset_bundles' AND rowid>? "
        "ORDER BY rowid LIMIT 256",
        (last,),
    ).fetchall():
        last = rows[-1][0]
        db.execute(
            "INSERT INTO catalog_search(rowid,bundle_id,title,notes,file_notes,moments) "
            "SELECT * FROM catalog_search_source WHERE id BETWEEN ? AND ?",
            (rows[0][0], last),
        )
