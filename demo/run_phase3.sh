#!/usr/bin/env bash
# Phase 3 demo: seed a library and run BOTH the backend and the web UI, then
# open http://localhost:5173 (http, not https). Ctrl-C stops both.
#
#   ./demo/run_phase3.sh            # 2000 bundles (default)
#   ./demo/run_phase3.sh 500        # fewer bundles
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
uv run uvicorn cairndex.main:app --port 8000 > /tmp/cairndex-phase3-backend.log 2>&1 &
BACK=$!

cd "$REPO_ROOT/apps/web"
[ -d node_modules ] || npm install
echo "==> Starting web UI (:5173)"
npm run dev > /tmp/cairndex-phase3-web.log 2>&1 &
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
   Backend API + Swagger docs:
       http://localhost:8000/docs
   Logs: /tmp/cairndex-phase3-{backend,web}.log
   Press Ctrl-C to stop both.
  ──────────────────────────────────────────────────────────────

EOF

wait
