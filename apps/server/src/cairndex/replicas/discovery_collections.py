"""Reviewed collection ancestors and logical placement over the existing catalog forest"""

import json
from typing import Any

from cairndex.replicas.catalog.model import key
from cairndex.replicas.discovery_preview import DiscoveryPreview
from cairndex.replicas.discovery_sources import stable_id
from cairndex.replicas.protocol import ReplicaError


# A selected existing destination pins its name, lifetime and original hierarchy before grouping
def existing(builder: DiscoveryPreview, identity: str) -> None:
    builder.forest()
    if not builder.db.execute(
        "SELECT 1 FROM discovery_review_forest WHERE operation=? AND id=?",
        (builder.operation, identity),
    ).fetchone():
        raise ReplicaError("The selected collection is unavailable; review its current hierarchy")
    for field in ("name", "$alive"):
        builder.get(key("collections", identity, field))


# Reuse an exact sibling name or stage a deterministic new collection without changing source paths
def ensure(builder: DiscoveryPreview, name: str, parent: str | None, stamp: str) -> str:
    from cairndex.replicas.discovery_review import defaults

    if not name.strip() or len(name) > 255:
        raise ReplicaError("A collection name is required")
    builder.forest()
    row = builder.db.execute(
        "SELECT f.id FROM discovery_review_forest f LEFT JOIN discovery_review_values v "
        "ON v.operation=f.operation AND v.unit='collections/'||f.id||'/name' "
        "LEFT JOIN catalog_units c ON c.unit='collections/'||f.id||'/name' "
        "WHERE f.operation=? AND json_extract(f.body,'$.parent_id') IS ? "
        "AND json_extract(COALESCE(v.value,c.value),'$')=? LIMIT 1",
        (builder.operation, parent, name),
    ).fetchone()
    if row:
        identity = str(row[0])
        builder.get(key("collections", identity, "name"))
        builder.get(key("collections", identity, "$alive"))
        return identity
    identity = stable_id(
        [
            "collection",
            builder.store.descriptor.library_uuid,
            builder.store.descriptor.epoch,
            parent,
            name,
        ]
    )
    order = builder.db.execute(
        "SELECT COALESCE(MAX(json_extract(body,'$.sort_order')),-1)+1 "
        "FROM discovery_review_forest WHERE operation=? AND json_extract(body,'$.parent_id') IS ?",
        (builder.operation, parent),
    ).fetchone()[0]
    builder.create(
        "collections",
        defaults(
            "collections",
            id=identity,
            name=name,
            parent_id=parent,
            sort_order=order,
            created_at=stamp,
            updated_at=stamp,
        ),
    )
    return identity


# Descendants carry required ancestors; an explicit destination places the chosen subtree beneath it
def place(
    builder: DiscoveryPreview,
    group: dict[str, Any],
    intent: dict[str, Any],
    candidate: dict[str, Any],
    bundle: str,
    stamp: str,
) -> list[str]:
    from cairndex.replicas.discovery_review import defaults

    # Additions preserve settled collection membership unless the owner explicitly chooses placement
    if group["target"] and not intent.get("collection"):
        return []
    ancestors = group["ancestors"]
    parent = intent.get("collection")
    if parent:
        existing(builder, parent)
        ancestors = [
            node
            for node in ancestors
            if candidate["kind"] == "collection"
            and (
                node["directory"] == candidate["directory"]
                or node["directory"].startswith(candidate["directory"] + "/")
            )
        ]
    if (
        ancestors
        and builder.db.execute(
            "SELECT 1 FROM catalog_holds WHERE unit='collections/_/$forest'"
        ).fetchone()
    ):
        raise ReplicaError("Resolve the current collection hierarchy before preparing grouping")
    for node in ancestors:
        name = (
            intent.get("title", node["title"])
            if candidate["kind"] == "collection" and node["directory"] == candidate["directory"]
            else node["title"]
        )
        parent = ensure(builder, name, parent, stamp)
    if parent is None:
        return []
    placement = []
    current = parent
    while current:
        placement.append(builder.get(key("collections", current, "name")))
        forest_row = builder.db.execute(
            "SELECT body FROM discovery_review_forest WHERE operation=? AND id=?",
            (builder.operation, current),
        ).fetchone()
        current = json.loads(forest_row[0])["parent_id"]
    placement.reverse()
    identity = bundle + "~" + parent
    unit = key("asset_bundle_collections", identity, "$alive")
    if (
        unit in builder.values
        or builder.db.execute(
            "SELECT 1 FROM catalog_units WHERE unit=? AND value='true'",
            (unit,),
        ).fetchone()
    ):
        return placement
    builder.create(
        "asset_bundle_collections",
        defaults(
            "asset_bundle_collections",
            bundle_id=bundle,
            collection_id=parent,
        ),
    )
    return placement
