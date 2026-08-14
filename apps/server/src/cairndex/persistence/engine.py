import logging
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
from cairndex.core.errors import LibraryDatabaseOpenError
from cairndex.domain.enums import CONTEXT_DIRECTORY_PREFIX as _CONTEXT_DIRECTORY_PREFIX
from cairndex.persistence import journal

logger = logging.getLogger(__name__)


# Page-cache ceiling per connection, in KiB. SQLite's default is 2 MiB, which is
# smaller than a modestly used library database — so pages evicted during a write
# have to be read back, and on a network-hosted library each of those reads costs a
# round trip.
#
# Not a marginal effect. Writing a 340-row grouping plan into a 5.75 MB library on
# an SMB share took **over ten minutes** at the 2 MiB default and **5.5 seconds** at
# 16 MiB (owner-reported; measured 2026-08-14). Why it bites so hard there:
# ``grouping_proposals.parent_proposal_id`` references its own table, so with
# ``foreign_keys=ON`` SQLite seeks the primary-key index once per inserted row —
# while the inserts are evicting exactly those index pages. On local disk the
# re-reads are free, which is why it never showed up in development.
#
# A ceiling, not an allocation: SQLite grows the cache lazily, so a library small
# enough never to need it pays nothing.
_CACHE_KIB = 32 * 1024


def _apply_connection_pragmas(dbapi_connection: object, _connection_record: object) -> None:
    """Set the genuinely connection-scoped SQLite pragmas (ADR-0002).

    These three really are per-connection, so they must run on every new DBAPI
    connection rather than once at startup.

    ``journal_mode`` is deliberately **not** here, and used to be. It is stored
    in the database file header, not on the connection — so setting it here was
    not "reapplying a connection setting" but rewriting the file, on every
    connect, for every library. ADR-0021 has the incident that made the
    difference matter; :mod:`cairndex.persistence.journal` owns it now, once per
    engine, and differently for a library than for the server's own registry.
    """
    cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute(f"PRAGMA cache_size=-{_CACHE_KIB}")
    finally:
        cursor.close()


def _apply_registry_pragmas(dbapi_connection: object, connection_record: object) -> None:
    """Connection pragmas plus unconditional WAL, for the server-local registry.

    The registry is the one database that is never shared and never travels: it
    lives under ``CAIRNDEX_DATA_DIR`` on the server's own disk and is
    regenerable runtime state (ADR-0008 §3). None of ADR-0021's portability
    concerns apply to it, so it keeps WAL at all times.
    """
    _apply_connection_pragmas(dbapi_connection, connection_record)
    cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
    finally:
        cursor.close()


def _sqlite_file_path(url: str) -> Path | None:
    """The on-disk path behind a SQLite URL, or ``None`` for in-memory/other."""
    if not url.startswith("sqlite:///") or ":memory:" in url:
        return None
    return Path(url[len("sqlite:///") :])


def create_app_engine(database_url: str | None = None) -> Engine:
    """Create an Engine for a **library** database, with Cairndex's SQLite setup.

    The data directory is created if needed so a fresh checkout/deploy can
    open the database without a manual mkdir.

    Unlike the registry engine this one connects eagerly, to settle the file's
    journal mode (ADR-0021) before anything else touches it — WAL while we hold
    the library open, and a heal back to rollback if we find WAL on a filesystem
    that cannot host it. That first connection is also where a library whose
    file is unopenable announces itself, so the failure arrives as a domain
    error naming the cause and its recovery command rather than as a traceback.
    """
    settings = get_settings()
    url = database_url or settings.resolved_database_url()

    if url.startswith("sqlite:///") and ":memory:" not in url:
        settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)
    # Pragmas apply to file and in-memory SQLite alike (FK enforcement matters
    # for the in-memory test database too).
    if engine.dialect.name == "sqlite":
        event.listen(engine, "connect", _apply_connection_pragmas)

    db_path = _sqlite_file_path(url)
    if db_path is not None:
        try:
            journal.apply_library_journal_mode(engine, db_path)
        except Exception as error:
            engine.dispose()
            if journal.is_unable_to_open(error):
                failure = journal.diagnose_open_failure(db_path)
                logger.warning("library database at %s will not open (%s)", db_path, failure.reason)
                raise LibraryDatabaseOpenError(
                    failure.message,
                    details={"reason": failure.reason, "filesystem": failure.filesystem},
                ) from error
            raise
    return engine


