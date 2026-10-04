"""SQLite change clocks covering authored cells and structural conflict units"""

from collections.abc import Iterable
from uuid import uuid4

from sqlalchemy import Engine

# Explicit inventory excludes observations, caches and automatic timestamp/version bumps
FIELDS = {
    "asset_bundles": (
        "title notes rating cover_file_id extra_metadata manual_order "
        "grouping_state grouping_source"
    ),
    "asset_files": "bundle_id relative_path display_title note source role sequence cover_time",
    "bundle_directory_members": "bundle_id directory_path sequence",
    "moments": "bundle_id file_id start_s end_s comment",
    "tags": "parent_id name color sort_order",
    "tag_groups": "name sort_order",
    "collections": "parent_id name note cover_bundle_id sort_order",
    "smart_folders": "name filter_version filter_json default_sort default_layout sort_order",
    "subtitle_tracks": (
        "bundle_id video_file_id source_file_id embedded_index language label "
        "format is_default is_forced sort_order"
    ),
    "asset_bundle_tags": "bundle_id tag_id",
    "asset_bundle_collections": "bundle_id collection_id sort_order",
    "moment_tags": "moment_id tag_id",
    "tag_group_memberships": "group_id tag_id sort_order",
    "plans.grouping_plans": "status stem_modes input_digest",
    "plans.grouping_proposals": (
        "plan_id parent_proposal_id target_bundle_id target_bundle_title "
        "create_new_bundle target_collection_id is_collection_context "
        "base_bundle_id owner_edited membership_edited kind title directory "
        "sort_order"
    ),
    "plans.grouping_proposal_files": (
        "proposal_id asset_file_id relative_path proposed_role sequence"
    ),
    "plans.grouping_proposal_directories": "proposal_id directory_path expanded",
}
EDGES = {
    "asset_bundle_tags": ("bundle_id", "tag_id"),
    "asset_bundle_collections": ("bundle_id", "collection_id"),
    "moment_tags": ("moment_id", "tag_id"),
    "tag_group_memberships": ("group_id", "tag_id"),
}
REFERENCES = {
    "bundle_id": "asset_bundles",
    "tag_id": "tags",
    "collection_id": "collections",
    "moment_id": "moments",
    "group_id": "tag_groups",
    "file_id": "asset_files",
    "video_file_id": "asset_files",
    "source_file_id": "asset_files",
    "cover_file_id": "asset_files",
    "cover_bundle_id": "asset_bundles",
}


# Composite primary keys have stable, non-label identities
def identity(table: str, row: str) -> str:
    return " || '~' || ".join(f"{row}.{column}" for column in EDGES.get(table, ("id",)))


# Namespace units inside their database; schema prefixes are supplied to the guard
def unit(table: str, row: str, field: str) -> str:
    return f"'{table}/' || {identity(table, row)} || '/{field}'"


# Exact SQLite cells are JSON quoted, including complete ordered notes and opaque filters
def value(row: str, columns: Iterable[str]) -> str:
    fields = list(columns)
    if len(fields) == 1:
        return f"json_quote({row}.{fields[0]})"
    return "json_object(" + ", ".join(f"'{field}', {row}.{field}" for field in fields) + ")"


# Reject an unseen change before advancing any clock, including within multi-statement operations
def guard(schema: str, key: str, current: str, proposed: str) -> str:
    return (
        "SELECT CASE WHEN metadata_guard("
        f"'{schema}/' || ({key}), "
        f"coalesce((SELECT revision FROM metadata_revisions WHERE unit = ({key})), 0), "
        f"{current}, {proposed}) = 0 THEN RAISE(ABORT, 'metadata_conflict') END;"
    )


# Retain a clock tombstone even when the entity or edge is gone
def touch(schema: str, key: str, condition: str = "1") -> str:
    return (
        f"SELECT metadata_record('{schema}/' || ({key}), "
        f"coalesce((SELECT revision FROM metadata_revisions WHERE unit = ({key})), 0));"
        "INSERT INTO metadata_revisions(unit, revision) "
        f"SELECT ({key}), revision FROM metadata_clock "
        f"WHERE id = 1 AND ({key}) IS NOT NULL AND ({condition}) "
        "ON CONFLICT(unit) DO UPDATE SET revision = excluded.revision;"
    )


