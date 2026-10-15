"""Private indexed bundle reads for the shared browser; no legacy sessions or source reads."""

import hashlib
import json
import mimetypes
import sqlite3
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from cairndex.domain.enums import GroupingState, MediaKind
from cairndex.filters.ast import FilterExpression
from cairndex.media.image_support import is_openable_media
from cairndex.replicas.catalog.query import matching, saved_filter
from cairndex.replicas.protocol import StrictModel
from cairndex.scanning.media_types import HIDDEN_NAMES, classify
from cairndex.search import to_match_query


class CatalogBundleSummary(StrictModel):
    id: str
    title: str | None
    rating: float | None
    file_count: int
    date_added: datetime
    grouping_state: GroupingState
    cover_file_id: str | None = None
    cover_key: str | None = None
    # Browse version 4: this device's last observations of the bundle's current
    # file, for card badges and the hover preview. Nothing here reads source bytes.
    has_missing: bool = False
    media_kind: str | None = None
    extension: str | None = None
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    resume_file_id: str | None = None
    resume_media_kind: str | None = None
    resume_relative_path: str | None = None
    resume_mime_type: str | None = None
    resume_container: str | None = None
    resume_video_codec: str | None = None
    resume_video_codec_tag: str | None = None
    resume_audio_codec: str | None = None
    resume_duration: float | None = None
    resume_position: float | None = None
    resume_generation: str | None = None
    resume_storyboard_version: str | None = None


class CatalogBrowsePage(StrictModel):
    items: list[CatalogBundleSummary]
    total: int
    offset: int
    limit: int


# Unsupported filters are refused by the strict request schema, never ignored.
class CatalogBrowseRequest(StrictModel):
    filter: FilterExpression | None = None
    smart_collection_id: str | None = None
    collection_id: str | None = None
    include_descendants: bool = True
    view: Literal["all", "uncategorized", "untagged", "recent", "random", "missing"] = "all"
    seed: int = Field(default=0, ge=0, le=2_147_483_647)
    q: str = Field(default="", max_length=1000)
    sort: Literal["title", "rating", "date_added", "manual", "file_count"] = "title"
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


# Shared scanner exclusions apply to the complete eligible population.
ELIGIBLE = (
    ELIGIBLE[:-2]
    + "".join(
        f" AND instr('/'||json_extract(f.body,'$.relative_path')||'/','/{name}/')=0"
        for name in sorted(HIDDEN_NAMES)
    )
    + "))"
)


def _scope(db: sqlite3.Connection, request: CatalogBrowseRequest) -> tuple[str, list[Any]]:
    """The complete eligible population of one browse request, as a WHERE clause."""
    where = ELIGIBLE
    args: list[Any] = []
    expressions = [request.filter]
    if request.smart_collection_id:
        expressions.append(saved_filter(db, request.smart_collection_id))
    if request.collection_id:
        expressions.append(
            FilterExpression.model_validate(
                {
                    "root": {
                        "field": "collections",
                        "operator": "contains_any",
                        "value": [request.collection_id],
                        "include_descendants": request.include_descendants,
                    }
                }
            )
        )
    if request.view in ("uncategorized", "untagged"):
        family = (
            "asset_bundle_collections" if request.view == "uncategorized" else "asset_bundle_tags"
        )
        where += (
            f" AND NOT EXISTS (SELECT 1 FROM catalog_rows e WHERE e.family='{family}' "
            "AND json_extract(e.body,'$.bundle_id')=b.entity)"
        )
    if request.view == "missing":
        where += (
            " AND EXISTS (SELECT 1 FROM catalog_rows f JOIN local_media m ON m.file_id=f.entity "
            "WHERE f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity "
            "AND m.state='unavailable')"
        )
    for expression in expressions:
        if expression is not None:
            sql, values = matching(db, expression)
            where += f" AND b.entity IN ({sql})"
            args.extend(values)
    match = to_match_query(request.q)
    if match:
        where += " AND b.rowid IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ?)"
        args.append(match)
    return where, args


