"""Bounded inspector choices over authored rows; source observations stay separate."""

import json
import sqlite3
from typing import TYPE_CHECKING, Any, Literal

from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError, StrictModel

if TYPE_CHECKING:
    from cairndex.replicas.catalog.store import CatalogStore

MembershipFamily = Literal["tags", "collections"]
EDGES = {"tags": "asset_bundle_tags", "collections": "asset_bundle_collections"}


class CatalogMembershipChoice(StrictModel):
    id: str
    name: str
    parent_id: str | None
    path: list[str]
    assigned: bool
    observed: dict[str, list[str]]
    held: bool


class CatalogMembershipPage(StrictModel):
    items: list[CatalogMembershipChoice]
    next_cursor: str | None


def memberships(
    store: "CatalogStore",
    bundle: str,
    family: MembershipFamily,
    after: str,
    limit: int,
    search: str,
    assigned: bool,
) -> CatalogMembershipPage:
    """Search all destinations before pagination, with exact edge and lifetime bases."""
    with store.connection(readonly=True) as db:
        if read_row(db, "asset_bundles", bundle) is None:
            raise ReplicaError("Bundle is unavailable")
        edge = EDGES[family]
        rows = db.execute(
            "SELECT c.entity,c.body FROM catalog_rows c WHERE c.family=? AND c.entity>? "
            "AND instr(lower(json_extract(c.body,'$.name')),lower(?))>0 "
            "AND (?=0 OR EXISTS (SELECT 1 FROM catalog_rows e WHERE e.family=? "
            "AND e.entity=? || '~' || c.entity)) ORDER BY c.entity LIMIT ?",
            (family, after, search, int(assigned), edge, bundle, limit + 1),
        ).fetchall()
        items = []
        for row in rows[:limit]:
            body = json.loads(row["body"])
            ancestors = db.execute(
                "WITH RECURSIVE parents(id,body,depth) AS ("
                "SELECT entity,body,0 FROM catalog_rows WHERE family=? AND entity=? UNION ALL "
                "SELECT c.entity,c.body,p.depth+1 FROM parents p JOIN catalog_rows c "
                "ON c.family=? AND c.entity=json_extract(p.body,'$.parent_id')) "
                "SELECT json_extract(body,'$.name') FROM parents ORDER BY depth DESC",
                (family, row["entity"], family),
            ).fetchall()
            units = [
                key("asset_bundles", bundle, "$alive"),
                key(family, row["entity"], "$alive"),
                key(edge, f"{bundle}~{row['entity']}", "$alive"),
            ]
            observed = {unit: [tip["event"] for tip in store.tips(db, unit)] for unit in units}
            held = any(
                db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone()
                for unit in units
            )
            items.append(
                CatalogMembershipChoice(
                    id=row["entity"],
                    name=body["name"],
                    parent_id=body["parent_id"],
                    path=[ancestor[0] for ancestor in ancestors],
                    assigned=read_row(db, edge, f"{bundle}~{row['entity']}") is not None,
                    observed=observed,
                    held=held,
                )
            )
        return CatalogMembershipPage(
            items=items, next_cursor=rows[limit - 1]["entity"] if len(rows) > limit else None
        )


def cover(db: sqlite3.Connection, bundle: str) -> dict[str, Any] | None:
    """Resolve authored artwork with image-before-video fallback, without reading bytes."""
    row = read_row(db, "asset_bundles", bundle)
    if row is None:
        raise ReplicaError("Bundle is unavailable")
    selected = row["cover_file_id"]
    if selected:
        file = read_row(db, "asset_files", selected)
        if file and file["bundle_id"] == bundle:
            return file
    # Media roles are authored; no full-library or filesystem scan is needed.
    found = db.execute(
        "SELECT body FROM catalog_rows WHERE family='asset_files' "
        "AND json_extract(body,'$.bundle_id')=? "
        "AND json_extract(body,'$.role') IN ('IMAGE','VIDEO_PART','PRIMARY_VIDEO') "
        "ORDER BY CASE json_extract(body,'$.role') WHEN 'IMAGE' THEN 0 ELSE 1 END, "
        "CAST(json_extract(body,'$.sequence') AS INTEGER),entity LIMIT 1",
        (bundle,),
    ).fetchone()
    return json.loads(found[0]) if found else None
