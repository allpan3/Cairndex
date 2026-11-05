"""Paged navigation and complete-population counts over the valid local projection."""

import json
import sqlite3
from typing import Any, Literal

from pydantic import Field

from cairndex.filters.ast import FilterExpression
from cairndex.replicas.catalog.browse import (
    CatalogBrowseRequest,
    CatalogUnbundledRequest,
    browse_population,
    browse_total,
    unbundled,
)
from cairndex.replicas.protocol import StrictModel

NavigationFamily = Literal[
    "collections", "tags", "tag_groups", "tag_group_memberships", "smart_folders"
]


class CatalogNavigationPage(StrictModel):
    items: list[dict[str, Any]]
    next_cursor: str | None


def navigation(
    db: sqlite3.Connection, family: NavigationFamily, after: str, limit: int
) -> CatalogNavigationPage:
    rows = db.execute(
        "SELECT entity,body FROM catalog_rows WHERE family=? AND entity>? ORDER BY entity LIMIT ?",
        (family, after, limit + 1),
    ).fetchall()
    page = rows[:limit]
    if family in ("collections", "tags"):
        roots = [row["entity"] for row in page]
        counts = member_counts(db, family, roots, descendants=True)
        # Browse version 10: the sidebar shows the count that opening the
        # collection lists, which is only its own bundles until "Show
        # subcollection contents" is on
        direct = (
            member_counts(db, family, roots, descendants=False) if family == "collections" else {}
        )
    items = []
    for row in page:
        item = json.loads(row["body"])
        if family in ("collections", "tags"):
            item["count"] = counts[row["entity"]]
        if family == "collections":
            item["direct_count"] = direct[row["entity"]]
        if family == "smart_folders":
            item["filter"] = json.loads(item["filter_json"])
        items.append(item)
    return CatalogNavigationPage(
        items=items, next_cursor=rows[limit - 1]["entity"] if len(rows) > limit else None
    )


# The membership edges of each counted family, and the column naming the destination
MEMBERS = {
    "tags": ("asset_bundle_tags", "tag_id"),
    "collections": ("asset_bundle_collections", "collection_id"),
}


def member_counts(
    db: sqlite3.Connection,
    family: Literal["tags", "collections"],
    roots: list[str],
    *,
    descendants: bool,
    scope: CatalogBrowseRequest | None = None,
) -> dict[str, int]:
    """How many bundles of `scope` each root holds, for a page of roots in one query.

    Each count is what a browse of `scope` filtered by `contains_any [root]` totals,
    with `include_descendants` as given. Counting row by row compiled that filter
    once per tag and twice per collection; on a library of a few thousand bundles a
    page of 50 collections took seconds, and the sidebar reads every page every 2 s.
    """
    if not roots:
        return {}
    edge, member = MEMBERS[family]
    children: dict[str, list[str]] = {}
    if descendants:
        for identity, parent in db.execute(
            f"SELECT entity,json_extract(body,'$.parent_id') FROM catalog_rows "
            f"WHERE family='{family}'"
        ):
            if parent is not None:
                children.setdefault(parent, []).append(identity)
    # Each root with itself and, with descendants, its subtree; `seen` ends a parent
    # cycle as the filter's own descendant walk does
    pairs: list[list[str]] = []
    for root in roots:
        seen, stack = {root}, [root]
        while stack:
            for child in children.get(stack.pop(), []):
                if child not in seen:
                    seen.add(child)
                    stack.append(child)
        pairs.extend([root, identity] for identity in seen)
    population, args = browse_population(db, scope or CatalogBrowseRequest())
    # CROSS JOIN keeps the pairs outer, so each is one lookup in the partial index on
    # the edges' destination; the family literals are fixed names so that index applies
    rows = db.execute(
        "WITH tree(root,id) AS (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') "
        "FROM json_each(?)) "
        "SELECT tree.root,count(DISTINCT json_extract(e.body,'$.bundle_id')) FROM tree "
        f"CROSS JOIN catalog_rows e ON e.family='{edge}' "
        f"AND json_extract(e.body,'$.{member}')=tree.id "
        f"WHERE json_extract(e.body,'$.bundle_id') IN ({population}) GROUP BY tree.root",
        [json.dumps(pairs), *args],
    ).fetchall()
    counts = dict.fromkeys(roots, 0)
    counts.update({row[0]: row[1] for row in rows})
    return counts


class CatalogViewCounts(StrictModel):
    all: int
    recent: int
    uncategorized: int
    untagged: int
    missing: int
    unbundled: int


def view_counts(db: sqlite3.Connection) -> CatalogViewCounts:
    """Browse version 10: the sidebar's system-view counts, from one snapshot."""

    def total(view: Literal["all", "uncategorized", "untagged", "missing"]) -> int:
        return browse_total(db, CatalogBrowseRequest(view=view))

    everything = total("all")
    return CatalogViewCounts(
        all=everything,
        # Recent lists every bundle, newest first
        recent=everything,
        uncategorized=total("uncategorized"),
        untagged=total("untagged"),
        missing=total("missing"),
        unbundled=unbundled(db, CatalogUnbundledRequest(limit=1)).total,
    )


class CatalogFacetRequest(CatalogBrowseRequest):
    facets: list[Literal["tags", "ratings"]] = ["tags", "ratings"]
    tag_include_descendants: bool = True


class CatalogFacetResponse(StrictModel):
    tags: dict[str, int] = Field(default_factory=dict)
    ratings: dict[str, int] = Field(default_factory=dict)


def facets(db: sqlite3.Connection, request: CatalogFacetRequest) -> CatalogFacetResponse:
    result = CatalogFacetResponse()
    base = request.model_dump(exclude={"facets", "tag_include_descendants"})

    def count(node: dict[str, Any]) -> int:
        root = request.filter.root.model_dump() if request.filter and request.filter.root else None
        expression = FilterExpression.model_validate(
            {
                "root": {
                    "op": "and",
                    "children": [root, node] if root else [node],
                }
            }
        )
        return browse_total(db, CatalogBrowseRequest(**{**base, "filter": expression}))

    if "tags" in request.facets:
        tags = [
            row[0]
            for row in db.execute(
                "SELECT entity FROM catalog_rows WHERE family='tags' ORDER BY entity"
            )
        ]
        result.tags = member_counts(
            db,
            "tags",
            tags,
            descendants=request.tag_include_descendants,
            scope=CatalogBrowseRequest(**base),
        )
    if "ratings" in request.facets:
        for step in range(11):
            value = step / 2
            result.ratings[str(value).removesuffix(".0")] = count(
                {"field": "rating", "operator": "eq", "value": value}
            )
        result.ratings["unrated"] = count({"field": "rating", "operator": "is_null", "value": True})
    return result