# Structural placements deliberately share a complete arrangement's conflict clock
def arrangements(table: str, row: str, columns: set[str]) -> list[str]:
    if table in ("asset_files", "bundle_directory_members") and columns & {
        "bundle_id",
        "sequence",
        "role",
    }:
        return [f"'asset_bundles/' || {row}.bundle_id || '/$members'"]
    if table in ("tags", "collections") and columns & {"parent_id", "sort_order"}:
        return [f"'{table}/_/$forest'"]
    if table == "asset_bundles" and "manual_order" in columns:
        return ["'asset_bundles/_/$order'"]
    if table == "asset_bundle_collections" and "sort_order" in columns:
        return [f"'collections/' || {row}.collection_id || '/$order'"]
    if table == "tag_group_memberships":
        return [f"'tag_groups/' || {row}.group_id || '/$members'"]
    if table == "smart_folders" and "sort_order" in columns:
        return ["'smart_folders/_/$order'"]
    if table.startswith("grouping_"):
        return ["'grouping/_/$plan'"]
    return []


# Emit reference lifetime checks and deletion-conflict clocks without coupling ordinary scalar edits
def references(schema: str, table: str, row: str, columns: set[str], check: bool) -> str:
    if schema != "main":
        return ""
    result = ""
    for column in sorted(columns):
        target = table if column == "parent_id" else REFERENCES.get(column)
        if target is None:
            continue
        key = f"'{target}/' || {row}.{column} || '/$deleted'"
        if check:
            result += guard(schema, key, "'true'", "'true'")
        result += touch(
            schema, f"'{target}/' || {row}.{column} || '/$edited'", f"{row}.{column} IS NOT NULL"
        )
    return result


# Group inseparable values while letting different authored fields proceed independently
def groups(table: str, columns: list[str]) -> dict[str, list[str]]:
    composites = {
        "moments": {"$span": ["bundle_id", "file_id", "start_s", "end_s"]},
        "smart_folders": {"$filter": ["filter_version", "filter_json"]},
    }.get(table, {})
    consumed = {field for fields in composites.values() for field in fields}
    return {**composites, **{column: [column] for column in columns if column not in consumed}}


# Persistent triggers cover ORM writes, bulk SQL, scanners, repair and cascades alike
def triggers(schema: str, table: str, columns: list[str]) -> Iterable[str]:
    old, new = value("OLD", columns), value("NEW", columns)
    for operation, row in (("INSERT", "NEW"), ("DELETE", "OLD")):
        before = "'null'" if operation == "INSERT" else old
        after = new if operation == "INSERT" else "'null'"
        key = unit(table, row, "$alive" if operation == "INSERT" else "$edited")
        body = guard(schema, key, before, after)
        if operation == "DELETE" and table not in EDGES:
            for arrangement in arrangements(table, row, set(columns)):
                body += guard(schema, arrangement, before, after)
        body += "UPDATE metadata_clock SET revision = revision + 1 WHERE id = 1;"
        if operation == "DELETE":
            body += touch(schema, unit(table, row, "$deleted"))
        body += touch(schema, unit(table, row, "$alive")) + touch(
            schema, unit(table, row, "$edited")
        )
        for arrangement in arrangements(table, row, set(columns)):
            body += touch(schema, arrangement)
        body += references(schema, table, row, set(columns), operation == "INSERT")
        yield (
            f"CREATE TRIGGER IF NOT EXISTS {schema}.metadata_{table}_{operation.lower()} "
            f"BEFORE {operation} ON {table} BEGIN {body} END"
        )
    for index, (field, fields) in enumerate(groups(table, columns).items()):
        condition = " OR ".join(f"OLD.{column} IS NOT NEW.{column}" for column in fields)
        before, after = value("OLD", fields), value("NEW", fields)
        key = unit(table, "OLD", field)
        body = guard(schema, unit(table, "OLD", "$alive"), old, new)
        body += guard(schema, key, before, after)
        structural = set(arrangements(table, "OLD", set(fields))) | set(
            arrangements(table, "NEW", set(fields))
        )
        for arrangement in sorted(structural):
            body += guard(schema, arrangement, old, new)
        body += "UPDATE metadata_clock SET revision = revision + 1 WHERE id = 1;"
        body += touch(schema, key) + touch(schema, unit(table, "OLD", "$edited"))
        for arrangement in sorted(structural):
            body += touch(schema, arrangement)
        body += references(schema, table, "OLD", set(fields), False)
        body += references(schema, table, "NEW", set(fields), True)
        yield (
            f"CREATE TRIGGER IF NOT EXISTS {schema}.metadata_{table}_update_{index} "
            f"BEFORE UPDATE OF {', '.join(fields)} ON {table} WHEN {condition} BEGIN {body} END"
        )


