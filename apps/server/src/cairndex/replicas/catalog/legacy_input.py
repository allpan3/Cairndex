"""Read-only legacy package inspection and historical schema classification."""

import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas.inventory import INVENTORY
from cairndex.replicas.protocol import ReplicaError
from cairndex.search.index import FTS_TABLE

LEGACY_FORMAT = "cairndex.library"
METADATA = ".cairndex"

# Entries a legacy package may hold. The cache, locks, trash and the import staging
# folder (``tmp``) stay in the backup.
_PACKAGE_ENTRIES = {
    "manifest.json",
    "library.db",
    "library.db.bak",
    "cache",
    "locks",
    "trash",
    "tmp",
}
# Files that macOS and Windows file browsers add to any folder they display
_OS_ENTRIES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_SQLITE_SIDECARS = {"library.db-wal", "library.db-shm", "library.db-journal"}
_MANIFEST_FIELDS = {
    "format",
    "format_version",
    "library_uuid",
    "display_name",
    "db",
    "content_root",
    "created_at",
}

# Tables that earlier versions dropped or moved. They include bookkeeping,
# grouping suggestions (ADR-0022), retired prototypes such as the Eagle import
# map, and SQLite statistics. The backup folder keeps their rows unchanged.
_RETIRED_TABLES = {
    "alembic_version",
    "import_records",
    "grouping_plans",
    "grouping_proposals",
    "grouping_proposal_files",
    "grouping_proposal_directories",
    "key_moments",
    "key_moment_tags",
    "metadata_clock",
    "metadata_revisions",
    "metadata_receipts",
    "sqlite_sequence",
    "sqlite_stat1",
    "sqlite_stat4",
}
# Columns that earlier versions stopped reading, so they carry no current value:
# the single bundle note that ``asset_bundles.notes`` replaced, and the cover that
# a video frame displaced, which only an older reset restored.
_RETIRED_COLUMNS = {
    "asset_bundles": {"note"},
    "asset_files": {"cover_previous_file_id"},
}

_LEASE_TTL = timedelta(seconds=300)

# Final file-operation states. Anything else is an interrupted legacy write.
_SETTLED_OPERATIONS = {"DONE", "UNDONE", "FAILED", "EMPTIED"}


def _additive_defaults() -> dict[tuple[str, str], str]:
    """SQL default of each column that legacy versions added to existing libraries."""
    from cairndex.persistence.engine import _ADDITIVE_CONTENT_COLUMNS

    result = {}
    for table, column, sql_type in _ADDITIVE_CONTENT_COLUMNS:
        match = re.search(r"\bDEFAULT\s+(.+)$", sql_type)
        result[(table, column)] = match.group(1) if match else "NULL"
    return result


def _entries(metadata: Path) -> list[str]:
    """Package entries that review compares. The database digest covers SQLite sidecars."""
    return sorted(
        entry.name
        for entry in metadata.iterdir()
        if entry.name not in _OS_ENTRIES
        and not entry.name.startswith("._")
        and entry.name not in _SQLITE_SIDECARS
    )


def _derived(table: str) -> bool:
    """The search index and its shadow tables, which current versions rebuild."""
    return table in {
        FTS_TABLE,
        *(FTS_TABLE + suffix for suffix in ("_data", "_idx", "_content", "_docsize", "_config")),
    }


def _authored_tables() -> list[str]:
    return [name for name in INVENTORY if not name.startswith("plans.")]


def _quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _metadata(root: Path) -> Path:
    if not root.is_absolute() or root.resolve() != root or not root.is_dir():
        raise ReplicaError("Select an existing, unlinked library folder")
    metadata = root / METADATA
    if metadata.is_symlink() or not metadata.is_dir():
        raise ReplicaError("This folder has no library metadata")
    return metadata


