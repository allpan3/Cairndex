"""Incremental relational catalog projection with indexed references and collision checks"""

import json
import sqlite3
from collections.abc import Iterable
from typing import Any

from sqlalchemy import UniqueConstraint

from cairndex.persistence.base import Base
from cairndex.replicas.catalog.model import (
    PLACEMENT,
    Row,
    entity_id,
    restore_row,
    split_key,
    structural_targets,
    validate_unit,
    value_text,
)
from cairndex.replicas.protocol import ReplicaError

SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog_units (
    unit TEXT PRIMARY KEY, family TEXT NOT NULL, entity TEXT NOT NULL,
    field TEXT NOT NULL, value TEXT);
CREATE INDEX IF NOT EXISTS catalog_unit_entity ON catalog_units(family,entity,field);
CREATE TABLE IF NOT EXISTS catalog_rows (
    family TEXT NOT NULL, entity TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(family,entity));
CREATE TABLE IF NOT EXISTS catalog_placements (
    family TEXT NOT NULL, entity TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(family,entity));
CREATE INDEX IF NOT EXISTS catalog_placement_owner ON catalog_placements(owner,family,entity);
CREATE TABLE IF NOT EXISTS catalog_references (
    source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(source,target));
CREATE INDEX IF NOT EXISTS catalog_reference_target ON catalog_references(target,source);
CREATE TABLE IF NOT EXISTS catalog_unique_values (
    namespace TEXT NOT NULL, value TEXT NOT NULL, owner TEXT NOT NULL,
    PRIMARY KEY(namespace,value));
