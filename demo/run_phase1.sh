#!/usr/bin/env bash
# Phase 1 interactive demo: seed a synthetic library into a throwaway database
# and serve the API so you can click around the Swagger UI.
#
#   ./demo/run_phase1.sh           # 300 bundles (default)
#   ./demo/run_phase1.sh 2000      # 2000 bundles
#
# Then open http://localhost:8000/docs and try, e.g., GET /api/v1/bundles,
# GET /api/v1/tags, GET /api/v1/folders. Ctrl-C to stop. The demo DB lives in
# apps/server/var/ (git-ignored) and can be deleted freely.
set -euo pipefail

BUNDLES="${1:-300}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/apps/server"

export CAIRNDEX_DATABASE_URL="sqlite:///$(pwd)/var/demo.db"
mkdir -p var
rm -f var/demo.db var/demo.db-wal var/demo.db-shm

echo "==> Applying migrations to a fresh demo database"
uv run alembic upgrade head

echo "==> Seeding $BUNDLES synthetic bundles (metadata only — no real media)"
uv run python -m cairndex.devtools.seed --bundles "$BUNDLES"

echo
echo "==> Starting the API. Open the interactive docs:"
echo "      http://localhost:8000/docs"
echo "    Try: GET /api/v1/bundles   GET /api/v1/tags   GET /api/v1/folders"
echo "    (Ctrl-C to stop)"
echo
exec uv run uvicorn cairndex.main:app --port 8000
