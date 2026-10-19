"""Connection-scoped SQLite durability policy (ADR-0039).

Keep this module standard-library only for the standalone registry helpers.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Literal


def configure_durability(
    connection: sqlite3.Connection,
    *,
    synchronous: Literal["NORMAL", "FULL"] = "FULL",
    schema: Literal["main", "plans"] = "main",
) -> None:
    """Configure a new connection, and each writable schema after ATTACH.

    macOS fsync alone does not flush device caches. FULL also ensures WAL
    commits actually sync; NORMAL would defer that work until a checkpoint.
    Other platforms retain the caller's existing synchronous policy.
    """
    cursor = connection.cursor()
    try:
        if sys.platform == "darwin":
            cursor.execute("PRAGMA fullfsync=ON")
            cursor.execute("PRAGMA checkpoint_fullfsync=ON")
            synchronous = "FULL"
        cursor.execute(f"PRAGMA {schema}.synchronous={synchronous}")
    finally:
        cursor.close()


def connect_writable(
    database: str | Path, *, uri: bool = False, timeout: float = 5.0
) -> sqlite3.Connection:
    """Open a raw SQLite writer with durability set before its first write.

    The caller owns commit/rollback and close, just as with sqlite3.connect.
    Read-only and in-memory schema-validation connections need no writer policy.
    """
    connection = sqlite3.connect(database, uri=uri, timeout=timeout)
    try:
        configure_durability(connection)
    except BaseException:
        connection.close()
        raise
    return connection
