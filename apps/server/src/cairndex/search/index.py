"""Versioned FTS5 cache of bundle names, bundle/file notes and moment comments"""

import re

from sqlalchemy import (
    Column,
    Connection,
    Engine,
    MetaData,
    Select,
    Table,
    Text,
    inspect,
    select,
    text,
)
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from cairndex.persistence.models import AssetBundle

FTS_TABLE = "bundle_search"
_SOURCE_VIEW = "bundle_search_source"
_SCHEMA_VERSION = 2
_VERSION_MARKER = f"cairndex-search-version: {_SCHEMA_VERSION}"
_BATCH_SIZE = 256
_COLUMNS = ("bundle_id", "title", "notes", "file_notes", "moments")
_VIEW_ROWID = "bundle_rowid"

# The virtual table is composed into queries but never created by ORM metadata
_fts_table = Table(FTS_TABLE, MetaData(), Column("bundle_id", Text))

# Resolve moment ownership through its file, including raw SQL membership updates
_CREATE_VIEW = f"""
CREATE VIEW {_SOURCE_VIEW} AS
-- {_VERSION_MARKER}
SELECT
  b.rowid AS bundle_rowid,
  b.id AS bundle_id,
  coalesce(b.title, '') AS title,
  coalesce((SELECT group_concat(value, ' ') FROM json_each(b.notes)), '') AS notes,
  coalesce((SELECT group_concat(f.note, ' ') FROM asset_files f
            WHERE f.bundle_id = b.id), '') AS file_notes,
  coalesce((SELECT group_concat(m.comment, ' ') FROM asset_files f
            JOIN moments m ON m.file_id = f.id WHERE f.bundle_id = b.id), '') AS moments
FROM asset_bundles b
"""
_CREATE_TABLE = (
    f"CREATE VIRTUAL TABLE {FTS_TABLE} USING fts5("
    "bundle_id UNINDEXED, title, notes, file_notes, moments, "
    "tokenize='unicode61 remove_diacritics 2')"
)
_INSERT_COLS = ", ".join(_COLUMNS)
_REINDEX_ONE = (
    f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
    f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW} WHERE {_VIEW_ROWID} = "
)
_ROWID_OF = "(SELECT rowid FROM asset_bundles WHERE id = %s)"
_FILE_OWNER = "(SELECT bundle_id FROM asset_files WHERE id = %s)"


# Preserve bundle rowids; the unindexed bundle_id column cannot support a cheap lookup
def _reindex(rowid_expr: str) -> str:
    return f"DELETE FROM {FTS_TABLE} WHERE rowid = {rowid_expr}; {_REINDEX_ONE}{rowid_expr};"


# Recompute one bundle by its indexed primary key
def _reindex_by_bundle(bundle_id_expr: str) -> str:
    return _reindex(_ROWID_OF % bundle_id_expr)


# Changes to unrelated technical metadata do not rewrite the search cache
_TRIGGERS: tuple[tuple[str, str], ...] = (
    ("bundle_search_bundle_ai", f"AFTER INSERT ON asset_bundles BEGIN {_reindex('NEW.rowid')} END"),
    (
        "bundle_search_bundle_au",
        f"AFTER UPDATE OF title, notes ON asset_bundles BEGIN {_reindex('NEW.rowid')} END",
    ),
    (
        "bundle_search_bundle_ad",
        f"AFTER DELETE ON asset_bundles BEGIN DELETE FROM {FTS_TABLE} WHERE rowid = OLD.rowid; END",
    ),
    (
        "bundle_search_file_ai",
        f"AFTER INSERT ON asset_files BEGIN {_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_file_au",
        f"AFTER UPDATE OF note, bundle_id ON asset_files BEGIN "
        f"{_reindex_by_bundle('OLD.bundle_id')} {_reindex_by_bundle('NEW.bundle_id')} END",
    ),
    (
        "bundle_search_file_ad",
        f"AFTER DELETE ON asset_files BEGIN {_reindex_by_bundle('OLD.bundle_id')} END",
    ),
    (
        "bundle_search_moment_ai",
        f"AFTER INSERT ON moments BEGIN {_reindex_by_bundle(_FILE_OWNER % 'NEW.file_id')} END",
    ),
    (
        "bundle_search_moment_au",
        f"AFTER UPDATE OF comment, file_id ON moments BEGIN "
        f"{_reindex_by_bundle(_FILE_OWNER % 'OLD.file_id')} "
        f"{_reindex_by_bundle(_FILE_OWNER % 'NEW.file_id')} END",
    ),
    (
        "bundle_search_moment_ad",
        f"AFTER DELETE ON moments BEGIN {_reindex_by_bundle(_FILE_OWNER % 'OLD.file_id')} END",
    ),
)
# Remove obsolete triggers on upgrade so tag/collection edits cannot revive excluded text
_LEGACY_TRIGGERS = (
    "bundle_search_tag_ai",
    "bundle_search_tag_ad",
    "bundle_search_coll_ai",
    "bundle_search_coll_ad",
    "bundle_search_tagname_au",
    "bundle_search_collname_au",
)


