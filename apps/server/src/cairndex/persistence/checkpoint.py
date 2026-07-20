"""SQLite WAL checkpointing and consistent snapshots (ADR-0018 §6).

A library in WAL mode is three files on disk — ``library.db``, ``-wal``,
``-shm`` — and a cloud-sync engine uploads whatever it finds whenever it happens
to look. If it looks mid-write it can ship a torn set, and a library that never
syncs again from that machine is left with it.

Two defences, both here:

- **Checkpoint when idle**, so the at-rest state a sync engine sees is normally
  a single consistent ``library.db`` with an empty WAL. SQLite's automatic
  checkpoint only fires at ~1000 pages, which a browsing session may not reach
  for a long time.
- **A periodic snapshot** through SQLite's backup API, as the heal path if a
  torn set ever does get shipped.
"""

import contextlib
import logging
import os
import sqlite3
import tempfile
from pathlib import Path

from sqlalchemy import Engine

logger = logging.getLogger(__name__)

SNAPSHOT_SUFFIX = ".bak"


def checkpoint_wal(engine: Engine) -> bool:
    """Fold the WAL back into the main database and truncate it to nothing.

    ``TRUNCATE`` rather than ``PASSIVE``: passive leaves the WAL file at its
    high-water mark, so the sync engine keeps uploading a large second file that
    contributes nothing. Returns whether the checkpoint completed — it is
    blocked, harmlessly, by a concurrently open reader, and the next pass will
    simply try again.
    """
    if engine.dialect.name != "sqlite":
        return False
    try:
        with engine.connect() as conn:
            row = conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    except Exception:  # noqa: BLE001 — a busy DB or an offline mount is not fatal
        logger.debug("wal checkpoint did not run", exc_info=True)
        return False
    # The pragma returns (busy, log_pages, checkpointed_pages); busy=1 means a
    # reader held it back.
    return bool(row is not None and row[0] == 0)


def snapshot_database(source: Path, destination: Path) -> bool:
    """Write a consistent copy of a SQLite DB using the online backup API.

    The backup API reads a transactionally consistent view even while the
    database is being written, which a file copy cannot do. The copy lands on a
    temporary name in the destination's own directory and is then renamed into
    place, so a sync engine (or a person) never sees a half-written snapshot —
    the same temp-then-rename discipline the ownership lease uses.
    """
    if not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=destination.parent, prefix=".snapshot-", suffix=".tmp")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        # ``closing`` is load-bearing, not tidiness: sqlite3's own context
        # manager commits or rolls back but does *not* close, so a plain
        # ``with sqlite3.connect(...)`` leaves the connection open — and an open
        # connection to a WAL database leaves a ``-wal``/``-shm`` pair on disk.
        # Snapshotting would then dirty the very library it is protecting,
        # recreating the torn triple this module exists to avoid.
        #
        # The mkstemp file exists and is empty; sqlite3 initializes a
        # zero-length file as a database happily.
        with (
            contextlib.closing(sqlite3.connect(source)) as src,
            contextlib.closing(sqlite3.connect(tmp)) as dst,
        ):
            src.backup(dst)
        os.replace(tmp, destination)
    except Exception:  # noqa: BLE001 — a snapshot is best-effort maintenance
        logger.warning("could not snapshot a library database", exc_info=True)
        _cleanup(tmp)
        return False
    finally:
        # Belt and braces for the backup target's own sidecars, which are named
        # after the temp file and so are orphaned by the rename either way.
        _cleanup(Path(f"{tmp}-wal"))
        _cleanup(Path(f"{tmp}-shm"))
    return True


def snapshot_path_for(db_path: Path) -> Path:
    """Where a library's snapshot lives: alongside its DB, inside ``.cairndex/``.

    Inside the marker directory on purpose — it travels with the library like
    the rest of the portable package, and scanning already ignores
    ``.cairndex/`` so it can never be mistaken for media.
    """
    return db_path.with_name(db_path.name + SNAPSHOT_SUFFIX)


def _cleanup(path: Path) -> None:
    with contextlib.suppress(OSError):
        path.unlink(missing_ok=True)
