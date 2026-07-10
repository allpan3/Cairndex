"""FTS5 search index schema, maintenance triggers, and query helpers."""

import re

from sqlalchemy import Column, Engine, MetaData, Select, Table, Text, inspect, select, text
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from cairndex.persistence.models import AssetBundle

FTS_TABLE = "bundle_search"
_SOURCE_VIEW = "bundle_search_source"
# FTS-indexed columns (bundle_id is stored but UNINDEXED — a lookup key, not a
# search field). Keep this list in sync with the view + INSERT column lists.
_COLUMNS = ("bundle_id", "title", "notes", "files", "tags", "collections")
_INDEXED = _COLUMNS[1:]

# A lightweight core Table (its own MetaData so create_all never tries to build
# this virtual table) used only to compose the MATCH subquery in browse.
_fts_meta = MetaData()
_fts_table = Table(FTS_TABLE, _fts_meta, Column("bundle_id", Text))

# The per-bundle aggregation. Files, tags, and collections are concatenated into
# one searchable blob each. media_kind is included so "video"/"image" match.
_CREATE_VIEW = f"""
CREATE VIEW IF NOT EXISTS {_SOURCE_VIEW} AS
SELECT
  b.id AS bundle_id,
  coalesce(b.title, '') AS title,
  -- All of the bundle's notes (a JSON array of strings) concatenated into one
  -- searchable blob.
  coalesce((SELECT group_concat(value, ' ') FROM json_each(b.notes)), '') AS notes,
  coalesce((
    SELECT group_concat(
      f.display_title || ' ' || f.original_filename || ' ' || f.relative_path
      || ' ' || coalesce(f.source, '') || ' ' || coalesce(f.media_kind, ''), ' ')
    FROM asset_files f WHERE f.bundle_id = b.id
  ), '') AS files,
  coalesce((
    SELECT group_concat(t.name, ' ') FROM tags t
    JOIN asset_bundle_tags bt ON bt.tag_id = t.id WHERE bt.bundle_id = b.id
  ), '') AS tags,
  coalesce((
    SELECT group_concat(c.name, ' ') FROM collections c
    JOIN asset_bundle_collections bc ON bc.collection_id = c.id WHERE bc.bundle_id = b.id
  ), '') AS collections
FROM asset_bundles b
"""

_CREATE_TABLE = (
    f"CREATE VIRTUAL TABLE {FTS_TABLE} USING fts5("
    "bundle_id UNINDEXED, title, notes, files, tags, collections, "
    "tokenize='unicode61 remove_diacritics 2')"
)

_INSERT_COLS = ", ".join(_COLUMNS)
# Recompute one bundle's row from the view. Used by every maintenance trigger and
# by rebuild; kept as one statement pair (delete-then-insert) so it is an upsert.
_REINDEX_ONE = (
    f"INSERT INTO {FTS_TABLE}({_INSERT_COLS}) "
    f"SELECT {_INSERT_COLS} FROM {_SOURCE_VIEW} WHERE bundle_id = "
)


def _reindex(key_expr: str) -> str:
    """A ``DELETE + INSERT`` recompute for the bundle identified by ``key_expr``
    (e.g. ``NEW.id`` or ``OLD.bundle_id``)."""
    return f"DELETE FROM {FTS_TABLE} WHERE bundle_id = {key_expr}; {_REINDEX_ONE}{key_expr};"


# Triggers keep the index fresh across every write path. Each recomputes the
# affected bundle(s) from the source view. Renames of a tag/collection recompute
# every bundle that references it (rare, so the fan-out is acceptable).
_TRIGGERS: tuple[tuple[str, str], ...] = (
    ("bundle_search_bundle_ai", f"AFTER INSERT ON asset_bundles BEGIN {_reindex('NEW.id')} END"),
    (
        "bundle_search_bundle_au",
        f"AFTER UPDATE ON asset_bundles BEGIN {_reindex('NEW.id')} END",
    ),
    (
        "bundle_search_bundle_ad",
        f"AFTER DELETE ON asset_bundles BEGIN DELETE FROM {FTS_TABLE} "
        "WHERE bundle_id = OLD.id; END",
    ),
    ("bundle_search_file_ai", f"AFTER INSERT ON asset_files BEGIN {_reindex('NEW.bundle_id')} END"),
    (
        "bundle_search_file_au",
        # A file can move between bundles (grouping apply), so recompute both.
        f"AFTER UPDATE ON asset_files BEGIN {_reindex('OLD.bundle_id')} "
        f"{_reindex('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_file_ad",
        f"AFTER DELETE ON asset_files BEGIN {_reindex('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_tag_ai",
        f"AFTER INSERT ON asset_bundle_tags BEGIN {_reindex('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_tag_ad",
        f"AFTER DELETE ON asset_bundle_tags BEGIN {_reindex('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_coll_ai",
        f"AFTER INSERT ON asset_bundle_collections BEGIN {_reindex('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_coll_ad",
        f"AFTER DELETE ON asset_bundle_collections BEGIN {_reindex('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_tagname_au",
        "AFTER UPDATE OF name ON tags BEGIN "
        f"DELETE FROM {FTS_TABLE} WHERE bundle_id IN "
        "(SELECT bundle_id FROM asset_bundle_tags WHERE tag_id = NEW.id); "
        f"INSERT INTO {FTS_TABLE}({_INSERT_COLS}) SELECT {_INSERT_COLS} FROM {_SOURCE_VIEW} "
        "WHERE bundle_id IN (SELECT bundle_id FROM asset_bundle_tags WHERE tag_id = NEW.id); END",
    ),
    (
        "bundle_search_collname_au",
        "AFTER UPDATE OF name ON collections BEGIN "
        f"DELETE FROM {FTS_TABLE} WHERE bundle_id IN "
        "(SELECT bundle_id FROM asset_bundle_collections WHERE collection_id = NEW.id); "
        f"INSERT INTO {FTS_TABLE}({_INSERT_COLS}) SELECT {_INSERT_COLS} FROM {_SOURCE_VIEW} "
        "WHERE bundle_id IN "
        "(SELECT bundle_id FROM asset_bundle_collections WHERE collection_id = NEW.id); END",
    ),
)


