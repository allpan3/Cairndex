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
#   docker exec cairndex-app-1 /app/infra/backup.sh /libraries/main/.cairndex/library.db /data/backups
#   docker cp cairndex-app-1:/data/backups ./backups
#
# Restore through restore.sh while the app is STOPPED:
#   docker compose -f docker-compose.prod.yml down
#   docker run ... /app/infra/restore.sh --stopped BACKUP_PATH DB_PATH
#   docker compose -f docker-compose.prod.yml up -d
set -euo pipefail

DB_PATH="${1:-${CAIRNDEX_DATA_DIR:-/data}/registry.db}"
DEST_DIR="${2:-./backups}"
BACKUP_LABEL="${3:-}"

if [ ! -f "$DB_PATH" ]; then
  echo "error: database not found at $DB_PATH" >&2
  echo "usage: $0 [DB_PATH] [DEST_DIR] [BACKUP_LABEL]" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Library databases all share the basename `library.db`. Use the portable UUID
# from the adjacent manifest so backups from different libraries cannot collide
# or disclose an owner-chosen library name. A caller may supply a safe label for
# another database shape.
if [ -z "$BACKUP_LABEL" ]; then
  BACKUP_LABEL="$(python3 - "$DB_PATH" <<'PY'
import json
import re
import sys
from pathlib import Path

db_path = Path(sys.argv[1])
label = db_path.stem
manifest = db_path.with_name("manifest.json")
if db_path.name == "library.db" and manifest.is_file():
    try:
        library_uuid = str(json.loads(manifest.read_text(encoding="utf-8"))["library_uuid"])
    except (KeyError, OSError, ValueError) as exc:
        raise SystemExit(f"error: cannot read library UUID from {manifest}: {exc}") from exc
    if not re.fullmatch(r"[A-Za-z0-9-]+", library_uuid):
        raise SystemExit(f"error: unsafe library UUID in {manifest}")
    label = f"library-{library_uuid}"
print(label)
PY
)"
fi

if [[ ! "$BACKUP_LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "error: backup label must contain only letters, digits, dot, underscore, or hyphen" >&2
  exit 1
fi

# mktemp makes simultaneous or same-second backups unique and starts mode 0600.
OUT="$(mktemp "$DEST_DIR/${BACKUP_LABEL}-${STAMP}.db.XXXXXX")"
COMPLETE=false
cleanup() {
  if [ "$COMPLETE" != true ]; then
    rm -f "$OUT"
  fi
}
trap cleanup EXIT

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

COMPLETE=true
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