def _manifest(metadata: Path) -> tuple[dict[str, Any], bytes]:
    path = metadata / "manifest.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ReplicaError("The library manifest is missing or unsupported")
    raw = path.read_bytes()
    try:
        manifest = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ReplicaError("The library manifest is not valid JSON") from error
    if not isinstance(manifest, dict) or manifest.get("format") != LEGACY_FORMAT:
        raise ReplicaError("Only libraries in the old format can be converted")
    if (
        type(manifest.get("format_version")) is not int
        or manifest["format_version"] != 1
        or manifest.get("db", "library.db") != "library.db"
        or manifest.get("content_root", ".") != "."
    ):
        raise ReplicaError("This old library layout is not supported for conversion")
    if set(manifest) - {"auth"} - _MANIFEST_FIELDS:
        raise ReplicaError("The library manifest has an unknown field")
    identity = manifest.get("library_uuid")
    name = manifest.get("display_name")
    if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity):
        raise ReplicaError("The library manifest has an unsupported identity")
    if not isinstance(name, str) or not name.strip():
        raise ReplicaError("The library manifest has no name")
    return manifest, raw


def _lease(root: Path) -> str:
    """Classify the legacy ownership lease by its heartbeat age alone.

    Old versions heartbeat every minute and treat five minutes of silence as stale
    (ADR-0018). A lease is never this server's own: format-three servers take none.
    """
    from cairndex.ownership.lease import read_lease

    snapshot = read_lease(root)
    if snapshot.corrupt or snapshot.io_error:
        return "unreadable"
    if snapshot.record is None:
        return "absent"
    if snapshot.record.released_at is not None:
        return "released"
    if datetime.now(UTC) - snapshot.record.heartbeat_at <= _LEASE_TTL:
        return "fresh"
    return "stale"


def _copy_database(metadata: Path, target: Path) -> str:
    """Copy the database and any WAL as bytes, recover the copy and digest its content.

    The live files are only read. Another server must not be writing (the lease check
    excludes a fresh holder), so the byte copy is a consistent checkpoint.
    """
    target.mkdir(mode=0o700)
    # A hot rollback journal or a WAL holds committed or unfinished transactions that
    # SQLite applies or rolls back when the copy opens.
    for name in ("library.db", "library.db-wal", "library.db-journal"):
        source = metadata / name
        if source.is_symlink():
            raise ReplicaError("Library metadata must not be linked")
        if source.exists() and not source.is_file():
            raise ReplicaError("Unsupported database companion")
        if source.is_file():
            shutil.copyfile(source, target / name)
        elif name == "library.db":
            raise ReplicaError("The library database is missing")
    with closing(connect_writable(target / "library.db")) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ReplicaError("The library database failed its integrity check")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise ReplicaError("The library database has unresolved references")
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.execute("PRAGMA journal_mode=DELETE")
        return _digest(db)


