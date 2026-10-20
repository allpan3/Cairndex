"""Derived catalog search index, preserved across private schema upgrades."""

import sqlite3

from cairndex.replicas.protocol import ReplicaError
from cairndex.scanning.media_types import _AUDIO, _IMAGE, _SUBTITLE, _VIDEO

# Retained exactly for recognition of recoverable historical private schemas.
LEGACY_INDEX_SCHEMA = """
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


def _legacy_owner(row: str) -> str:
    return (
        f"CASE {row}.family WHEN 'asset_bundles' THEN {row}.entity "
        f"WHEN 'asset_files' THEN json_extract({row}.body,'$.bundle_id') "
        f"WHEN 'moments' THEN (SELECT json_extract(body,'$.bundle_id') FROM catalog_rows "
        f"WHERE family='asset_files' AND entity=json_extract({row}.body,'$.file_id')) END"
    )


def _legacy_refresh(owner: str) -> str:
    rowid = f"(SELECT rowid FROM catalog_rows WHERE family='asset_bundles' AND entity={owner})"
    return (
        f"DELETE FROM catalog_search WHERE rowid={rowid}; "
        f"INSERT INTO catalog_search(rowid,bundle_id,title,notes,file_notes,moments) "
        f"SELECT * FROM catalog_search_source WHERE id={rowid}; "
    )


# Projection replacement uses DELETE then INSERT in the same writer transaction.
LEGACY_INDEX_SCHEMA += (
    "CREATE TRIGGER IF NOT EXISTS catalog_search_delete BEFORE DELETE ON catalog_rows "
    "WHEN OLD.family='asset_bundles' BEGIN DELETE FROM catalog_search WHERE rowid=OLD.rowid; END;"
    "CREATE TRIGGER IF NOT EXISTS catalog_search_insert AFTER INSERT ON catalog_rows "
    "WHEN NEW.family IN ('asset_bundles','asset_files','moments') BEGIN "
    + _legacy_refresh(_legacy_owner("NEW"))
    + "END; CREATE TRIGGER IF NOT EXISTS catalog_search_remove AFTER DELETE ON catalog_rows "
    "WHEN OLD.family IN ('asset_files','moments') BEGIN "
    + _legacy_refresh(_legacy_owner("OLD"))
    + "END;"
)


def _kind() -> str:
    # Filename classification supplies the same searchable kind without a probe.
    parts = []
    for kind, extensions in (
        ("video", _VIDEO),
        ("image", _IMAGE),
        ("subtitle", _SUBTITLE),
        ("audio", _AUDIO),
    ):
        condition = " OR ".join(
            f"lower(json_extract(f.body,'$.relative_path')) LIKE '%.{extension}'"
            for extension in sorted(extensions)
        )
        parts.append(f"WHEN {condition} THEN '{kind}'")
    return "CASE " + " ".join(parts) + " ELSE 'other' END"


COLUMNS = "bundle_id,title,notes,file_notes,moments,files,tags,collections"
INDEX_SCHEMA = (
    """
CREATE INDEX IF NOT EXISTS catalog_file_bundle ON catalog_rows(
 json_extract(body,'$.bundle_id')) WHERE family='asset_files';
CREATE INDEX IF NOT EXISTS catalog_moment_file ON catalog_rows(
 json_extract(body,'$.file_id')) WHERE family='moments';
CREATE INDEX IF NOT EXISTS catalog_search_tag_members ON catalog_rows(
 json_extract(body,'$.bundle_id'),json_extract(body,'$.tag_id')) WHERE family='asset_bundle_tags';
CREATE INDEX IF NOT EXISTS catalog_search_tag_owners ON catalog_rows(
 json_extract(body,'$.tag_id'),json_extract(body,'$.bundle_id')) WHERE family='asset_bundle_tags';
CREATE INDEX IF NOT EXISTS catalog_search_collection_members ON catalog_rows(
 json_extract(body,'$.bundle_id'),json_extract(body,'$.collection_id'))
 WHERE family='asset_bundle_collections';
CREATE INDEX IF NOT EXISTS catalog_search_collection_owners ON catalog_rows(
 json_extract(body,'$.collection_id'),json_extract(body,'$.bundle_id'))
 WHERE family='asset_bundle_collections';
CREATE VIEW IF NOT EXISTS catalog_search_source AS
SELECT b.rowid AS id,b.entity AS bundle_id,
 coalesce(json_extract(b.body,'$.title'),'') AS title,
 coalesce((SELECT group_concat(value,' ')
 FROM json_each(json_extract(b.body,'$.notes'))),'') AS notes,
 coalesce((SELECT group_concat(json_extract(f.body,'$.note'),' ') FROM catalog_rows f
 WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity),'') AS file_notes,
 coalesce((SELECT group_concat(json_extract(m.body,'$.comment'),' ') FROM catalog_rows f
 JOIN catalog_rows m ON m.family='moments' AND json_extract(m.body,'$.file_id')=f.entity
 WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity),'') AS moments,
 coalesce((SELECT group_concat(
 coalesce(json_extract(f.body,'$.display_title'),'')||' '||
 coalesce(json_extract(f.body,'$.original_filename'),'')||' '||
 json_extract(f.body,'$.relative_path')||' '||coalesce(json_extract(f.body,'$.source'),'')||' '||
 """
    + _kind()
    + """,' ') FROM catalog_rows f
 WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity),'') AS files,
 coalesce((SELECT group_concat(json_extract(t.body,'$.name'),' ') FROM catalog_rows e
 JOIN catalog_rows t ON t.family='tags' AND t.entity=json_extract(e.body,'$.tag_id')
 WHERE e.family='asset_bundle_tags' AND json_extract(e.body,'$.bundle_id')=b.entity),'') AS tags,
 coalesce((SELECT group_concat(json_extract(c.body,'$.name'),' ') FROM catalog_rows e
 JOIN catalog_rows c ON c.family='collections' AND c.entity=json_extract(e.body,'$.collection_id')
 WHERE e.family='asset_bundle_collections' AND json_extract(e.body,'$.bundle_id')=b.entity),'')
 AS collections
