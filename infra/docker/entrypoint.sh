#!/usr/bin/env bash
# Production container entrypoint.
#
# Bring the database schema up to date before serving. Alembic is idempotent —
# on an existing volume it applies only new migrations, and on a fresh volume it
# creates the schema. Without this a brand-new deployment starts with an empty
# database and fails on first use (no such table: ...). Runs as the non-root
# app user against the /data volume it owns.
set -euo pipefail

cd /app
echo "==> Applying database migrations (alembic upgrade head)"
alembic upgrade head

# Hand off to the image CMD (uvicorn) as PID 1 so signals propagate cleanly.
exec "$@"
