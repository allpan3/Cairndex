"""Private indexed bundle reads for the shared browser; no legacy sessions or source reads."""

import json
import sqlite3
from datetime import datetime
from typing import Literal

from pydantic import Field

from cairndex.domain.enums import GroupingState
from cairndex.replicas.protocol import StrictModel
from cairndex.search import to_match_query


class CatalogBundleSummary(StrictModel):
    id: str
    title: str | None
    rating: float | None
    file_count: int
    date_added: datetime
    grouping_state: GroupingState


class CatalogBrowsePage(StrictModel):
    items: list[CatalogBundleSummary]
    total: int
    offset: int
    limit: int


# Unsupported filters are refused by the strict request schema, never ignored.
class CatalogBrowseRequest(StrictModel):
    q: str = Field(default="", max_length=1000)
    sort: Literal["title", "rating", "date_added"] = "title"
    order: Literal["asc", "desc"] = "asc"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


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


# Empty bundles and confirmed bundles with at least one visible member match legacy All.
ELIGIBLE = """b.family='asset_bundles'
AND NOT (json_extract(b.body,'$.grouping_state')='PROVISIONAL'
 AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION')
AND (NOT EXISTS (SELECT 1 FROM catalog_rows f WHERE f.family='asset_files'
 AND json_extract(f.body,'$.bundle_id')=b.entity)
 OR EXISTS (SELECT 1 FROM catalog_rows f WHERE f.family='asset_files'
 AND json_extract(f.body,'$.bundle_id')=b.entity
 AND json_extract(f.body,'$.relative_path') NOT LIKE '.%'
 AND json_extract(f.body,'$.relative_path') NOT LIKE '%/.%'))"""


def browse(db: sqlite3.Connection, request: CatalogBrowseRequest) -> CatalogBrowsePage:
    """Search the complete eligible projection before SQL ordering and pagination."""
    where = ELIGIBLE
    args: list[str | int] = []
    match = to_match_query(request.q)
    if match:
        where += " AND b.rowid IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ?)"
        args.append(match)
    total = db.execute(f"SELECT count(*) FROM catalog_rows b WHERE {where}", args).fetchone()[0]
    column = {
        "title": "lower(json_extract(b.body,'$.title'))",
        "rating": "json_extract(b.body,'$.rating')",
        "date_added": "json_extract(b.body,'$.created_at')",
    }[request.sort]
    rows = db.execute(
        f"SELECT b.entity,b.body FROM catalog_rows b WHERE {where} "
        f"ORDER BY {column} {request.order},b.entity ASC LIMIT ? OFFSET ?",
        [*args, request.limit, request.offset],
    )
    items = []
    for row in rows:
        value = json.loads(row["body"])
        count = db.execute(
            "SELECT count(*) FROM catalog_rows WHERE family='asset_files' "
            "AND json_extract(body,'$.bundle_id')=?",
            (row["entity"],),
        ).fetchone()[0]
        items.append(
            CatalogBundleSummary(
                id=row["entity"],
                title=value["title"],
                rating=value["rating"],
                file_count=count,
                date_added=datetime.fromisoformat(value["created_at"]),
                grouping_state=GroupingState[value["grouping_state"]],
            )
        )
    return CatalogBrowsePage(items=items, total=total, offset=request.offset, limit=request.limit)
