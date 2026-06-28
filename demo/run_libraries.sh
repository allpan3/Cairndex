#!/usr/bin/env bash
# ADR-0008 PR 1 demo: exercise the library registry over the API.
#
#   ./demo/run_libraries.sh
#
# Starts the backend with a throwaway registry DB, then:
#   1. creates a brand-new library (builds <root>/.cairndex/manifest.json,
#      library.db, and cache/),
#   2. lists registered libraries,
#   3. fetches the one we created,
#   4. registers a *second*, pre-existing library directory,
#   5. shows the on-disk package layout.
#
# Content APIs are unchanged in this PR; this only demonstrates the new
# server-side registry (a separate DB from any library's metadata).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export CAIRNDEX_DATA_DIR="$WORK/app-data"      # registry.db lives here
export CAIRNDEX_WORKER_ENABLED=false
LIB_A="$WORK/MoviesLibrary"
LIB_B="$WORK/ImagesLibrary"
mkdir -p "$LIB_A" "$LIB_B"

cd "$REPO_ROOT/apps/server"

cleanup() {
  echo
  echo "==> Stopping server and removing the demo workspace…"
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "==> Starting backend (registry DB at $CAIRNDEX_DATA_DIR/registry.db)"
uv run uvicorn cairndex.main:app --port 8000 --log-level warning &
SERVER_PID=$!

echo "==> Waiting for health…"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1 && break
  sleep 0.5
done

api() { curl -sf -H 'content-type: application/json' "$@"; }

echo
echo "==> 1) Create a new library at $LIB_A"
api -X POST http://127.0.0.1:8000/api/v1/libraries/create \
  -d "{\"root_path\": \"$LIB_A\", \"display_name\": \"Movies\"}"
echo

echo
echo "==> 2) List registered libraries"
api http://127.0.0.1:8000/api/v1/libraries
echo

echo
echo "==> 3) Register a pre-existing library (create the package, then register)"
# Build a package on disk without registering, to mimic an already-existing lib.
uv run python -c "from pathlib import Path; from cairndex.registry import library_package as p; p.create_package(Path('$LIB_B'), 'Images')"
api -X POST http://127.0.0.1:8000/api/v1/libraries/register \
  -d "{\"root_path\": \"$LIB_B\"}"
echo

echo
echo "==> 4) On-disk package layout"
find "$LIB_A/.cairndex" "$LIB_B/.cairndex" -maxdepth 2 | sort

echo
echo "==> Done. Both libraries are tracked in registry.db; their metadata lives"
echo "    in each library's own .cairndex/library.db."