# Synthetic conversion archives clocks and retries as private protocol state
BOOKKEEPING = {
    "metadata_clock": "id epoch revision",
    "metadata_revisions": "unit revision",
    "metadata_receipts": "operation fingerprint status body basis grouping_settlement",
}


# Shared definitions let conversion validate exact protocol objects rather than trusting their names
def table_definitions(schema: str) -> dict[str, str]:
    tables = {
        "metadata_clock": (
            "(id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, revision INTEGER NOT NULL)"
        ),
        "metadata_revisions": "(unit TEXT PRIMARY KEY, revision INTEGER NOT NULL) WITHOUT ROWID",
    }
    if schema == "main":
        tables["metadata_receipts"] = (
            "(operation TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, "
            "body BLOB NOT NULL, basis TEXT NOT NULL, grouping_settlement TEXT) WITHOUT ROWID"
        )
    return {name: f"CREATE TABLE {name} {body}" for name, body in tables.items()}


# SQLite stores trigger SQL without the schema qualifier or IF NOT EXISTS clause
def trigger_definitions(schema: str) -> dict[str, str]:
    result = {}
    for qualified, fields in FIELDS.items():
        prefix, _, table = qualified.rpartition(".")
        if (prefix or "main") != schema:
            continue
        for sql in triggers(schema, table, fields.split()):
            name = sql.split()[5].split(".", 1)[1]
            result[name] = sql.replace("IF NOT EXISTS ", "").replace(f"{schema}.", "", 1)
    return result


# Add protocol bookkeeping without rebuilding content or scanning its values
def ensure_metadata_schema(engine: Engine) -> None:
    with engine.begin() as connection:
        for schema in ("main", "plans"):
            for name, sql in table_definitions(schema).items():
                connection.exec_driver_sql(
                    sql.replace(f"TABLE {name}", f"TABLE IF NOT EXISTS {schema}.{name}", 1)
                )
            if schema == "main":
                columns = {
                    row[1]
                    for row in connection.exec_driver_sql(
                        "PRAGMA main.table_info(metadata_receipts)"
                    )
                }
                if "grouping_settlement" not in columns:
                    connection.exec_driver_sql(
                        "ALTER TABLE metadata_receipts ADD COLUMN grouping_settlement TEXT"
                    )
                connection.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_metadata_pending_grouping "
                    "ON metadata_receipts(operation) "
                    "WHERE grouping_settlement IS NOT NULL"
                )
            connection.exec_driver_sql(
                f"INSERT OR IGNORE INTO {schema}.metadata_clock VALUES (1, ?, 0)", (uuid4().hex,)
            )
            existing = {
                row[0]: row[1]
                for row in connection.exec_driver_sql(
                    f"SELECT name, sql FROM {schema}.sqlite_master WHERE type='trigger'"
                )
            }
            tables = set(
                connection.exec_driver_sql(
                    f"SELECT name FROM {schema}.sqlite_master WHERE type='table'"
                ).scalars()
            )
            for name, sql in trigger_definitions(schema).items():
                table = sql.split(" ON ", 1)[1].split()[0]
                if table in tables and existing.get(name) != sql:
                    connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {schema}.{name}")
                    connection.exec_driver_sql(
                        sql.replace(f"TRIGGER {name}", f"TRIGGER {schema}.{name}", 1)
                    )
