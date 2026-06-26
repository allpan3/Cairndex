#!/usr/bin/env bash
# Cairndex app-data backup (AGENTS.md §12 / docs/deployment.md).
#
# Makes a consistent, hot copy of the SQLite database using SQLite's online
# backup API — safe to run WHILE the app is writing (WAL mode), no downtime,
# never touches your media. The database is the only state worth backing up;
# the derived-media cache (thumbnails, converted subtitles) is regenerable.
#
# Recommended (run against the live container so the path + python are present):
#   docker exec cairndex-app-1 \
#     /app/infra/backup.sh /data/cairndex.db /data/backups
#   docker cp cairndex-app-1:/data/backups ./backups   # pull off the NAS
#
# Or directly on the host (needs python3 and read access to the db file):
#   ./infra/backup.sh /path/to/cairndex.db ./backups
#
# Restore is just a file copy while the app is STOPPED:
#   docker compose -f docker-compose.prod.yml down
#   # replace the db in the cairndex-data volume with a backup, then:
#   docker compose -f docker-compose.prod.yml up -d
set -euo pipefail

DB_PATH="${1:-${CAIRNDEX_DATA_DIR:-/data}/cairndex.db}"
DEST_DIR="${2:-./backups}"

if [ ! -f "$DB_PATH" ]; then
  echo "error: database not found at $DB_PATH" >&2
  echo "usage: $0 [DB_PATH] [DEST_DIR]" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST_DIR/cairndex-$STAMP.db"

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
