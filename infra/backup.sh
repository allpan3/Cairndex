#!/usr/bin/env bash
# Cairndex SQLite backup helper (AGENTS.md §12 / docs/deployment.md).
#
# Makes a consistent, hot copy of one SQLite database using SQLite's online
# backup API — safe to run while the app is writing (WAL mode), no downtime,
# never touches source media.
#
# ADR-0008 split state across multiple DBs:
#   - server registry: /data/registry.db
#   - each library:    <library-root>/.cairndex/library.db
#
# Back up the registry plus every library DB you care about. Derived cache files
# under .cairndex/cache/ are regenerable.
#
# Recommended (run against the live container so the paths + python are present):
#   docker exec cairndex-app-1 /app/infra/backup.sh /data/registry.db /data/backups
#   docker exec cairndex-app-1 /app/infra/backup.sh /storage/media/.cairndex/library.db /data/backups
#   docker cp cairndex-app-1:/data/backups ./backups
#
# Restore is a file copy while the app is STOPPED:
#   docker compose -f docker-compose.prod.yml down
#   # replace registry.db and/or library.db with the backup copy, then:
#   docker compose -f docker-compose.prod.yml up -d
set -euo pipefail

DB_PATH="${1:-${CAIRNDEX_DATA_DIR:-/data}/registry.db}"
DEST_DIR="${2:-./backups}"

if [ ! -f "$DB_PATH" ]; then
  echo "error: database not found at $DB_PATH" >&2
  echo "usage: $0 [DB_PATH] [DEST_DIR]" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_NAME="$(basename "$DB_PATH")"
DB_STEM="${DB_NAME%.db}"
OUT="$DEST_DIR/${DB_STEM}-$STAMP.db"

# sqlite3.backup() copies a live database safely under concurrent writes; a
# plain `cp` of a WAL database can capture a torn/partial state.
python3 - "$DB_PATH" "$OUT" <<'PY'
import sqlite3
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(src_path)
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst)
dst.close()
src.close()
PY

# Integrity-check the copy so a corrupt backup fails loudly rather than silently.
result="$(python3 - "$OUT" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
print(conn.execute("PRAGMA integrity_check").fetchone()[0])
conn.close()
PY
)"

if [ "$result" != "ok" ]; then
  echo "error: integrity check failed for $OUT: $result" >&2
  exit 1
fi

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
