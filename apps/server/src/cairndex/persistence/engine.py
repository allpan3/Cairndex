from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings


def _apply_sqlite_pragmas(dbapi_connection: object, _connection_record: object) -> None:
    """Set connection-scoped SQLite pragmas (ADR-0002).

    These are per-connection in SQLite, so they must run on every new DBAPI
    connection rather than once at startup.
    """
    cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()


def create_app_engine(database_url: str | None = None) -> Engine:
    """Create an Engine with Cairndex's SQLite configuration applied.

    The data directory is created if needed so a fresh checkout/deploy can
    open the database without a manual mkdir.
    """
    settings = get_settings()
    url = database_url or settings.resolved_database_url()

    if url.startswith("sqlite:///") and ":memory:" not in url:
        settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)
    # Pragmas apply to file and in-memory SQLite alike (FK enforcement matters
    # for the in-memory test database too).
    if engine.dialect.name == "sqlite":
        event.listen(engine, "connect", _apply_sqlite_pragmas)
    return engine


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
    ("asset_files", "cover_previous_file_id", "VARCHAR(26)"),
    # Owner-edited grouping plans may explicitly override confirmed membership
    ("grouping_proposals", "base_bundle_id", "VARCHAR(26)"),
    ("grouping_proposals", "owner_edited", "BOOLEAN NOT NULL DEFAULT 0"),
    # Reversible destination for new files suggested into a confirmed bundle
    ("grouping_proposals", "target_bundle_title", "VARCHAR(1024)"),
    ("grouping_proposals", "create_new_bundle", "BOOLEAN NOT NULL DEFAULT 0"),
)

_ADDITIVE_CONTENT_TABLES: tuple[str, ...] = ("playback_progress", "bundle_cursors")


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
        for table_name, column, sql_type in _ADDITIVE_CONTENT_COLUMNS:
            if table_name not in existing:
                continue
            columns = {col["name"] for col in inspector.get_columns(table_name)}
            if column not in columns:
                conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column} {sql_type}"))
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
