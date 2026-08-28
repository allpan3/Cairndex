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
# The FTS row's `rowid` is the owning bundle's own integer rowid (`asset_bundles`
# has a TEXT primary key, so it is an ordinary rowid table). That is the only key
# an FTS5 table can look a row up by: `bundle_id` is UNINDEXED and FTS5 supports
# no secondary indexes, so `WHERE bundle_id = ?` is a full scan of the index —
# 8.5 ms on a 60k-bundle library against 0.0 ms by rowid, and every maintenance
# trigger below did exactly that, twice for a file move. Measured on a synthetic
# 60k library: one create_bundle cost 94 ms with these triggers and 6 ms without
# (owner: "creating a bundle takes about 5 seconds", 2026-08-26).
_VIEW_ROWID = "bundle_rowid"

# A lightweight core Table (its own MetaData so create_all never tries to build
# this virtual table) used only to compose the MATCH subquery in browse.
_fts_meta = MetaData()
_fts_table = Table(FTS_TABLE, _fts_meta, Column("bundle_id", Text))

# The per-bundle aggregation. Files, tags, and collections are concatenated into
# one searchable blob each. media_kind is included so "video"/"image" match.
_CREATE_VIEW = f"""
CREATE VIEW IF NOT EXISTS {_SOURCE_VIEW} AS
SELECT
  b.rowid AS bundle_rowid,
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
# Both writes are keyed on rowid. The insert carries it explicitly so the FTS row
# and its bundle stay addressable by the same integer for the row's whole life.
_REINDEX_ONE = (
    f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
    f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW} WHERE {_VIEW_ROWID} = "
)
# For triggers that know only a bundle id: one indexed primary-key lookup.
_ROWID_OF = "(SELECT rowid FROM asset_bundles WHERE id = %s)"


def _reindex(rowid_expr: str) -> str:
    """A ``DELETE + INSERT`` recompute of the FTS row whose rowid is
    ``rowid_expr`` — ``NEW.rowid`` on an ``asset_bundles`` trigger, or
    :data:`_ROWID_OF` for one that knows only a bundle id.

    Both halves key on rowid, never on ``bundle_id``: see :data:`_VIEW_ROWID`.
    """
    return f"DELETE FROM {FTS_TABLE} WHERE rowid = {rowid_expr}; {_REINDEX_ONE}{rowid_expr};"


def _reindex_by_bundle(bundle_id_expr: str) -> str:
    """Recompute the FTS row for the bundle ``bundle_id_expr`` names."""
    return _reindex(_ROWID_OF % bundle_id_expr)


def _bundle_rowids(link_table: str, key_column: str) -> str:
    """Rowids of every bundle joined to the renamed tag/collection (``NEW.id``)."""
    return (
        f"(SELECT b.rowid FROM asset_bundles b "
        f"JOIN {link_table} x ON x.bundle_id = b.id WHERE x.{key_column} = NEW.id)"
    )


def _reindex_many(rowids_sql: str) -> str:
    """A ``DELETE + INSERT`` recompute of every FTS row in ``rowids_sql``."""
    return (
        f"DELETE FROM {FTS_TABLE} WHERE rowid IN {rowids_sql}; "
        f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
        f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW} "
        f"WHERE {_VIEW_ROWID} IN {rowids_sql};"
    )


# Triggers keep the index fresh across every write path. Each recomputes the
# affected bundle(s) from the source view. Renames of a tag/collection recompute
# every bundle that references it (rare, so the fan-out is acceptable).
_TRIGGERS: tuple[tuple[str, str], ...] = (
    (
        "bundle_search_bundle_ai",
        f"AFTER INSERT ON asset_bundles BEGIN {_reindex('NEW.rowid')} END",
    ),
    (
        "bundle_search_bundle_au",
        f"AFTER UPDATE ON asset_bundles BEGIN {_reindex('NEW.rowid')} END",
    ),
    (
        # OLD.rowid, not a lookup by id: the bundle row is already gone by the
        # time this fires, so resolving its rowid through `asset_bundles` would
        # find nothing and leave the FTS row behind forever.
        "bundle_search_bundle_ad",
        f"AFTER DELETE ON asset_bundles BEGIN DELETE FROM {FTS_TABLE} WHERE rowid = OLD.rowid; END",
    ),
    (
        "bundle_search_file_ai",
        f"AFTER INSERT ON asset_files BEGIN {_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_file_au",
        # A file can move between bundles (grouping apply), so recompute both.
        f"AFTER UPDATE ON asset_files BEGIN {_reindex_by_bundle('OLD.bundle_id')} "
        f"{_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_file_ad",
        f"AFTER DELETE ON asset_files BEGIN {_reindex_by_bundle('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_tag_ai",
        f"AFTER INSERT ON asset_bundle_tags BEGIN {_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_tag_ad",
        f"AFTER DELETE ON asset_bundle_tags BEGIN {_reindex_by_bundle('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_coll_ai",
        f"AFTER INSERT ON asset_bundle_collections BEGIN {_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_coll_ad",
        f"AFTER DELETE ON asset_bundle_collections BEGIN {_reindex_by_bundle('OLD.bundle_id')} END",
    ),
    # A rename fans out over every bundle referencing the tag/collection. Rare,
    # so the fan-out is acceptable — but it is now a rowid set rather than a
    # `bundle_id IN (…)` match, which scanned the whole index however few bundles
    # actually carried the tag.
    (
        "bundle_search_tagname_au",
        f"AFTER UPDATE OF name ON tags BEGIN "
        f"{_reindex_many(_bundle_rowids('asset_bundle_tags', 'tag_id'))} END",
    ),
    (
        "bundle_search_collname_au",
        f"AFTER UPDATE OF name ON collections BEGIN "
        f"{_reindex_many(_bundle_rowids('asset_bundle_collections', 'collection_id'))} END",
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
    # An index built before the reindex was keyed on rowid holds auto-assigned
    # rowids unrelated to `asset_bundles.rowid`, so the new triggers would delete
    # the wrong row — or none at all. The installed trigger body is the marker:
    # it mentions `rowid` only under the new scheme. Rebuilding is lossless (the
    # index is a derived cache of the source view) and happens once, on the first
    # open after this change.
    if table_exists and not stale:
        with engine.connect() as conn:
            body = conn.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
                ("bundle_search_bundle_ai",),
            ).scalar()
        stale = body is None or "rowid" not in body
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
                f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
                f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW}"
            )


def drop_maintenance_triggers(session: Session) -> None:
    """Drop all FTS maintenance triggers (leaves the table/view intact).

    For bulk-loading tools only (e.g. ``devtools.synthetic_library``): the
    triggers recompute one bundle's FTS row per write, and SQLite fires them per
    row even inside an ``executemany``-style batch, so a tight bulk-insert loop
    pays for one DELETE+INSERT per row. Callers must call
    :func:`ensure_search_schema` + :func:`rebuild` afterward to restore normal
    maintenance and repopulate the index in one efficient pass.

    This docstring used to blame "a correlated view" for the cost, which sent the
    2026-08-26 investigation down the wrong path. Measured on a 60k-bundle
    library, the view side of a reindex is 2.1 ms; the DELETE was 8.5 ms, because
    it matched on the UNINDEXED ``bundle_id`` and so scanned the whole index.
    Both halves are now keyed on rowid — see :data:`_VIEW_ROWID`.
    """
    for name, _ in _TRIGGERS:
        session.execute(text(f"DROP TRIGGER IF EXISTS {name}"))
    session.flush()


def rebuild(session: Session) -> int:
    """Drop and repopulate the whole index from current rows. Returns row count."""
    session.execute(text(f"DELETE FROM {FTS_TABLE}"))
    session.execute(
        text(
            f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
            f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW}"
        )
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