def _digest(db: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    db.execute("BEGIN")
    try:
        for row in db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"):
            digest.update(repr(row).encode())
        for (table,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall():
            columns = db.execute(f"PRAGMA table_info({_quoted(table)})").fetchall()
            order = ",".join(str(index + 1) for index in range(len(columns)))
            for row in db.execute(f"SELECT * FROM {_quoted(table)} ORDER BY {order}"):
                digest.update(repr(row).encode())
    finally:
        db.rollback()
    return digest.hexdigest()


def _layout(db: sqlite3.Connection) -> tuple[dict[str, set[str]], list[str]]:
    """Map source tables to columns and report layout problems that block conversion."""
    tables = {
        name: {row[1] for row in db.execute(f"PRAGMA table_info({_quoted(name)})")}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    problems = []
    authored = set(_authored_tables())
    if not {"asset_bundles", "asset_files"}.issubset(tables):
        problems.append("The library database is missing a required table")
    # Views and triggers hold no rows, so only tables can carry metadata
    if {name for name in tables if not _derived(name)} - authored - _RETIRED_TABLES:
        problems.append("The library database has an unknown table")
    defaults = _additive_defaults()
    for table in authored & set(tables):
        expected = {column for category in INVENTORY[table].values() for column in category.split()}
        if tables[table] - expected - _RETIRED_COLUMNS.get(table, set()):
            problems.append("The library database has an unknown column")
        if any((table, column) not in defaults for column in expected - tables[table]):
            problems.append("The library database is missing a required column")
    return tables, sorted(set(problems))


def _count(db: sqlite3.Connection, tables: dict[str, set[str]], query: str, table: str) -> int:
    return int(db.execute(query).fetchone()[0]) if table in tables else 0


def _retired_notes(db: sqlite3.Connection, columns: set[str]) -> int:
    """Single notes that versions since July 2026 no longer show; they stay in the backup."""
    if "note" not in columns:
        return 0
    query = "SELECT COUNT(*) FROM asset_bundles WHERE note IS NOT NULL AND note != ''"
    return int(db.execute(query).fetchone()[0])


def _report(db: sqlite3.Connection, tables: dict[str, set[str]]) -> dict[str, Any]:
    counts = {
        "bundles": "asset_bundles",
        "files": "asset_files",
        "folder_members": "bundle_directory_members",
        "tags": "tags",
        "tag_groups": "tag_groups",
        "collections": "collections",
        "smart_collections": "smart_folders",
        "moments": "moments",
        "subtitle_tracks": "subtitle_tracks",
    }
    report: dict[str, Any] = {
        "converts": {
            name: _count(db, tables, f"SELECT COUNT(*) FROM {table}", table)
            for name, table in counts.items()
        }
    }
    trash = 0
    interrupted = 0
    if "file_operations" in tables:
        for op, status in db.execute("SELECT op,status FROM file_operations"):
            if status not in _SETTLED_OPERATIONS:
                interrupted += 1
            elif op == "TRASH" and status == "DONE":
                trash += 1
    # Development builds after 0.2.1 recorded an unfinished grouping apply here
    if "grouping_settlement" in tables.get("metadata_receipts", set()):
        interrupted += _count(
            db,
            tables,
            "SELECT COUNT(*) FROM metadata_receipts WHERE grouping_settlement IS NOT NULL",
            "metadata_receipts",
        )
    report["stays_in_backup"] = {
        "resume_positions": _count(
            db, tables, "SELECT COUNT(*) FROM playback_progress", "playback_progress"
        ),
        "last_opened": (
            _count(
                db,
                tables,
                "SELECT COUNT(*) FROM asset_bundles WHERE last_opened_at IS NOT NULL",
                "asset_bundles",
            )
            if "last_opened_at" in tables.get("asset_bundles", set())
            else 0
        ),
        "trashed_items": trash,
        "grouping_suggestions": _count(
            db, tables, "SELECT COUNT(*) FROM grouping_plans", "grouping_plans"
        ),
        "retired_notes": _retired_notes(db, tables.get("asset_bundles", set())),
        "retired_moments": _count(db, tables, "SELECT COUNT(*) FROM key_moments", "key_moments"),
    }
    report["interrupted_operations"] = interrupted
    return report


def inspect(root: Path) -> dict[str, Any]:
    """Read-only report of what a conversion would keep, leave behind and refuse."""
    metadata = _metadata(root)
    manifest, _ = _manifest(metadata)
    blocking = []
    if set(_entries(metadata)) - _PACKAGE_ENTRIES:
        blocking.append("The library metadata folder has an unknown entry")
    lease = _lease(root)
    report: dict[str, Any] = {"converts": {}, "stays_in_backup": {}}
    if lease == "fresh":
        blocking.append("Another server is serving this library; release it there first")
    else:
        with tempfile.TemporaryDirectory(prefix="cairndex-inspect-") as scratch:
            _copy_database(metadata, Path(scratch) / "copy")
            with closing(connect_writable(Path(scratch) / "copy" / "library.db")) as db:
                tables, problems = _layout(db)
                blocking.extend(problems)
                if not problems:
                    report = _report(db, tables)
    if report.get("interrupted_operations"):
        blocking.append(
            "An earlier file operation did not finish; the old version must recover it first"
        )
    return {
        "format": "cairndex.legacy-conversion-inspection",
        "version": 1,
        "library_uuid": manifest["library_uuid"],
        "display_name": manifest["display_name"],
        "lease": lease,
        "passphrase": "auth" in manifest,
        "caches": (metadata / "cache").is_dir(),
        **report,
        "blocking": blocking,
    }
