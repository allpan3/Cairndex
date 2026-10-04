"""Streaming complete authored seeds from validated private legacy checkpoints"""

import json
import sqlite3
from collections.abc import Iterator

from cairndex.replicas.catalog.model import AUTHORED, Row, key, member_units, row_units, value_text
from cairndex.replicas.catalog.projection import validate_inventory
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.protocol import ReplicaError


# Conversion refuses both unfinished writes and completed trash with outstanding restoration
def validate_checkpoint(db: sqlite3.Connection) -> None:
    validate_inventory(db)
    validate_inventory(db, "plans")
    for schema in ("main", "plans"):
        if db.execute(f"PRAGMA {schema}.integrity_check").fetchall() != [("ok",)]:
            raise ReplicaError("Legacy checkpoint integrity check failed")
        if db.execute(f"PRAGMA {schema}.foreign_key_check").fetchone():
            raise ReplicaError("Legacy checkpoint has unresolved references")
    for op, status, payload in db.execute("SELECT op,status,payload FROM file_operations"):
        if status not in ("DONE", "UNDONE", "FAILED", "EMPTIED") or (
            op == "TRASH" and status == "DONE"
        ):
            raise ReplicaError("Unresolved source-operation recovery blocks conversion")
        if not isinstance(json.loads(payload), dict):
            raise ReplicaError("Unrecognized source-operation recovery record")


# Exact cells pass through the seed; observations and plans remain in the private checkpoint
def authored_rows(db: sqlite3.Connection, family: str) -> Iterator[Row]:
    columns = AUTHORED[family]
    query = ",".join(f'"{column}"' for column in columns)
    for row in db.execute(f"SELECT {query} FROM {family}"):
        yield dict(zip(columns, row, strict=True))


# Each bundle has one complete membership unit, including empty bundles beyond the first page
def seed_changes(db: sqlite3.Connection) -> Iterator[UnitChange]:
    for family in AUTHORED:
        for row in authored_rows(db, family):
            for unit, value in row_units(family, row):
                yield UnitChange(unit=unit, value=value, basis=[])
    for (identity,) in db.execute("SELECT id FROM asset_bundles ORDER BY id"):
        members: list[tuple[str, Row]] = []
        for family in ("asset_files", "bundle_directory_members"):
            columns = AUTHORED[family]
            query = ",".join(columns)
            members.extend(
                (family, dict(zip(columns, row, strict=True)))
                for row in db.execute(
                    f"SELECT {query} FROM {family} WHERE bundle_id=? ORDER BY sequence,id",
                    (identity,),
                )
            )
        unit, value = member_units(identity, members)
        yield UnitChange(unit=unit, value=value, basis=[])
    for family in ("tags", "collections"):
        forest = [
            dict(zip(("id", "parent_id", "sort_order"), row, strict=True))
            for row in db.execute(f"SELECT id,parent_id,sort_order FROM {family} ORDER BY id")
        ]
        yield UnitChange(unit=key(family, "_", "$forest"), value=value_text(forest), basis=[])
