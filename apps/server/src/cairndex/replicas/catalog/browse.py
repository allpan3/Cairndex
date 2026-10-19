"""Private indexed bundle reads for the shared browser; no legacy sessions or source reads."""

import hashlib
import json
import mimetypes
import sqlite3
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from cairndex.api.schemas.common import UtcDatetime
from cairndex.domain.enums import GroupingState, MediaKind
from cairndex.filters.ast import FilterExpression
from cairndex.media.image_support import is_openable_media
from cairndex.replicas.catalog.local_history import MODIFIED_SQL, OPENED_SQL, SIZE_SQL
from cairndex.replicas.catalog.query import matching, saved_filter
from cairndex.replicas.protocol import ReplicaError, StrictModel
from cairndex.scanning.media_types import HIDDEN_NAMES, classify
from cairndex.search import to_match_query


class CatalogBundleSummary(StrictModel):
    id: str
    title: str | None
    rating: float | None
    file_count: int
    date_added: UtcDatetime
    total_size: int | None = None
    date_modified: UtcDatetime | None = None
    date_opened: UtcDatetime | None = None
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
    sort: Literal[
        "title",
        "rating",
        "date_added",
        "manual",
        "file_count",
        "size",
        "date_modified",
        "date_opened",
    ] = "title"
    order: Literal["asc", "desc"] = "asc"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


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
        "date_modified": f"julianday({MODIFIED_SQL})",
        "date_opened": f"julianday({OPENED_SQL})",
        "size": SIZE_SQL,
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
    unknown = (
        f"({column}) IS NULL," if request.sort in {"size", "date_opened", "date_modified"} else ""
    )
    return f"{unknown}{column} {request.order},b.entity {tie}", order_args


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


class CatalogDirectoryBundleCount(StrictModel):
    bundle_count: int


def directory_bundles(db: sqlite3.Connection, directory: str) -> list[str]:
    """Bundles with a file in ``directory`` or beneath it, as legacy collected them.

    Staged Unbundled bundles and bundles that browsing hides are left out, so a
    collection never gets members it cannot show. The subtree is a half-open
    range on the indexed parent: every descendant starts with ``directory + "/"``,
    and ``"0"`` is the byte after ``"/"``. The order is stable, by first file.
    """
    from cairndex.core.paths import PathSafetyError, normalize_relative_path

    try:
        directory = normalize_relative_path(directory) if directory.strip("/") else ""
    except PathSafetyError as error:
        raise ReplicaError("Invalid library-relative directory") from error
    if not directory:
        raise ReplicaError("Choose a folder inside the library")
    return [
        row[0]
        for row in db.execute(
            "SELECT b.entity FROM catalog_paths p "
            "JOIN catalog_rows m ON m.family='asset_files' AND m.entity=p.entity "
            "JOIN catalog_rows b ON b.entity=json_extract(m.body,'$.bundle_id') "
            "WHERE p.family='asset_files' AND (p.parent=? OR (p.parent>=? AND p.parent<?)) "
            f"AND {ELIGIBLE} GROUP BY b.entity ORDER BY min(m.entity)",
            (directory, directory + "/", directory + "0"),
        )
    ]


def browse(db: sqlite3.Connection, request: CatalogBrowseRequest) -> CatalogBrowsePage:
    """Search the complete eligible projection before SQL ordering and pagination."""
    where, args = _scope(db, request)
    total = db.execute(f"SELECT count(*) FROM catalog_rows b WHERE {where}", args).fetchone()[0]
    ordering, order_args = _ordering(db, request)
    rows = db.execute(
        f"SELECT b.entity,b.body,{SIZE_SQL} AS total_size,{MODIFIED_SQL} AS date_modified,"
        f"{OPENED_SQL} AS date_opened FROM catalog_rows b WHERE {where} "
        f"ORDER BY {ordering} LIMIT ? OFFSET ?",
        [*args, *order_args, request.limit, request.offset],
    ).fetchall()
    return CatalogBrowsePage(
        items=_summaries(db, rows), total=total, offset=request.offset, limit=request.limit
    )


def bundle_summary(db: sqlite3.Connection, identity: str) -> CatalogBundleSummary:
    """Read one live bundle's complete local summary without browsing or probing media."""
    rows = db.execute(
        f"SELECT b.entity,b.body,{SIZE_SQL} AS total_size,{MODIFIED_SQL} AS date_modified,"
        f"{OPENED_SQL} AS date_opened FROM catalog_rows b "
        "WHERE b.family='asset_bundles' AND b.entity=?",
        (identity,),
    ).fetchall()
    if not rows:
        raise ReplicaError("Bundle is no longer in the catalog")
    return _summaries(db, rows)[0]


def _summaries(db: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[CatalogBundleSummary]:
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
                total_size=row["total_size"],
                date_modified=datetime.fromisoformat(row["date_modified"])
                if row["date_modified"]
                else None,
                date_opened=datetime.fromisoformat(row["date_opened"])
                if row["date_opened"]
                else None,
                grouping_state=GroupingState[value["grouping_state"]],
                cover_file_id=artwork["id"] if artwork else None,
                cover_key=f"{artwork['id']}:{artwork['cover_time']}" if artwork else None,
                **local.get(row["entity"], {}),
            )
        )
    return items


# True when the shared viewer has a stage for this file type, as on the legacy card
def _supported(path: str) -> bool:
    kind = classify(path.rsplit("/", 1)[-1])
    if kind is None or kind[0] not in (MediaKind.IMAGE, MediaKind.VIDEO):
        return False
    return is_openable_media(kind[0], path)


def _media_kind(path: str) -> str | None:
    kind = classify(path.rsplit("/", 1)[-1])
    return str(kind[0]) if kind else None


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
    id: str | None
    bundle_id: str | None
    relative_path: str
    # Browse version 10: the path's media classification, for the shared file list
    media_kind: str | None = None
    local_state: Literal["observed", "unavailable", "unknown"] = "unknown"
    size_bytes: int | None = None
    modified_at: UtcDatetime | None = None


class CatalogUnbundledPage(StrictModel):
    items: list[CatalogUnbundledFile]
    total: int
    offset: int
    limit: int


def unbundled(db: sqlite3.Connection, request: CatalogUnbundledRequest) -> CatalogUnbundledPage:
    """Page staged and privately discovered files without observing source bytes."""
    from cairndex.replicas.catalog.unbundled_sources import QUEUE

    where = (
        "relative_path NOT LIKE '.%' AND relative_path NOT LIKE '%/.%' "
        "AND instr(lower(relative_path),lower(?))>0"
    ) + "".join(
        f" AND instr('/'||relative_path||'/','/{name}/')=0" for name in sorted(HIDDEN_NAMES)
    )
    source = "FROM unbundled_sources WHERE " + where
    total = db.execute(QUEUE + "SELECT count(*) " + source, (request.q,)).fetchone()[0]
    rows = db.execute(
        QUEUE
        + "SELECT id,bundle_id,relative_path "
        + source
        + " ORDER BY lower(relative_path),relative_path,id LIMIT ? OFFSET ?",
        (request.q, request.limit, request.offset),
    )
    return CatalogUnbundledPage(
        items=[
            CatalogUnbundledFile(
                id=row[0], bundle_id=row[1], relative_path=row[2], media_kind=_media_kind(row[2])
            )
            for row in rows
        ],
        total=total,
        offset=request.offset,
        limit=request.limit,
    )