@contextmanager
def library_engine_scope(database_url: str) -> Iterator[Engine]:
    """Open a library engine for one bootstrap/maintenance operation, and leave
    the file portable afterwards (ADR-0021).

    ``close_library_engines`` reverts a library's journal mode back to rollback
    on shutdown, but it only knows about engines that passed through the
    per-library cache in :mod:`cairndex.registry.library_engine`. A one-shot
    open — creating a fresh library, a devtools maintenance script, a benchmark
    — never enters that cache, so nothing would otherwise convert it back. A
    library created via this function and never opened again before the server
    stops was found in production left in WAL despite an entirely clean
    shutdown: the bootstrap engine had put it there and nothing was watching it.

    Every caller that opens a library engine outside the server's serving
    lifecycle should use this instead of ``create_app_engine`` directly.
    """
    engine = create_app_engine(database_url=database_url)
    try:
        yield engine
    finally:
        journal.checkpoint_and_revert(engine)
        engine.dispose()


# Nullable columns added to long-lived content tables after their first
# release. ``create_all`` never alters an existing table, and there is no
# migration chain, so a library created before a column existed is patched
# additively on open. Each entry is (table, column, SQLite type).
_ADDITIVE_CONTENT_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("collections", "note", "TEXT"),
    ("collections", "cover_bundle_id", "VARCHAR(26)"),
    # Multiple freeform notes per bundle (ordered list). Libraries created before
    # this column keep an unused ``note`` column; it is harmless and ignored.
    ("asset_bundles", "notes", "JSON"),
    # Manual-ordering columns (drag-reorder + "Clean up by…"): per-collection
    # bundle order on the membership table, global bundle order on the bundle.
    ("asset_bundle_collections", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
    ("asset_bundles", "manual_order", "INTEGER NOT NULL DEFAULT 0"),
    ("asset_files", "directory_path", "TEXT NOT NULL DEFAULT ''"),
    ("asset_files", "cover_time", "REAL"),
    # Owner-edited grouping plans may explicitly override confirmed membership
    ("grouping_proposals", "base_bundle_id", "VARCHAR(26)"),
    ("grouping_proposals", "owner_edited", "BOOLEAN NOT NULL DEFAULT 0"),
    # Only an explicit file move licenses overriding confirmed bundle membership
    ("grouping_proposals", "membership_edited", "BOOLEAN NOT NULL DEFAULT 0"),
    # Reversible destination for new files suggested into a confirmed bundle
    ("grouping_proposals", "target_bundle_title", "VARCHAR(1024)"),
    ("grouping_proposals", "create_new_bundle", "BOOLEAN NOT NULL DEFAULT 0"),
    # Existing collection context is identity-based, not inferred from its title
    ("grouping_proposals", "target_collection_id", "VARCHAR(26)"),
    # ...and being *context* is its own fact, not inferred from having a target
    ("grouping_proposals", "is_collection_context", "BOOLEAN NOT NULL DEFAULT 0"),
    # Per-directory heuristic overrides retained by each durable grouping
    # snapshot. Named for the three-value StemMode it first held; it now holds
    # integer stem levels, and the model maps ``stem_level_overrides`` onto it
    # rather than renaming a column no migration chain could rename.
    ("grouping_plans", "stem_modes", "JSON NOT NULL DEFAULT '{}'"),
    # Lets a scan skip regenerating a plan that would come out identical
    ("grouping_plans", "input_digest", "VARCHAR(64)"),
    # Recent view "Date Opened" ordering. NULL in an existing library means
    # "never opened here", which is the truth — opens were not recorded before.
    ("asset_bundles", "last_opened_at", "DATETIME"),
)

