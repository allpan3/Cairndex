"""Persistent reviewed catalog values with frozen bases and disk-backed arrangements"""

import json
import sqlite3
from collections.abc import Iterator, MutableMapping
from typing import Any

from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import AUTHORED, entity_id, key, value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError

SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_review_work (
    operation TEXT PRIMARY KEY REFERENCES discovery_reviews(id), phase TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0, parents TEXT NOT NULL, total INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, header TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_review_files (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), position INTEGER NOT NULL,
    group_id TEXT NOT NULL, original TEXT NOT NULL, body TEXT, sort_order INTEGER NOT NULL,
    PRIMARY KEY(operation,position));
CREATE INDEX IF NOT EXISTS discovery_review_file_group ON
discovery_review_files(operation,group_id,position);
CREATE INDEX IF NOT EXISTS discovery_review_file_order ON
discovery_review_files(operation,sort_order,position);
CREATE TABLE IF NOT EXISTS discovery_review_groups (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), id TEXT NOT NULL,
    body TEXT NOT NULL, target TEXT, state TEXT NOT NULL DEFAULT 'queued',
    cursor INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY(operation,id));
CREATE TABLE IF NOT EXISTS discovery_review_values (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), unit TEXT NOT NULL,
    value TEXT NOT NULL, basis TEXT NOT NULL, cohort TEXT,
    PRIMARY KEY(operation,unit));
CREATE TABLE IF NOT EXISTS discovery_review_members (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), bundle TEXT NOT NULL,
    family TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY(operation,bundle,family,id));
CREATE TABLE IF NOT EXISTS discovery_review_forest (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(operation,id));
CREATE TABLE IF NOT EXISTS discovery_review_arrangements (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), unit TEXT NOT NULL,
    PRIMARY KEY(operation,unit));
CREATE TABLE IF NOT EXISTS discovery_review_parts (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), sequence INTEGER NOT NULL,
    id TEXT NOT NULL, raw BLOB NOT NULL, PRIMARY KEY(operation,sequence));
CREATE TABLE IF NOT EXISTS discovery_review_done (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), position INTEGER NOT NULL,
    PRIMARY KEY(operation,position));
