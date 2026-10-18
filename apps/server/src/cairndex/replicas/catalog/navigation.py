"""Paged navigation and complete-population counts over the valid local projection."""

import json
import sqlite3
from typing import Any, Literal

from pydantic import Field

from cairndex.filters.ast import FilterExpression
from cairndex.replicas.catalog.browse import (
    CatalogBrowseRequest,
    CatalogUnbundledRequest,
    browse,
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
    items = []
    for row in rows[:limit]:
        item = json.loads(row["body"])
        if family in ("collections", "tags"):
            item["count"] = _count(db, family, row["entity"], descendants=True)
        if family == "collections":
            # Browse version 10: the sidebar shows the count that opening the
            # collection lists, which is only its own bundles until "Show
            # subcollection contents" is on
            item["direct_count"] = _count(db, family, row["entity"], descendants=False)
        if family == "smart_folders":
            item["filter"] = json.loads(item["filter_json"])
        items.append(item)
    return CatalogNavigationPage(
        items=items, next_cursor=rows[limit - 1]["entity"] if len(rows) > limit else None
    )


def _count(db: sqlite3.Connection, family: str, identity: str, *, descendants: bool) -> int:
    expression = FilterExpression.model_validate(
        {
            "root": {
                "field": family,
                "operator": "contains_any",
                "value": [identity],
                "include_descendants": descendants,
            },
        }
    )
    return browse(db, CatalogBrowseRequest(filter=expression, limit=1)).total


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
        return browse(db, CatalogBrowseRequest(view=view, limit=1)).total

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
        return browse(db, CatalogBrowseRequest(**{**base, "filter": expression, "limit": 1})).total

    if "tags" in request.facets:
        for row in db.execute(
            "SELECT entity FROM catalog_rows WHERE family='tags' ORDER BY entity"
        ):
            result.tags[row[0]] = count(
                {
                    "field": "tags",
                    "operator": "contains_any",
                    "value": [row[0]],
                    "include_descendants": request.tag_include_descendants,
                }
            )
    if "ratings" in request.facets:
        for step in range(11):
            value = step / 2
            result.ratings[str(value).removesuffix(".0")] = count(
                {"field": "rating", "operator": "eq", "value": value}
            )
        result.ratings["unrated"] = count({"field": "rating", "operator": "is_null", "value": True})
    return result