_ADDITIVE_CONTENT_TABLES: tuple[str, ...] = (
    "playback_progress",
    "bundle_cursors",
    # ADR-0013: a library that predates write mode gains an empty journal, which
    # is the correct starting history — nothing has been done to it yet.
    "file_operations",
)


def ensure_content_indexes(engine: Engine) -> None:
    """Bring a library DB up to the current model shape without migrations.

    Library DBs are bootstrapped with ``create_all`` (there is no migration
    chain in use), but ``create_all`` never adds a *new* index or column to a
    table that already exists — so a library created before one was added would
    miss it. This issues ``CREATE INDEX IF NOT EXISTS`` for each metadata index
    and ``ALTER TABLE ADD COLUMN`` for each missing additive column whose table
    is present (idempotent, cheap), once per library engine open. Skips tables
    that do not exist yet (e.g. a not-yet-created DB).
    """
    from cairndex.persistence import models  # noqa: F401 — populate metadata
    from cairndex.persistence.base import Base

    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table_name in _ADDITIVE_CONTENT_TABLES:
            table = Base.metadata.tables[table_name]
            table.create(bind=conn, checkfirst=True)
            existing.add(table_name)
        # Which columns this open actually added. A backfill belongs to the
        # migration that introduced its column, so running it on every library
        # open — as the grouping backfill below used to — costs a full scan and a
        # write transaction forever, to find nothing.
        added: set[tuple[str, str]] = set()
        for table_name, column, sql_type in _ADDITIVE_CONTENT_COLUMNS:
            if table_name not in existing:
                continue
            columns = {col["name"] for col in inspector.get_columns(table_name)}
            if column not in columns:
                conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column} {sql_type}"))
                added.add((table_name, column))
        # Recover exact existing-collection identity for plans written before the
        # column existed. ``_CONTEXT_DIRECTORY_PREFIX`` is the marker those rows
        # used; its length is taken from the constant rather than written as a
        # literal offset, so renaming it cannot silently truncate ids here.
        if ("grouping_proposals", "target_collection_id") in added:
            conn.execute(
                text(
                    "UPDATE grouping_proposals "
                    "SET target_collection_id = substr(directory, :start) "
                    "WHERE target_collection_id IS NULL AND directory LIKE :pattern"
                ),
                {
                    "start": len(_CONTEXT_DIRECTORY_PREFIX) + 1,
                    "pattern": f"{_CONTEXT_DIRECTORY_PREFIX}%",
                },
            )
        # Same marker identifies the synthesized read-only context rows themselves.
        if ("grouping_proposals", "is_collection_context") in added:
            conn.execute(
                text(
                    "UPDATE grouping_proposals SET is_collection_context = 1 "
                    "WHERE directory LIKE :pattern"
                ),
                {"pattern": f"{_CONTEXT_DIRECTORY_PREFIX}%"},
            )
        if "asset_files" in existing:
            # rtrim stops at the final slash; the second rtrim removes that slash
            conn.execute(
                text(
                    """UPDATE asset_files
                       SET directory_path = rtrim(
                           rtrim(relative_path, replace(relative_path, '/', '')), '/'
                       )
                       WHERE directory_path = '' AND instr(relative_path, '/') > 0"""
                )
            )
        # Additive columns must exist before indexes that reference them
        for table in Base.metadata.sorted_tables:
            if table.name not in existing:
                continue
            for index in table.indexes:
                index.create(bind=conn, checkfirst=True)


@lru_cache
def get_engine() -> Engine:
    return create_app_engine()


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional session context: commit on success, roll back on error."""
    session = get_sessionmaker()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a transactional session."""
    with session_scope() as session:
        yield session


def library_root_for_session(session: Session) -> Path:
    """The library root directory for a content session (ADR-0008).

    A library DB lives at ``<root>/.cairndex/library.db``, so the root is the
    grandparent of the bound engine's database file. Used by content services
    to resolve library-relative ``AssetFile`` paths without threading the root
    through every call.
    """
    bind = session.get_bind()
    database = getattr(getattr(bind, "url", None), "database", None)
    if not database:
        raise RuntimeError("session is not bound to a file-backed library database")
    return Path(database).resolve().parent.parent
