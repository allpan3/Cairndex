#!/usr/bin/env bash
# Cairndex SQLite backup helper (AGENTS.md §12 / docs/deployment.md).
#
# Makes a consistent, hot copy of one SQLite database using SQLite's online
# backup API — safe to run while the app is writing (WAL mode), no downtime,
# never touches source media.
#
# Use this helper for the server registry. Portable private stores require the
# verified private recovery service; immutable history and media need separate
# backups. Restore the registry with restore.sh while the server is stopped.
set -euo pipefail

# A checkout can use the shared policy without installing the server package.
# Containers already have it installed, so their source-path fallback is unused.
cairndex_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/server/src"
if [[ -d "$cairndex_source_dir" ]]; then
  export PYTHONPATH="$cairndex_source_dir${PYTHONPATH:+:$PYTHONPATH}"
fi

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

# The legacy folder database has no supported backup workflow here.
if [[ "$(basename "$DB_PATH")" == "library.db" ]]; then
  echo "error: legacy library format is unsupported" >&2
  exit 1
fi
if [ -z "$BACKUP_LABEL" ]; then
  BACKUP_LABEL="$(basename "$DB_PATH" .db)"
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
import sys

from cairndex.persistence.sqlite_durability import connect_writable

src_path, dst_path = sys.argv[1], sys.argv[2]
src = connect_writable(src_path)
dst = connect_writable(dst_path)
with dst:
    src.backup(dst)
dst.close()
src.close()
PY

# Integrity-check the copy so a corrupt backup fails loudly rather than silently.
result="$(python3 - "$OUT" <<'PY'
import sys

from cairndex.persistence.sqlite_durability import connect_writable

conn = connect_writable(sys.argv[1])
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