def _ordering(db: sqlite3.Connection, request: CatalogBrowseRequest) -> tuple[str, list[Any]]:
    """The ORDER BY terms of one browse request, ending with the stable identity tie."""
    order_args: list[Any] = []
    column = {
        "title": "lower(json_extract(b.body,'$.title'))",
        "rating": "json_extract(b.body,'$.rating')",
        "date_added": "json_extract(b.body,'$.created_at')",
        "manual": "json_extract(b.body,'$.manual_order')",
        "file_count": (
            "(SELECT count(*) FROM catalog_rows f WHERE f.family='asset_files' "
            "AND json_extract(f.body,'$.bundle_id')=b.entity)"
        ),
    }[request.sort]
    if request.sort == "manual" and request.collection_id and not request.include_descendants:
        # One collection orders by its own membership; a descendant view spans several
        column = (
            "(SELECT json_extract(e.body,'$.sort_order') FROM catalog_rows e "
            "WHERE e.family='asset_bundle_collections' AND e.entity=b.entity || '~' || ?)"
        )
        order_args.append(request.collection_id)
    # Under Manual, a bundle nobody has reordered keeps its creation value, so newer
    # bundles come first among equals, as in the legacy browser
    tie = "ASC"
    if request.sort == "manual":
        tie = "DESC" if request.order == "asc" else "ASC"
    if request.view == "random":
        # Stable identities keep the order unchanged when projection rows are replaced.
        db.create_function(
            "catalog_shuffle",
            1,
            lambda identity: hashlib.sha256(f"{request.seed}/{identity}".encode()).hexdigest(),
            deterministic=True,
        )
        column = "catalog_shuffle(b.entity)"
        order_args, tie = [], "ASC"
    return f"{column} {request.order},b.entity {tie}", order_args


def scope_order(
    db: sqlite3.Connection,
    collection_id: str | None,
    sort: Literal["title", "rating", "date_added", "manual", "file_count"],
    order: Literal["asc", "desc"],
) -> list[str]:
    """Every bundle of one manual-order scope, as the browser sorts it.

    The scope is one collection's own bundles or, without one, All bundles, as
    the legacy browser's manual order is.
    """
    request = CatalogBrowseRequest(
        collection_id=collection_id, include_descendants=False, sort=sort, order=order
    )
    where, args = _scope(db, request)
    ordering, order_args = _ordering(db, request)
    return [
        row[0]
        for row in db.execute(
            f"SELECT b.entity FROM catalog_rows b WHERE {where} ORDER BY {ordering}",
            [*args, *order_args],
        )
    ]


def browse(db: sqlite3.Connection, request: CatalogBrowseRequest) -> CatalogBrowsePage:
    """Search the complete eligible projection before SQL ordering and pagination."""
    where, args = _scope(db, request)
    total = db.execute(f"SELECT count(*) FROM catalog_rows b WHERE {where}", args).fetchone()[0]
    ordering, order_args = _ordering(db, request)
    rows = db.execute(
        f"SELECT b.entity,b.body FROM catalog_rows b WHERE {where} "
        f"ORDER BY {ordering} LIMIT ? OFFSET ?",
        [*args, *order_args, request.limit, request.offset],
    ).fetchall()
    local = _local_facts(db, [row["entity"] for row in rows])
    items = []
    for row in rows:
        from cairndex.replicas.catalog.inspector import cover

        value = json.loads(row["body"])
        artwork = cover(db, row["entity"])
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
                cover_file_id=artwork["id"] if artwork else None,
                cover_key=f"{artwork['id']}:{artwork['cover_time']}" if artwork else None,
                **local.get(row["entity"], {}),
            )
        )
    return CatalogBrowsePage(items=items, total=total, offset=request.offset, limit=request.limit)


# True when the shared viewer has a stage for this file type, as on the legacy card
def _supported(path: str) -> bool:
    kind = classify(path.rsplit("/", 1)[-1])
    if kind is None or kind[0] not in (MediaKind.IMAGE, MediaKind.VIDEO):
        return False
    return is_openable_media(kind[0], path)


