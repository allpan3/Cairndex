#!/usr/bin/env bash
# Phase 8 demo: build and run the *production* single-container stack, then open
# http://127.0.0.1:8000 — the API and the built SPA served from one hardened,
# non-root container (see docs/deployment.md / ADR-0005).
#
#   ./demo/run_phase8.sh            # 500 demo bundles (default)
#   ./demo/run_phase8.sh 2000       # more bundles
#
# Unlike the dev stack (docker-compose.yml, hot-reload), this is how Cairndex
# actually runs on a NAS: one image, frontend served by FastAPI, media mounted
# read-only, app-data in a named volume. Demo bundles are metadata-only (no real
# media), so thumbnails show a placeholder — that is expected. Scan a real
# storage root to get thumbnails.
set -euo pipefail

BUNDLES="${1:-500}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE=(docker compose -f docker-compose.prod.yml)
# No real media for the demo; mount the repo as a harmless read-only placeholder
# so compose has a valid bind source. Bind to localhost only.
export CAIRNDEX_LIBRARY_PATH="$REPO_ROOT"
export CAIRNDEX_BIND_ADDR=127.0.0.1
export CAIRNDEX_PORT=8000

cleanup() {
  echo
  echo "==> Stopping and removing the demo stack (the app-data volume is kept)…"
  "${COMPOSE[@]}" down || true
}
trap cleanup EXIT INT TERM

echo "==> Building and starting the production container (:8000)"
"${COMPOSE[@]}" up --build -d

echo "==> Waiting for health…"
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Seeding $BUNDLES demo bundles into the container's app-data volume"
"${COMPOSE[@]}" exec -T app python -m cairndex.devtools.seed --bundles "$BUNDLES"

cat <<EOF

  ──────────────────────────────────────────────────────────────
   Cairndex is running in PRODUCTION mode (single container).
       http://127.0.0.1:8000        (http — NOT https)
   One non-root container serves the API and the built SPA; media
   would be mounted read-only and app-data lives in a volume.
   Health:  http://127.0.0.1:8000/api/v1/health
   Back up: docker compose -f docker-compose.prod.yml exec app \\
              /app/infra/backup.sh /data/cairndex.db /data/backups
   Press Ctrl-C to stop and remove the stack.
  ──────────────────────────────────────────────────────────────

EOF

# Stream logs until interrupted.
"${COMPOSE[@]}" logs -f