# Populate in bounded rowid batches without materializing the library in Python
def _populate(conn: Connection) -> int:
    last: int | None = None
    count = 0
    while True:
        rows = (
            conn.exec_driver_sql(
                "SELECT rowid FROM asset_bundles "
                + ("WHERE rowid > ? " if last is not None else "")
                + "ORDER BY rowid LIMIT ?",
                (last, _BATCH_SIZE) if last is not None else (_BATCH_SIZE,),
            )
            .scalars()
            .all()
        )
        if not rows:
            return count
        conn.exec_driver_sql(
            f"INSERT INTO {FTS_TABLE}(rowid, {_INSERT_COLS}) "
            f"SELECT {_VIEW_ROWID}, {_INSERT_COLS} FROM {_SOURCE_VIEW} "
            f"WHERE {_VIEW_ROWID} BETWEEN ? AND ? ORDER BY {_VIEW_ROWID}",
            (rows[0], rows[-1]),
        )
        count += len(rows)
        last = rows[-1]


# Upgrade the derived cache atomically under the library's existing ownership gate
def ensure_search_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        # SQLite's legacy transaction mode does not begin on DDL; fence the swap explicitly
        conn.exec_driver_sql("BEGIN IMMEDIATE")
        inspector = inspect(conn)
        exists = FTS_TABLE in inspector.get_table_names()
        installed = {
            name: sql
            for name, sql in conn.exec_driver_sql(
                "SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'view')"
            )
        }
        current = (
            exists
            and {c["name"] for c in inspector.get_columns(FTS_TABLE)} == set(_COLUMNS)
            and _VERSION_MARKER in (installed.get(_SOURCE_VIEW) or "")
            and all(
                installed.get(name) == f"CREATE TRIGGER {name} {body}" for name, body in _TRIGGERS
            )
            and not any(name in installed for name in _LEGACY_TRIGGERS)
        )
        if current:
            return
        for name in (*_LEGACY_TRIGGERS, *(name for name, _ in _TRIGGERS)):
            conn.exec_driver_sql(f"DROP TRIGGER IF EXISTS {name}")
        conn.exec_driver_sql(f"DROP VIEW IF EXISTS {_SOURCE_VIEW}")
        conn.exec_driver_sql(f"DROP TABLE IF EXISTS {FTS_TABLE}")
        conn.exec_driver_sql(_CREATE_VIEW)
        conn.exec_driver_sql(_CREATE_TABLE)
        _populate(conn)
        for name, body in _TRIGGERS:
            conn.exec_driver_sql(f"CREATE TRIGGER {name} {body}")


# Bulk loaders must restore maintenance and rebuild before exposing the library
def drop_maintenance_triggers(session: Session) -> None:
    for name, _ in _TRIGGERS:
        session.execute(text(f"DROP TRIGGER IF EXISTS {name}"))
    session.flush()


# Rebuild inside the caller's transaction, preserving every bundle's rowid
def rebuild(session: Session) -> int:
    session.flush()
    session.execute(text(f"DELETE FROM {FTS_TABLE}"))
    return _populate(session.connection())


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
