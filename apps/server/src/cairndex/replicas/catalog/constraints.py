"""Minimal atomic cohorts join lifecycle and placement dependencies without global conflict units"""

import json
import sqlite3
from typing import TYPE_CHECKING

from cairndex.persistence.base import Base
from cairndex.replicas.catalog.model import key, split_key

if TYPE_CHECKING:
    from cairndex.replicas.catalog.store import CatalogStore


# Connect only changes whose joint application is required by a lifetime or ownership transition
def cohorts(
    store: "CatalogStore", db: sqlite3.Connection, rows: list[sqlite3.Row]
) -> list[tuple[set[str], set[str]]]:
    lifetimes: set[str] = set()
    placements: set[str] = set()
    old_owners: dict[str, set[str]] = {}
    new_owners: dict[str, set[str]] = {}
    previous: dict[str, list[str]] = {}
    for row in rows:
        unit = row["unit"]
        family, entity, field = split_key(unit)
        basis = json.loads(row["basis"])
        previous[unit] = [
            db.execute(
                "SELECT value FROM catalog_revisions WHERE unit=? AND event=?", (unit, event)
            ).fetchone()[0]
            for event in basis
        ]
        if field == "$alive" and (
            row["value"] == "false" or not basis or "false" in previous[unit]
        ):
            lifetimes.add(unit)
        if field == "$members":
            for raw in previous[unit]:
                for member in json.loads(raw):
                    old_owners.setdefault(key(member["family"], member["id"], "$alive"), set()).add(
                        entity
                    )
            for member in json.loads(row["value"]):
                target = key(member["family"], member["id"], "$alive")
                new_owners.setdefault(target, set()).add(entity)
    placements.update(
        target
        for target in old_owners.keys() | new_owners.keys()
        if old_owners.get(target, set()) != new_owners.get(target, set())
    )
    linked: dict[str, set[str]] = {}
    for row in rows:
        unit = row["unit"]
        if row["cohort"]:
            linked.setdefault("explicit:" + row["cohort"], set()).add(unit)
        family, entity, field = split_key(unit)
        dependencies = {key(family, entity, "$alive")} if entity != "_" else set()
        for raw in [row["value"], *previous[unit]]:
            dependencies.update(store.required_guards(db, unit, raw))
        column = Base.metadata.tables[family].c.get(field)
        structural = field in ("$members", "$forest", "$span", "$source") or (
            column is not None and bool(column.foreign_keys)
        )
        for dependency in dependencies & (lifetimes | (placements if structural else set())):
            linked.setdefault(dependency, set()).add(unit)
    groups: list[set[str]] = []
    for members in linked.values():
        merged = set(members)
        retained = []
        for group in groups:
            if group & merged:
                merged.update(group)
            else:
                retained.append(group)
        groups = [*retained, merged]
    result = []
    for members in groups:
        anchors = {unit for unit in members if unit.endswith(("/$members", "/$forest"))}
        if not anchors:
            anchors = members & lifetimes or set(members)
        result.append((members, anchors))
    return result
