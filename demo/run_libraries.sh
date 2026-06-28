#!/usr/bin/env bash
# ADR-0008 demo: create a library, drop media in it, scan, then browse — the
# per-library create → scan → browse flow, end to end over the API.
#
#   ./demo/run_libraries.sh
#
# Starts the backend (with the in-process worker) against a throwaway registry
# DB, then:
#   1. creates a brand-new library (builds <root>/.cairndex/manifest.json,
#      library.db, and cache/),
#   2. drops a couple of fake media files into the library root,
#   3. enqueues a scan job (registry queue) and waits for the worker,
#   4. browses the library's bundles (now populated from the scan),
#   5. shows the on-disk package layout.
#
# All content is per-library: bundles/files live in that library's own
# library.db, with library-relative paths (no storage_roots).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export CAIRNDEX_DATA_DIR="$WORK/app-data"      # registry.db lives here
LIB="$WORK/MoviesLibrary"
mkdir -p "$LIB/Films"

cd "$REPO_ROOT/apps/server"

cleanup() {
  echo
  echo "==> Stopping server and removing the demo workspace…"
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "==> Starting backend with worker (registry DB at $CAIRNDEX_DATA_DIR/registry.db)"
uv run uvicorn cairndex.main:app --port 8000 --log-level warning &
SERVER_PID=$!

echo "==> Waiting for health…"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1 && break
  sleep 0.5
done

api() { curl -sf -H 'content-type: application/json' "$@"; }
base="http://127.0.0.1:8000/api/v1"

echo
echo "==> 1) Create a library at $LIB"
LIB_ID=$(api -X POST "$base/libraries/create" \
  -d "{\"root_path\": \"$LIB\", \"display_name\": \"Movies\"}" \
  | uv run python -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "    library id: $LIB_ID"

echo
echo "==> 2) Drop fake media into the library root"
printf 'fake video' > "$LIB/Films/movie.mp4"
printf 'fake image' > "$LIB/Films/cover.jpg"
ls -1 "$LIB/Films"

echo
echo "==> 3) Enqueue a scan and wait for the worker"
api -X POST "$base/libraries/$LIB_ID/jobs/scan" >/dev/null
for _ in $(seq 1 40); do
  total=$(api "$base/libraries/$LIB_ID/bundles/counts" \
    | uv run python -c "import sys,json; print(json.load(sys.stdin)['all'])")
  [[ "$total" -gt 0 ]] && break
  sleep 0.25
done

echo
echo "==> 4) Browse the library — bundles discovered by the scan"
api "$base/libraries/$LIB_ID/bundles/browse?sort=title&order=asc" \
  | uv run python -c "import sys,json; p=json.load(sys.stdin); print(f\"total={p['total']}\"); [print(' -', b['title'], '·', b['extension']) for b in p['items']]"

echo
echo "==> 5) On-disk package layout"
find "$LIB/.cairndex" -maxdepth 2 | sort

echo
echo "==> Done. The library's bundles/files live in $LIB/.cairndex/library.db;"
echo "    the registry only tracks where the library is and its scan jobs."
