#!/usr/bin/env bash
# Restore one Cairndex SQLite backup atomically while the application is stopped
set -euo pipefail

if [[ $# -ne 3 || "$1" != "--stopped" ]]; then
    echo "usage: $0 --stopped BACKUP_PATH DATABASE_PATH" >&2
    echo "error: stop every Cairndex process that can open this database first" >&2
    exit 2
fi

BACKUP_PATH="$2"
DB_PATH="$3"

if [[ ! -f "$BACKUP_PATH" ]]; then
    echo "error: backup not found at $BACKUP_PATH" >&2
    exit 1
fi
if [[ ! -d "$(dirname "$DB_PATH")" ]]; then
    echo "error: destination directory does not exist: $(dirname "$DB_PATH")" >&2
    exit 1
fi

# A live or uncleanly stopped WAL database must not be replaced underneath its
# sidecars. Stop/restart cleanly first so SQLite can recover and checkpoint it.
for sidecar in "${DB_PATH}-wal" "${DB_PATH}-shm"; do
    if [[ -e "$sidecar" ]]; then
        echo "error: refusing restore while SQLite sidecar exists: $sidecar" >&2
        exit 1
    fi
done

python3 - "$BACKUP_PATH" "$DB_PATH" <<'PY'
from __future__ import annotations

import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
if source == destination:
    raise SystemExit("error: backup and destination are the same file")

mode = stat.S_IMODE(destination.stat().st_mode) if destination.exists() else 0o600
rollback: Path | None = None
if destination.exists():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rollback = destination.with_name(f"{destination.name}.pre-restore-{stamp}-{os.getpid()}")
    shutil.copy2(destination, rollback)

fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.restore-", dir=destination.parent)
os.close(fd)
temporary = Path(temporary_name)
try:
    # The shell already proved the source exists. A normal path keeps `?` and
    # `#` literal instead of letting SQLite's URI parser reinterpret them.
    src = sqlite3.connect(source)
    src.execute("PRAGMA query_only = ON")
    dst = sqlite3.connect(temporary)
    try:
        with dst:
            src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise SystemExit(f"error: restored copy failed integrity check: {result}")
    finally:
        dst.close()
        src.close()

    os.chmod(temporary, mode)
    with temporary.open("rb") as handle:
        os.fsync(handle.fileno())
    os.replace(temporary, destination)
    directory_fd = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    temporary.unlink(missing_ok=True)

message = f"restore ok: {source} -> {destination}"
if rollback is not None:
    message += f" (previous file: {rollback})"
print(message)
PY
