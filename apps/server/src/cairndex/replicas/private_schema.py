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
    from cairndex.replicas.catalog.browse import INDEX_SCHEMA
    from cairndex.replicas.discovery_state import SCHEMA as discovery_schema
    from cairndex.replicas.media import SCHEMA as media_schema
    from cairndex.replicas.source_journal import SCHEMA as source_schema
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
                expected.executescript(
                    projection.SCHEMA
                    + catalog_schema
                    + media_schema
                    + discovery_schema
                    + source_schema
                )
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
    if catalog:
        with closing(sqlite3.connect(":memory:")) as expected:
            expected.executescript(projection.SCHEMA)
            before = schema(expected)
            expected.executescript(INDEX_SCHEMA)
            addition = {name: sql for name, sql in schema(expected).items() if name not in before}
        results.extend([item | addition for item in results.copy()])
    return tuple(results)


# Missing whole additive capabilities are migratable; partial or unknown schemas never are
def validate_schema(db: sqlite3.Connection, *, catalog: bool) -> dict[str, str]:
    actual = schema(db)
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1):
        raise ReplicaError("Private schema requires an upgrade")
    from cairndex.replicas.discovery_plan import TABLES as PLAN_TABLES
    from cairndex.replicas.discovery_preview import TABLES as PREVIEW_TABLES
    from cairndex.replicas.discovery_proposals import TABLES as PROPOSAL_TABLES
    from cairndex.replicas.discovery_state import BASE_TABLES
    from cairndex.replicas.discovery_verification import TABLES as VERIFICATION_TABLES
    from cairndex.replicas.source_journal import TABLES as SOURCE_TABLES

    groups = (
        BASE_TABLES,
        VERIFICATION_TABLES,
        PLAN_TABLES,
        PROPOSAL_TABLES,
        PREVIEW_TABLES,
        SOURCE_TABLES,
    )
    if any(group & actual.keys() for group in groups[1:]) and not actual.keys() >= BASE_TABLES:
        raise ReplicaError("Private discovery schema is incomplete")
    for group in groups:
        present_group = group & actual.keys()
        if present_group and present_group != group:
            raise ReplicaError("Private discovery schema is incomplete")
    present = MEDIA_TABLES & actual.keys()
    if present and present != MEDIA_TABLES:
        raise ReplicaError("Private media schema is incomplete")
    for known in known_schemas(catalog):
        expected = dict(known)
        for group in groups:
            if not group & actual.keys():
                for name in group:
                    expected.pop(name, None)
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