CREATE INDEX IF NOT EXISTS catalog_unique_owner ON catalog_unique_values(owner);
CREATE TABLE IF NOT EXISTS catalog_paths (
    owner TEXT PRIMARY KEY, path TEXT NOT NULL, parent TEXT NOT NULL,
    family TEXT NOT NULL, entity TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS catalog_path_parent ON catalog_paths(parent,path,owner);
CREATE TABLE IF NOT EXISTS catalog_directories (
    path TEXT PRIMARY KEY, parent TEXT NOT NULL, references_count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS catalog_directory_parent ON catalog_directories(parent,path);
CREATE TABLE IF NOT EXISTS catalog_projected_claims (
    unit TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(unit,target));
CREATE INDEX IF NOT EXISTS catalog_projected_target ON catalog_projected_claims(target,kind,unit);
CREATE TABLE IF NOT EXISTS catalog_claims (
    unit TEXT NOT NULL,event TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,
    PRIMARY KEY(unit,event,target));
CREATE INDEX IF NOT EXISTS catalog_claim_target ON catalog_claims(target,kind,unit,event);
CREATE INDEX IF NOT EXISTS catalog_claim_kind ON catalog_claims(kind,target,unit,event);
CREATE INDEX IF NOT EXISTS catalog_projected_kind ON catalog_projected_claims(kind,target,unit);
"""


# Read one indexed entity without depending on table names supplied by a client
def read_row(db: sqlite3.Connection, family: str, identity: str) -> Row | None:
    found = db.execute(
        "SELECT body FROM catalog_rows WHERE family=? AND entity=?", (family, identity)
    ).fetchone()
    return json.loads(found[0]) if found else None


# Every scalar foreign key and composite edge contributes a reverse-reference index
def references(family: str, row: Row) -> set[str]:
    result = set()
    for column in Base.metadata.tables[family].columns:
        for foreign in column.foreign_keys:
            target = row[column.name]
            if target is not None:
                result.add(f"{foreign.column.table.name}/{target}")
    return result


# Structural placement is an atomic replacement, including both ends of a transfer
def place(db: sqlite3.Connection, units: Iterable[str]) -> set[tuple[str, str]]:
    touched: set[tuple[str, str]] = set()
    arrangements: list[tuple[str, str, str, Any]] = []
    for unit in units:
        family, identity, field = split_key(unit)
        if field not in ("$members", "$forest"):
            continue
        value = db.execute("SELECT value FROM catalog_units WHERE unit=?", (unit,)).fetchone()[0]
        if value is None:
            continue
        arrangements.append((unit, family, identity, validate_unit(unit, value)))
        touched.update(
            (row[0], row[1])
            for row in db.execute(
                "SELECT family,entity FROM catalog_placements WHERE owner=?", (unit,)
            )
        )
        db.execute("DELETE FROM catalog_placements WHERE owner=?", (unit,))
    for unit, family, identity, value in arrangements:
        for item in value:
            target_family = item["family"] if family == "asset_bundles" else family
            target = item["id"]
            placement = {
                column: item[column] for column in PLACEMENT[target_family] if column != "bundle_id"
            }
            if family == "asset_bundles":
                placement["bundle_id"] = identity
            if db.execute(
                "SELECT 1 FROM catalog_placements WHERE family=? AND entity=?",
                (target_family, target),
            ).fetchone():
                raise ReplicaError("Conflicting complete membership arrangements")
            db.execute(
                "INSERT INTO catalog_placements VALUES (?, ?, ?, ?)",
                (target_family, target, unit, value_text(placement)),
            )
            touched.add((target_family, target))
    return touched


# Rebuild only directly affected rows; unresolved creations remain absent until complete
def rebuild(db: sqlite3.Connection, entities: Iterable[tuple[str, str]]) -> set[str]:
    touched: set[str] = set()
    for family, identity in entities:
        if identity == "_":
            continue
        owner = f"{family}/{identity}"
        values = {
            row[0]: row[1]
            for row in db.execute(
                "SELECT field,value FROM catalog_units WHERE family=? AND entity=?",
                (family, identity),
            )
        }
        if not values or any(value is None for value in values.values()):
            raise ReplicaError("Catalog entity is incomplete")
        placement = db.execute(
            "SELECT body FROM catalog_placements WHERE family=? AND entity=?", (family, identity)
        ).fetchone()
        row = restore_row(family, identity, values, json.loads(placement[0]) if placement else {})
        db.execute("DELETE FROM catalog_references WHERE source=?", (owner,))
        db.execute("DELETE FROM catalog_unique_values WHERE owner=?", (owner,))
        db.execute("DELETE FROM catalog_rows WHERE family=? AND entity=?", (family, identity))
        index_path(db, family, identity, row)
        if row is not None:
            db.execute(
                "INSERT INTO catalog_rows VALUES (?, ?, ?)", (family, identity, value_text(row))
            )
            db.executemany(
                "INSERT INTO catalog_references VALUES (?, ?)",
                ((owner, target) for target in references(family, row)),
            )
        touched.add(owner)
    return touched


# Incremental directory counts support root-scoped browsing without a request-time catalog scan
def index_path(db: sqlite3.Connection, family: str, identity: str, row: Row | None) -> None:
    if family not in ("asset_files", "bundle_directory_members"):
        return
    owner = f"{family}/{identity}"
    previous = db.execute("SELECT path FROM catalog_paths WHERE owner=?", (owner,)).fetchone()
    for value, delta in (
        (previous[0] if previous else None, -1),
        (row["relative_path" if family == "asset_files" else "directory_path"] if row else None, 1),
    ):
        if value is None:
            continue
        path = value if family == "bundle_directory_members" else value.rpartition("/")[0]
        while path:
            parent = path.rpartition("/")[0]
            if delta == 1:
                db.execute(
                    "INSERT INTO catalog_directories VALUES (?, ?, 1) ON CONFLICT(path) "
                    "DO UPDATE SET references_count=references_count+1",
                    (path, parent),
                )
            else:
                db.execute(
                    "UPDATE catalog_directories SET references_count=references_count-1 "
                    "WHERE path=?",
                    (path,),
                )
                db.execute(
                    "DELETE FROM catalog_directories WHERE path=? AND references_count=0", (path,)
                )
            path = parent
    db.execute("DELETE FROM catalog_paths WHERE owner=?", (owner,))
    if row:
        path = row["relative_path" if family == "asset_files" else "directory_path"]
        db.execute(
            "INSERT INTO catalog_paths VALUES (?, ?, ?, ?, ?)",
            (owner, path, path.rpartition("/")[0], family, identity),
        )


# Validate references and domain relationships after the complete operation is staged
def validate_rows(db: sqlite3.Connection, owners: Iterable[str]) -> None:
    for owner in owners:
        family, identity = owner.split("/", 1)
        row = read_row(db, family, identity)
        if row is None:
            if db.execute(
                "SELECT 1 FROM catalog_references WHERE target=? LIMIT 1", (owner,)
            ).fetchone():
                raise ReplicaError("Deletion requires an explicit complete reference cascade")
            continue
        for target in references(family, row):
            target_family, target_id = target.split("/", 1)
            if read_row(db, target_family, target_id) is None:
                raise ReplicaError("Catalog relationship has a missing or deleted target")
        if family == "asset_bundles":
            for field in ("cover_file_id", "primary_file_id"):
                if row[field] and _required(db, "asset_files", row[field])["bundle_id"] != identity:
                    raise ReplicaError("Cover and primary file must belong to the bundle")
        if family in ("moments", "subtitle_tracks"):
            for column in ("file_id", "video_file_id", "source_file_id"):
                if row.get(column) and (
                    _required(db, "asset_files", row[column])["bundle_id"] != row["bundle_id"]
                ):
                    raise ReplicaError("Moment or subtitle source belongs to a different bundle")
        if family == "collections" and row["cover_bundle_id"]:
            validate_collection_cover(db, identity, row["cover_bundle_id"])
        if family in PLACEMENT:
            placement = db.execute(
                "SELECT body FROM catalog_placements WHERE family=? AND entity=?",
                (family, identity),
            ).fetchone()
            if not placement:
                raise ReplicaError("Live catalog entity is missing its complete placement")
        _unique(db, family, row)


# Covers must belong directly or through descendants to their collection's current tree
def validate_collection_cover(db: sqlite3.Connection, collection: str, bundle: str) -> None:
    for (source,) in db.execute(
        "SELECT source FROM catalog_references WHERE target=?", (f"asset_bundles/{bundle}",)
    ):
        family, identity = source.split("/", 1)
        if family != "asset_bundle_collections":
            continue
        member = _required(db, family, identity)
        parent = member["collection_id"]
        while parent is not None:
            if parent == collection:
                return
            parent = _required(db, "collections", parent)["parent_id"]
    raise ReplicaError("Collection cover must belong to its collection tree")


# Read a required relationship after existence validation without silent fallback values
def _required(db: sqlite3.Connection, family: str, identity: str) -> Row:
    row = read_row(db, family, identity)
    if row is None:
        raise ReplicaError("Catalog reference is unavailable")
    return row


# SQLite-style unique keys retain NULL semantics and expose same-path identity collisions
def _unique(db: sqlite3.Connection, family: str, row: Row) -> None:
    owner = f"{family}/{entity_id(family, row)}"
    for constraint in Base.metadata.tables[family].constraints:
        if not isinstance(constraint, UniqueConstraint):
            continue
        columns = tuple(column.name for column in constraint.columns)
        values = [row[column] for column in columns]
        if None in values:
            continue
        namespace, value = f"{family}/{'~'.join(columns)}", value_text(values)
        prior = db.execute(
            "SELECT owner FROM catalog_unique_values WHERE namespace=? AND value=?",
            (namespace, value),
        ).fetchone()
        if prior and prior[0] != owner:
            raise ReplicaError("Catalog identity or name collision requires an explicit choice")
        db.execute(
            "INSERT OR IGNORE INTO catalog_unique_values VALUES (?, ?, ?)",
            (namespace, value, owner),
        )


# Seed reconstruction streams entities; ordinary projection touches only indexed dependencies
def project(db: sqlite3.Connection, units: set[str]) -> None:
    entities = {split_key(unit)[:2] for unit in units}
    entities.update(place(db, units))
    owners = rebuild(db, entities)
    dependent = set(owners)
    # Removing an edge can invalidate a cover on any ancestor, even after the edge is gone
    for family, identity in entities:
        if family == "asset_bundle_collections":
            bundle = identity.split("~", 1)[0]
            dependent.update(
                source
                for (source,) in db.execute(
                    "SELECT source FROM catalog_references WHERE target=?",
                    (f"asset_bundles/{bundle}",),
                )
                if source.startswith("collections/")
            )
    for owner in owners:
        dependent.update(
            row[0]
            for row in db.execute("SELECT source FROM catalog_references WHERE target=?", (owner,))
        )
    validate_rows(db, dependent)
    for unit in units:
        index_projected_claims(db, unit)
    for family, identity in entities:
        if identity != "_" and family in PLACEMENT:
            placement = db.execute(
                "SELECT owner FROM catalog_placements WHERE family=? AND entity=?",
                (family, identity),
            ).fetchone()
            if placement and read_row(db, family, identity) is None:
                raise ReplicaError("Complete arrangement references a deleted entity")


# Complete seeds stream rows through disk-backed indexes instead of retaining the catalog in RAM
def project_seed(db: sqlite3.Connection) -> None:
    for (unit,) in db.execute("SELECT unit FROM catalog_units"):
        index_projected_claims(db, unit)
    for (unit,) in db.execute(
        "SELECT unit FROM catalog_units WHERE field IN ('$members','$forest')"
    ):
        place(db, [unit])
    for family, entity in db.execute(
        "SELECT DISTINCT family,entity FROM catalog_units WHERE entity<>'_'"
    ):
        rebuild(db, [(family, entity)])
    for family, entity in db.execute("SELECT family,entity FROM catalog_rows"):
        validate_rows(db, [f"{family}/{entity}"])
    for family, entity in db.execute("SELECT family,entity FROM catalog_placements"):
        if read_row(db, family, entity) is None:
            raise ReplicaError("Complete seed arrangement has a missing entity")


# Projected claims retain dependencies of a valid local view while candidates remain unresolved
def index_projected_claims(db: sqlite3.Connection, unit: str) -> None:
    db.execute("DELETE FROM catalog_projected_claims WHERE unit=?", (unit,))
    row = db.execute("SELECT value FROM catalog_units WHERE unit=?", (unit,)).fetchone()
    if row and row[0] is not None:
        db.executemany(
            "INSERT INTO catalog_projected_claims VALUES (?, ?, ?)",
            ((unit, target, kind) for target, kind in structural_targets(unit, row[0])),
        )


# Compare a pinned legacy schema against every modeled and archived column before conversion
def validate_inventory(db: sqlite3.Connection, schema: str = "main") -> None:
    from cairndex.replicas.inventory import INVENTORY

    if schema not in ("main", "plans"):
        raise ReplicaError("Unknown conversion schema")
    expected = {
        name.removeprefix("plans."): spec
        for name, spec in INVENTORY.items()
        if name.startswith("plans.") == (schema == "plans")
    }
    if db.execute(
        f"SELECT 1 FROM {schema}.sqlite_master WHERE type IN ('trigger','view') LIMIT 1"
    ).fetchone():
        raise ReplicaError("Unknown schema extension blocks conversion")
    actual = {
        row[0]
        for row in db.execute(
            f"SELECT name FROM {schema}.sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    if actual != set(expected):
        raise ReplicaError("Unknown or missing durable table blocks conversion")
    for name, spec in expected.items():
        columns = {column for category in spec.values() for column in category.split()}
        actual_columns = {row[1] for row in db.execute(f'PRAGMA {schema}.table_info("{name}")')}
        if actual_columns != columns:
            raise ReplicaError("Unknown or missing durable column blocks conversion")
