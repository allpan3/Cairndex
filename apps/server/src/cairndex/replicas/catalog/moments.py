"""A bundle's moments in the order the viewer and the inspector list them"""

import json
import sqlite3
from typing import Any

from pydantic import BaseModel

from cairndex.api.schemas.moments import MomentRead


class CatalogMomentPage(BaseModel):
    items: list[MomentRead]
    next_offset: int | None
    # Names of the tags on these moments, so a row can show them without a second request
    tag_names: dict[str, str]


# Start time orders the list, and the stable identity breaks ties between equal starts
def bundle_moments(
    db: sqlite3.Connection, bundle_id: str, offset: int, limit: int
) -> CatalogMomentPage:
    rows = db.execute(
        "SELECT c.entity, c.body FROM catalog_references r JOIN catalog_rows c "
        "ON r.source=c.family || '/' || c.entity WHERE r.target=? AND c.family='moments' "
        "ORDER BY json_extract(c.body,'$.start_s'), c.entity LIMIT ? OFFSET ?",
        (f"asset_bundles/{bundle_id}", limit + 1, offset),
    ).fetchall()
    items = []
    names: dict[str, str] = {}
    for identity, body in rows[:limit]:
        row: dict[str, Any] = json.loads(body)
        tags = db.execute(
            "SELECT json_extract(c.body,'$.tag_id'),json_extract(t.body,'$.name') "
            "FROM catalog_references r JOIN catalog_rows c ON r.source=c.family || '/' || c.entity "
            "JOIN catalog_rows t ON t.family='tags' AND t.entity=json_extract(c.body,'$.tag_id') "
            "WHERE r.target=? AND c.family='moment_tags' ORDER BY 2, 1",
            (f"moments/{identity}",),
        ).fetchall()
        row["tag_ids"] = [tag for tag, _ in tags]
        names.update({tag: name for tag, name in tags})
        items.append(MomentRead.model_validate(row))
    return CatalogMomentPage(
        items=items, next_offset=offset + limit if len(rows) > limit else None, tag_names=names
    )
