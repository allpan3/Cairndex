#!/usr/bin/env bash
# Phase 5 demo: seed a library, run BOTH the backend and the web UI, then open
# http://localhost:5173 (http, not https) and try filtering + Smart Folders.
#
#   ./demo/run_phase5.sh            # 2000 bundles (default)
#   ./demo/run_phase5.sh 500        # fewer bundles
#
# Once it's up, click "+" next to SMART FOLDERS in the sidebar to build a
# filter (e.g. Rating >= 4): the live count uses POST /filters/preview, and
# saving it adds a Smart Folder that browses through POST /bundles/browse.
#
# Synthetic bundles are metadata-only (no real media), so thumbnails show a
# placeholder — that is expected. Scan a real storage root to get thumbnails.
set -euo pipefail

BUNDLES="${1:-2000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$REPO_ROOT/apps/server/var/demo.db"
export CAIRNDEX_DATABASE_URL="sqlite:///$DB"
export CAIRNDEX_WORKER_ENABLED=false

cd "$REPO_ROOT/apps/server"
mkdir -p var
rm -f var/demo.db var/demo.db-wal var/demo.db-shm

echo "==> Migrating + seeding $BUNDLES bundles into a fresh demo database"
uv run alembic upgrade head
uv run python -m cairndex.devtools.seed --bundles "$BUNDLES"

echo "==> Starting backend (:8000)"
uv run uvicorn cairndex.main:app --port 8000 > /tmp/cairndex-phase5-backend.log 2>&1 &
BACK=$!

cd "$REPO_ROOT/apps/web"
[ -d node_modules ] || npm install
echo "==> Starting web UI (:5173)"
npm run dev > /tmp/cairndex-phase5-web.log 2>&1 &
WEB=$!

cleanup() {
  echo
  echo "==> Stopping…"
  kill "$BACK" "$WEB" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -sf http://localhost:8000/api/v1/health >/dev/null 2>&1 &&
    curl -sf http://localhost:5173/ >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

cat <<EOF

  ──────────────────────────────────────────────────────────────
   Cairndex is running.  Open the library UI:
       http://localhost:5173        (http — NOT https)
   Try: sidebar → SMART FOLDERS → "+", build a filter, watch the
   live count, then save it as a Smart Folder.
   Backend API + Swagger docs:
       http://localhost:8000/docs
   Logs: /tmp/cairndex-phase5-{backend,web}.log
   Press Ctrl-C to stop both.
  ──────────────────────────────────────────────────────────────

EOF

wait