CREATE TABLE IF NOT EXISTS discovery_review_commit (
    operation TEXT PRIMARY KEY REFERENCES discovery_reviews(id), intent TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_accepted_files (
    path TEXT NOT NULL, generation TEXT NOT NULL, file_id TEXT NOT NULL, event TEXT NOT NULL,
    PRIMARY KEY(path,generation));
"""
TABLES = {
    "discovery_review_work",
    "discovery_review_files",
    "discovery_review_file_group",
    "discovery_review_file_order",
    "discovery_review_groups",
    "discovery_review_values",
    "discovery_review_members",
    "discovery_review_forest",
    "discovery_review_parts",
    "discovery_review_arrangements",
    "discovery_review_done",
    "discovery_review_commit",
    "discovery_accepted_files",
}


# Values freeze their first observed basis; later worker batches only update the private value
class Values(MutableMapping[str, str]):
    # Keep the operation key with the current worker transaction
    def __init__(self, store: CatalogStore, db: sqlite3.Connection, operation: str) -> None:
        self.store, self.db, self.operation = store, db, operation

    # A mapping read returns one complete authored unit rather than the whole review
    def __getitem__(self, unit: str) -> str:
        row = self.db.execute(
            "SELECT value FROM discovery_review_values WHERE operation=? AND unit=?",
            (self.operation, unit),
        ).fetchone()
        if row is None:
            raise KeyError(unit)
        return str(row[0])

    # First use must still belong to the review's opening frontier, never a later received edit
    def __setitem__(self, unit: str, raw: str) -> None:
        prior = self.db.execute(
            "SELECT 1 FROM discovery_review_values WHERE operation=? AND unit=?",
            (self.operation, unit),
        ).fetchone()
        if prior:
            self.db.execute(
                "UPDATE discovery_review_values SET value=? WHERE operation=? AND unit=?",
                (raw, self.operation, unit),
            )
            return
        if self.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone():
            raise ReplicaError("Resolve the current catalog choice before preparing this grouping")
        basis = [tip["event"] for tip in self.store.tips(self.db, unit)]
        parents = self.db.execute(
            "SELECT parents FROM discovery_review_work WHERE operation=?",
            (self.operation,),
        ).fetchone()[0]
        for event in basis:
            if not self.db.execute(
                "WITH RECURSIVE observed(event) AS (SELECT value FROM json_each(?) UNION "
                "SELECT p.parent FROM catalog_parents p JOIN observed a ON p.child=a.event) "
                "SELECT 1 FROM observed WHERE event=?",
                (parents, event),
            ).fetchone():
                raise ReplicaError(
                    "Catalog choices changed during preparation; the original review is retained"
                )
        self.db.execute(
            "INSERT INTO discovery_review_values VALUES (?,?,?,?, 'domain')",
            (self.operation, unit, raw, value_text(basis)),
        )

    # Mapping deletion is used only for an explicitly abandoned private staged value
    def __delitem__(self, unit: str) -> None:
        self.db.execute(
            "DELETE FROM discovery_review_values WHERE operation=? AND unit=?",
            (self.operation, unit),
        )

    # Iteration remains cursor-backed even for a review with many authored records
    def __iter__(self) -> Iterator[str]:
        return (
            row[0]
            for row in self.db.execute(
                "SELECT unit FROM discovery_review_values WHERE operation=? ORDER BY unit",
                (self.operation,),
            )
        )

    # Counts use the operation index and do not materialize values
    def __len__(self) -> int:
        return int(
            self.db.execute(
                "SELECT COUNT(*) FROM discovery_review_values WHERE operation=?", (self.operation,)
            ).fetchone()[0]
        )


# The existing authored row model is preserved while membership assembly spills to private tables
class DiscoveryPreview(Preview):
    # Resume staged values without recapturing their original causal bases
    def __init__(self, store: CatalogStore, db: sqlite3.Connection, operation: str) -> None:
        self.store, self.db, self.operation = store, db, operation
        self.values = Values(store, db, operation)

    # Reads pin the original value and basis before any later worker step can observe a refresh
    def get(self, unit: str) -> Any:
        if unit not in self.values:
            self.values[unit] = value_text(super().get(unit))
        return json.loads(self.values[unit])

    # Initialize a complete settled arrangement once and append new files in indexed rows
    def members(self, bundle: str) -> None:
        unit = key("asset_bundles", bundle, "$members")
        if self.db.execute(
            "SELECT 1 FROM discovery_review_arrangements WHERE operation=? AND unit=?",
            (self.operation, unit),
        ).fetchone():
            return
        self.get(unit)
        self.db.execute(
            "INSERT INTO discovery_review_members SELECT ?,?,json_extract(value,'$.family'),"
            "json_extract(value,'$.id'),value,json_extract(value,'$.sequence') FROM json_each(?)",
            (self.operation, bundle, self.values[unit]),
        )
        self.db.execute(
            "INSERT INTO discovery_review_arrangements VALUES (?,?)", (self.operation, unit)
        )

    # Forest rows retain the complete original hierarchy while selected new ancestors are added
    def forest(self) -> None:
        unit = "collections/_/$forest"
        if self.db.execute(
            "SELECT 1 FROM discovery_review_arrangements WHERE operation=? AND unit=?",
            (self.operation, unit),
        ).fetchone():
            return
        self.get(unit)
        self.db.execute(
            "INSERT INTO discovery_review_forest SELECT ?,json_extract(value,'$.id'),value "
            "FROM json_each(?)",
            (self.operation, self.values[unit]),
        )
        self.db.execute(
            "INSERT INTO discovery_review_arrangements VALUES (?,?)", (self.operation, unit)
        )

    # Creation shares the catalog defaults and defers only complete array serialization
    def create(self, family: str, row: dict[str, Any]) -> None:
        if family not in AUTHORED:
            raise ReplicaError("Unsupported catalog family")
        identity = entity_id(family, row)
        if self.db.execute(
            "SELECT 1 FROM catalog_units WHERE family=? AND entity=? LIMIT 1",
            (family, identity),
        ).fetchone():
            raise ReplicaError(
                "A reviewed identity is already cataloged; Update and review its current grouping"
            )
        self.row(family, row)
        if family == "asset_bundles":
            self.put(key(family, identity, "$members"), [])
        elif family in ("asset_files", "bundle_directory_members"):
            self.members(row["bundle_id"])
            member = {"family": family, "id": identity, "sequence": row["sequence"]}
            if family == "asset_files":
                member["role"] = row["role"]
            self.db.execute(
                "INSERT INTO discovery_review_members VALUES (?,?,?,?,?,?)",
                (
                    self.operation,
                    row["bundle_id"],
                    family,
                    identity,
                    value_text(member),
                    row["sequence"],
                ),
            )
        elif family == "collections":
            self.forest()
            self.db.execute(
                "INSERT INTO discovery_review_forest VALUES (?,?,?)",
                (
                    self.operation,
                    identity,
                    value_text({name: row[name] for name in ("id", "parent_id", "sort_order")}),
                ),
            )

    # Serialize each complete arrangement once after all selected members have been prepared
    def arrangements(self) -> None:
        for (bundle,) in self.db.execute(
            "SELECT DISTINCT bundle FROM discovery_review_members WHERE operation=?",
            (self.operation,),
        ):
            raw = self.db.execute(
                "SELECT json_group_array(json(body)) FROM (SELECT body FROM "
                "discovery_review_members "
                "WHERE operation=? AND bundle=? ORDER BY sequence,family,id)",
                (self.operation, bundle),
            ).fetchone()[0]
            self.values[key("asset_bundles", bundle, "$members")] = raw
        if "collections/_/$forest" in self.values:
            raw = self.db.execute(
                "SELECT json_group_array(json(body)) FROM (SELECT body FROM "
                "discovery_review_forest "
                "WHERE operation=? ORDER BY id)",
                (self.operation,),
            ).fetchone()[0]
            self.values["collections/_/$forest"] = raw

    # Transport consumes one validated unit at a time, preserving every original causal basis
    def changes(self) -> Iterator[UnitChange]:
        for row in self.db.execute(
            "SELECT * FROM discovery_review_values WHERE operation=? ORDER BY unit",
            (self.operation,),
        ):
            yield UnitChange(
                unit=row["unit"],
                value=row["value"],
                basis=json.loads(row["basis"]),
                cohort=row["cohort"],
            )
