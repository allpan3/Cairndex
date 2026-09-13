"""Exact private schema inventory, including reviewed additive historical layouts"""

import re
import sqlite3
from contextlib import closing
from functools import lru_cache

from cairndex.replicas.protocol import ReplicaError

MEDIA_TABLES = {"local_media", "local_progress", "local_cursors"}


# Normalize presentation only; constraints, triggers, indices and columns remain part of the fence
def schema(db: sqlite3.Connection) -> dict[str, str]:
    return {
        name: re.sub(r"\s+", "", sql).lower().replace("ifnotexists", "")
        for name, sql in db.execute("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL")
    }


# Known older stores may precede media, restore receipts and either cohort bookkeeping column
@lru_cache
def known_schemas(catalog: bool) -> tuple[dict[str, str], ...]:
    from cairndex.replicas.catalog import projection, storage
    from cairndex.replicas.media import SCHEMA as media_schema
    from cairndex.replicas.store import SCHEMA

    results = []
    for legacy in (0, 1, 2):
        with closing(sqlite3.connect(":memory:")) as expected:
            catalog_schema = storage.SCHEMA
            if legacy:
                catalog_schema = catalog_schema.replace(
                    "anchor INTEGER NOT NULL, cohort TEXT NOT NULL,", ""
                )
            expected.executescript(SCHEMA)
            if catalog:
                expected.executescript(projection.SCHEMA + catalog_schema + media_schema)
                if legacy == 2:
                    expected.execute(
                        "ALTER TABLE catalog_cohorts ADD COLUMN anchor INTEGER NOT NULL DEFAULT 1"
                    )
            results.append(schema(expected))
            if legacy and catalog:
                if legacy == 1:
                    expected.execute(
                        "ALTER TABLE catalog_cohorts ADD COLUMN anchor INTEGER NOT NULL DEFAULT 1"
                    )
                expected.execute(
                    "ALTER TABLE catalog_cohorts ADD COLUMN cohort TEXT NOT NULL DEFAULT 'legacy'"
                )
                results.append(schema(expected))
    return tuple(results)


# Missing whole additive capabilities are migratable; partial or unknown schemas never are
def validate_schema(db: sqlite3.Connection, *, catalog: bool) -> dict[str, str]:
    actual = schema(db)
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1):
        raise ReplicaError("Private schema requires an upgrade")
    present = MEDIA_TABLES & actual.keys()
    if present and present != MEDIA_TABLES:
        raise ReplicaError("Private media schema is incomplete")
    for known in known_schemas(catalog):
        expected = dict(known)
        if version == 0:
            if not present:
                for name in MEDIA_TABLES:
                    expected.pop(name, None)
            if "recovery_receipts" not in actual:
                expected.pop("recovery_receipts")
            if "recovery_authors" not in actual:
                expected.pop("recovery_authors")
        if actual == expected:
            return actual
    raise ReplicaError("Unknown or incomplete private schema; recovery requires an upgrade")