def _local_facts(db: sqlite3.Connection, ids: list[str]) -> dict[str, dict[str, Any]]:
    """One page's card facts from this device's private observations, in three statements.

    The current file follows the legacy card: the bundle's cursor, then the first
    member with an unfinished resume position, then the first member last seen
    available, then the first member the viewer can show. A file this device
    never observed has no media details and no hover preview. Missing uses the
    Missing Files view's rule: the last local check found a file unavailable.
    """
    from cairndex.media.storyboards import storyboard_cache_key
    from cairndex.replicas.catalog.album import visible

    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    owners = {f"asset_bundles/{identity}/$members": identity for identity in ids}
    members: dict[str, list[sqlite3.Row]] = {}
    for row in db.execute(
        "SELECT p.owner,c.entity AS id,json_extract(c.body,'$.relative_path') AS path,"
        "m.state,m.generation,m.metadata,g.position,g.completed "
        "FROM catalog_placements p JOIN catalog_rows c ON p.family=c.family AND p.entity=c.entity "
        "LEFT JOIN local_media m ON m.file_id=c.entity "
        "LEFT JOIN local_progress g ON g.file_id=c.entity AND g.generation=m.generation "
        f"WHERE p.owner IN ({marks}) AND c.family='asset_files' AND "
        + visible("json_extract(c.body,'$.relative_path')")
        + " ORDER BY CAST(json_extract(p.body,'$.sequence') AS INTEGER),c.entity",
        list(owners),
    ):
        members.setdefault(owners[row["owner"]], []).append(row)
    cursors = dict(
        db.execute(f"SELECT bundle_id,file_id FROM local_cursors WHERE bundle_id IN ({marks})", ids)
    )
    missing = {
        row[0]
        for row in db.execute(
            "SELECT DISTINCT json_extract(f.body,'$.bundle_id') FROM catalog_rows f "
            "JOIN local_media m ON m.file_id=f.entity WHERE f.family='asset_files' "
            f"AND json_extract(f.body,'$.bundle_id') IN ({marks}) AND m.state='unavailable'",
            ids,
        )
    }
    facts: dict[str, dict[str, Any]] = {}
    for identity in ids:
        supported = [row for row in members.get(identity, []) if _supported(row["path"])]
        available = [row for row in supported if row["state"] == "available"]
        current = (
            next((row for row in supported if row["id"] == cursors.get(identity)), None)
            or next((row for row in available if row["position"] and not row["completed"]), None)
            or next(iter(available), None)
            or next(iter(supported), None)
        )
        fact: dict[str, Any] = {"has_missing": identity in missing}
        if current is not None:
            kind = classify(current["path"].rsplit("/", 1)[-1])
            meta = json.loads(current["metadata"]) if current["metadata"] else {}
            fact |= {
                "media_kind": str(kind[0]) if kind else None,
                "extension": current["path"].rpartition(".")[2].lower() or None,
                "width": meta.get("width"),
                "height": meta.get("height"),
                "duration": meta.get("duration"),
                "resume_file_id": current["id"],
            }
            # Only a file last seen available previews; the routes check it again
            if current["state"] == "available" and current["generation"]:
                fact |= {
                    "resume_media_kind": fact["media_kind"],
                    "resume_relative_path": current["path"],
                    "resume_mime_type": mimetypes.guess_type(current["path"])[0],
                    "resume_container": meta.get("container"),
                    "resume_video_codec": meta.get("video_codec"),
                    "resume_video_codec_tag": meta.get("video_codec_tag"),
                    "resume_audio_codec": meta.get("audio_codec"),
                    "resume_duration": meta.get("duration"),
                    "resume_position": None
                    if current["completed"] or not current["position"]
                    else current["position"],
                    "resume_generation": current["generation"],
                    "resume_storyboard_version": storyboard_cache_key(current["generation"]),
                }
        facts[identity] = fact
    return facts


class CatalogUnbundledRequest(StrictModel):
    q: str = Field(default="", max_length=1000)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class CatalogUnbundledFile(StrictModel):
    id: str
    bundle_id: str
    relative_path: str


class CatalogUnbundledPage(StrictModel):
    items: list[CatalogUnbundledFile]
    total: int
    offset: int
    limit: int


def unbundled(db: sqlite3.Connection, request: CatalogUnbundledRequest) -> CatalogUnbundledPage:
    """List staged files from the complete catalog without observing source bytes."""
    where = (
        "f.family='asset_files' AND b.family='asset_bundles' "
        "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
        "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' "
        "AND json_extract(f.body,'$.relative_path') NOT LIKE '.%' "
        "AND json_extract(f.body,'$.relative_path') NOT LIKE '%/.%' "
        "AND instr(lower(json_extract(f.body,'$.relative_path')),lower(?))>0"
    ) + "".join(
        f" AND instr('/'||json_extract(f.body,'$.relative_path')||'/','/{name}/')=0"
        for name in sorted(HIDDEN_NAMES)
    )
    source = (
        "FROM catalog_rows f JOIN catalog_rows b "
        "ON b.entity=json_extract(f.body,'$.bundle_id') WHERE " + where
    )
    total = db.execute("SELECT count(*) " + source, (request.q,)).fetchone()[0]
    rows = db.execute(
        "SELECT f.entity,json_extract(f.body,'$.bundle_id'),json_extract(f.body,'$.relative_path') "
        + source
        + " ORDER BY lower(json_extract(f.body,'$.relative_path')),f.entity LIMIT ? OFFSET ?",
        (request.q, request.limit, request.offset),
    )
    return CatalogUnbundledPage(
        items=[
            CatalogUnbundledFile(id=row[0], bundle_id=row[1], relative_path=row[2]) for row in rows
        ],
        total=total,
        offset=request.offset,
        limit=request.limit,
    )