def ensure_search_schema(engine: Engine) -> None:
    """Create the FTS table, source view, and maintenance triggers if missing.

    Idempotent; called once per library-engine open. On first creation the index
    is populated from existing rows (triggers only fire on subsequent writes).
    """
    inspector = inspect(engine)
    table_exists = FTS_TABLE in set(inspector.get_table_names())
    # A table whose columns no longer match (e.g. after the note → notes rename)
    # is stale: its schema and the trigger bodies both embed the old column set,
    # so rebuild both. The FTS index is a derived cache, so a full repopulate
    # from the source view is lossless.
    stale = table_exists and {col["name"] for col in inspector.get_columns(FTS_TABLE)} != set(
        _COLUMNS
    )
    with engine.begin() as conn:
        # Recreate the source view so a library opened after the view definition
        # changed picks up the new SELECT. Cheap: a view has no stored data and
        # the triggers resolve it at fire time.
        conn.exec_driver_sql(f"DROP VIEW IF EXISTS {_SOURCE_VIEW}")
        conn.exec_driver_sql(_CREATE_VIEW)
        if stale:
            for name, _ in _TRIGGERS:
                conn.exec_driver_sql(f"DROP TRIGGER IF EXISTS {name}")
            conn.exec_driver_sql(f"DROP TABLE IF EXISTS {FTS_TABLE}")
            table_exists = False
        if not table_exists:
            conn.exec_driver_sql(_CREATE_TABLE)
        for name, body in _TRIGGERS:
            conn.exec_driver_sql(f"CREATE TRIGGER IF NOT EXISTS {name} {body}")
        if not table_exists:
            conn.exec_driver_sql(
                f"INSERT INTO {FTS_TABLE}({_INSERT_COLS}) SELECT {_INSERT_COLS} FROM {_SOURCE_VIEW}"
            )


def drop_maintenance_triggers(session: Session) -> None:
    """Drop all FTS maintenance triggers (leaves the table/view intact).

    For bulk-loading tools only (e.g. ``devtools.synthetic_library``): the
    triggers recompute one bundle's FTS row per write via a correlated view,
    which is fine for normal interactive/scan writes but pathological under a
    tight bulk-insert loop — SQLite trigger firing is per row even inside an
    ``executemany``-style batch, and many small FTS5 DELETE+INSERT operations
    fragment the index and get progressively slower as it grows. Callers must
    call :func:`ensure_search_schema` + :func:`rebuild` afterward to restore
    normal maintenance and repopulate the index in one efficient pass.
    """
    for name, _ in _TRIGGERS:
        session.execute(text(f"DROP TRIGGER IF EXISTS {name}"))
    session.flush()


def rebuild(session: Session) -> int:
    """Drop and repopulate the whole index from current rows. Returns row count."""
    session.execute(text(f"DELETE FROM {FTS_TABLE}"))
    session.execute(
        text(f"INSERT INTO {FTS_TABLE}({_INSERT_COLS}) SELECT {_INSERT_COLS} FROM {_SOURCE_VIEW}")
    )
    session.flush()
    count = session.execute(text(f"SELECT count(*) FROM {FTS_TABLE}")).scalar_one()
    return int(count)


# FTS5 query syntax is powerful and easy to trip into a syntax error with bare
# user input (unbalanced quotes, bare ``AND``/``NOT``, ``*`` in odd places). We
# strip everything but word characters, split into terms, and emit a safe
# implicit-AND of quoted prefix terms — so "cosmos ep" → `"cosmos"* "ep"*`.
_TERM = re.compile(r"[^\w]+", re.UNICODE)


def to_match_query(q: str) -> str | None:
    """Turn raw user text into a safe FTS5 MATCH string, or None if it has no
    usable terms."""
    terms = [t for t in _TERM.split(q.strip()) if t]
    if not terms:
        return None
    return " ".join(f'"{t}"*' for t in terms)


def matching_ids_select(match: str) -> Select[tuple[str]]:
    """A subquery of ``bundle_id`` matching ``match`` (an FTS5 MATCH string), for
    composing into a browse query as ``AssetBundle.id.in_(...)``."""
    return (
        select(_fts_table.c.bundle_id)
        .where(text(f"{FTS_TABLE} MATCH :fts_q").bindparams(fts_q=match))
        .select_from(_fts_table)
    )


def search_predicate(match: str) -> ColumnElement[bool]:
    """A boolean predicate restricting ``AssetBundle`` to FTS matches of ``match``."""
    return AssetBundle.id.in_(matching_ids_select(match))


__all__ = [
    "ensure_search_schema",
    "matching_ids_select",
    "rebuild",
    "search_predicate",
    "to_match_query",
]