FROM catalog_rows b WHERE b.family='asset_bundles';
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search USING fts5(
 bundle_id UNINDEXED,title,notes,file_notes,moments,files,tags,collections,
 tokenize='unicode61 remove_diacritics 2');
"""
)


def _owners(row: str) -> str:
    return (
        f"SELECT {row}.entity WHERE {row}.family='asset_bundles' "
        f"UNION SELECT json_extract({row}.body,'$.bundle_id') WHERE {row}.family IN "
        "('asset_files','asset_bundle_tags','asset_bundle_collections') "
        "UNION SELECT json_extract(body,'$.bundle_id') FROM catalog_rows "
        f"WHERE {row}.family='moments' AND family='asset_files' "
        f"AND entity=json_extract({row}.body,'$.file_id') "
        "UNION SELECT json_extract(body,'$.bundle_id') FROM catalog_rows "
        f"WHERE {row}.family='tags' AND family='asset_bundle_tags' "
        f"AND json_extract(body,'$.tag_id')={row}.entity "
        "UNION SELECT json_extract(body,'$.bundle_id') FROM catalog_rows "
        f"WHERE {row}.family='collections' AND family='asset_bundle_collections' "
        f"AND json_extract(body,'$.collection_id')={row}.entity"
    )


def _refresh(row: str) -> str:
    rowids = (
        "(SELECT rowid FROM catalog_rows WHERE family='asset_bundles' "
        f"AND entity IN ({_owners(row)}))"
    )
    return (
        f"DELETE FROM catalog_search WHERE rowid IN {rowids}; "
        f"INSERT INTO catalog_search(rowid,{COLUMNS}) "
        f"SELECT * FROM catalog_search_source WHERE id IN {rowids}; "
    )


INDEX_SCHEMA += (
    "CREATE TRIGGER IF NOT EXISTS catalog_search_delete BEFORE DELETE ON catalog_rows "
    "WHEN OLD.family='asset_bundles' BEGIN DELETE FROM catalog_search WHERE rowid=OLD.rowid; END;"
    "CREATE TRIGGER IF NOT EXISTS catalog_search_insert AFTER INSERT ON catalog_rows "
    "WHEN NEW.family IN ('asset_bundles','asset_files','moments','tags','collections',"
    "'asset_bundle_tags','asset_bundle_collections') BEGIN " + _refresh("NEW") + "END;"
    "CREATE TRIGGER IF NOT EXISTS catalog_search_remove AFTER DELETE ON catalog_rows "
    "WHEN OLD.family IN ('asset_files','moments','tags','collections',"
    "'asset_bundle_tags','asset_bundle_collections') BEGIN " + _refresh("OLD") + "END;"
)

INDEXES = (
    "catalog_file_bundle",
    "catalog_moment_file",
    "catalog_search_tag_members",
    "catalog_search_tag_owners",
    "catalog_search_collection_members",
    "catalog_search_collection_owners",
)
DROP_STATEMENTS = (
    tuple(
        f"DROP TRIGGER IF EXISTS {name}"
        for name in ("catalog_search_insert", "catalog_search_delete", "catalog_search_remove")
    )
    + ("DROP VIEW IF EXISTS catalog_search_source", "DROP TABLE IF EXISTS catalog_search")
    + tuple(f"DROP INDEX IF EXISTS {name}" for name in INDEXES)
)


def remove(db: sqlite3.Connection) -> None:
    """Discard derived search only; authored and private owner state stay intact."""
    for statement in DROP_STATEMENTS:
        db.execute(statement)


def install(db: sqlite3.Connection) -> None:
    """Build an older store's derived index in bounded batches before serving it."""
    columns = [row[1] for row in db.execute("PRAGMA table_info(catalog_search)")]
    if columns not in (
        [],
        COLUMNS.split(","),
        ["bundle_id", "title", "notes", "file_notes", "moments"],
    ):
        raise ReplicaError("Unknown private search layout; recovery requires an upgrade")
    upgrade = bool(columns and columns != COLUMNS.split(","))
    # Replacement and complete repopulation share one transaction, including DDL.
    drop = ";".join(DROP_STATEMENTS) + ";" if upgrade else ""
    db.executescript("BEGIN IMMEDIATE;" + drop + INDEX_SCHEMA)
    if columns and not upgrade:
        return
    last = 0
    while rows := db.execute(
        "SELECT rowid FROM catalog_rows WHERE family='asset_bundles' AND rowid>? "
        "ORDER BY rowid LIMIT 256",
        (last,),
    ).fetchall():
        last = rows[-1][0]
        db.execute(
            f"INSERT INTO catalog_search(rowid,{COLUMNS}) "
            "SELECT * FROM catalog_search_source WHERE id BETWEEN ? AND ?",
            (rows[0][0], last),
        )
