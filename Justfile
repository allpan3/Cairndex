# Cairndex task runner. `just` on its own prints the few you need; `just --list`
# shows everything, grouped.
#
# Requires `just` (brew install just). Recipes are thin wrappers around the real
# commands in docs/development.md — that document stays the explanation, this file
# is the shortcut. Nothing here is required to build or test the project.

set shell := ["bash", "-uc"]

server_dir := "apps/server"
web_dir := "apps/web"
desktop_dir := "apps/desktop"
tauri_dir := "apps/desktop/src-tauri"
# `tauri dev` serves the webview from this exact origin, which the backend must
# trust before the desktop shell can call it (see docs/development.md).
dev_origin := "http://127.0.0.1:5173"

# Only three of these are the answer most days, so a bare `just` points at them
# instead of dumping the lot.
#
# The three commands you actually need.
default:
    @echo ""
    @echo "  just dev      ← start here. Backend on :8000, frontend on :5173."
    @echo "  just check      everything CI checks (server, web, desktop)."
    @echo "  just fmt        auto-fix formatting across all three."
    @echo ""
    @echo "  just --list     everything else, grouped: start / check / docker / build."
    @echo ""

# ---------------------------------------------------------------------- start --

# Backend + frontend together; Ctrl-C stops both. The one to reach for.
[group('start')]
dev:
    #!/usr/bin/env bash
    set -uo pipefail
    server_port="${CAIRNDEX_DEV_SERVER_PORT:-8000}"
    web_port="${CAIRNDEX_DEV_WEB_PORT:-5173}"
    server_pid=""
    web_pid=""
    # Gracefully stop direct children without killing Uvicorn's worker
    shutdown() {
      status="$1"
      trap - EXIT INT TERM
      [[ -z "$server_pid" ]] || kill -TERM "$server_pid" 2>/dev/null || true
      [[ -z "$web_pid" ]] || kill -TERM "$web_pid" 2>/dev/null || true
      [[ -z "$server_pid" ]] || wait "$server_pid" 2>/dev/null || true
      [[ -z "$web_pid" ]] || wait "$web_pid" 2>/dev/null || true
      exit "$status"
    }
    trap 'shutdown 130' INT
    trap 'shutdown 143' TERM
    trap 'shutdown $?' EXIT
    (cd {{ server_dir }} && exec uv run uvicorn cairndex.main:app --reload --port "$server_port") &
    server_pid=$!
    (cd {{ web_dir }} && PORT="$web_port" VITE_API_PROXY_TARGET="http://localhost:$server_port" exec npm run dev -- --host 127.0.0.1 --strictPort) &
    web_pid=$!
    wait

# Backend on :8000 (live-reloading). Half of `just dev`, for a separate terminal.
[group('start')]
server:
    cd {{server_dir}} && uv run uvicorn cairndex.main:app --reload --port 8000

# Frontend on :5173, proxying /api to :8000. The other half of `just dev`.
[group('start')]
web:
    cd {{web_dir}} && npm run dev

# Backend on :8000, trusting the `tauri dev` webview origin. Use with `just desktop`.
[group('start')]
server-desktop:
    cd {{server_dir}} && CAIRNDEX_CORS_EXTRA_ORIGINS={{dev_origin}} \
      uv run uvicorn cairndex.main:app --reload --port 8000

# Desktop shell against a live source server (run `just server-desktop` first).
[group('start')]
desktop:
    cd {{desktop_dir}} && npm run tauri dev

# `tauri dev` — both desktop recipes — serves React's development build from Vite.
# The Tauri root omits StrictMode replay because abort/reissue can strand
# WKWebView startup requests; browser development still exercises it. Judge
# shipped performance with `just release`.

# Desktop shell on its bundled sidecar, rebuilt if stale (dev frontend).
[group('start')]
bundled:
    cd {{desktop_dir}} && npm run dev:bundled

# ---------------------------------------------------------------------- check --

# Everything: release metadata, server, web, desktop. What CI checks.
[group('check')]
check: check-release check-server check-web check-desktop

[group('check')]
check-release:
    python3 infra/release_version.py

[group('check')]
check-server:
    cd {{server_dir}} && uv run ruff format --check . \
      && uv run ruff check . \
      && uv run mypy src packaging \
      && uv run pytest -q

# `npm run typecheck` is `tsc -b`, not `tsc --noEmit`. The root tsconfig is
# solution-style (`"files": []` plus project references), so a plain `tsc
# --noEmit` type-checks *nothing* and exits 0 — this gate passed clean while CI
# failed on three type errors in test files. Build mode follows the references.
#
# `npm run build` is here too: type-checking the references is not the same as
# proving the bundle builds, and that used to be a separate recipe nobody ran.
#
# Lint, format, types, unit tests, and the production bundle.
[group('check')]
check-web:
    cd {{web_dir}} && npm run lint \
      && npm run format:check \
      && npm run typecheck \
      && npm run test \
      && npm run build

[group('check')]
check-desktop:
    cd {{tauri_dir}} && cargo fmt --check \
      && cargo clippy --all-targets -- -D warnings \
      && cargo test

# The full sweep is `just check`; these take arguments, e.g. `just test-web
# GroupingReview`.
#
# One stack's tests, with arguments.
[group('check')]
test-server *ARGS:
    cd {{server_dir}} && uv run pytest {{ARGS}}

[group('check')]
test-web *ARGS:
    cd {{web_dir}} && npx vitest run {{ARGS}}

[group('check')]
test-desktop *ARGS:
    cd {{tauri_dir}} && cargo test {{ARGS}}

# Browser-only end-to-end tests (APIs intercepted; boots its own dev server).
[group('check')]
e2e *ARGS:
    cd {{web_dir}} && npm run test:e2e:frontend -- {{ARGS}}

# End-to-end against a real backend. Needs `uv sync` and ffmpeg.
[group('check')]
e2e-full *ARGS:
    cd {{web_dir}} && npm run test:e2e:fullstack -- {{ARGS}}

# Exercise `just dev` itself and prove Ctrl-C releases an acquired lease.
[group('check')]
dev-smoke:
    cd {{ server_dir }} && uv run python ../../infra/dev_smoke.py

# Auto-fix formatting and the lint rules that can be fixed.
[group('check')]
fmt:
    cd {{server_dir}} && uv run ruff format . && uv run ruff check --fix .
    cd {{web_dir}} && npm run format
    cd {{tauri_dir}} && cargo fmt

# --------------------------------------------------------------------- docker --

# Needs a .env (`cp .env.example .env`). Ctrl-C stops it; see `docker-dev-down`.
#
# Containerized dev stack: API on :8000, Vite on :5173, both hot-reloading.
[group('docker')]
docker-dev *ARGS:
    docker compose up --build {{ARGS}}

# Without --volumes it keeps the registry DB, so registered libraries survive.
#
# Stop the dev stack (preferred over killing it: shutdown releases leases).
[group('docker')]
docker-dev-down *ARGS:
    docker compose down {{ARGS}}

# Real (tiny) generated media, so grouping, covers, and playback all work. For a
# large library to benchmark against, use devtools.synthetic_library instead.
#
# Seed a small scratch library for the dev stack at var/docker-library.
[group('docker')]
docker-dev-library *ARGS:
    ./infra/docker/dev-library.sh {{ARGS}}

# Same image the NAS runs; no source mount, no reload. Stop it with
# `docker compose -f docker-compose.prod.yml down`.
#
# Run the production stack locally, to check a deployment change before shipping.
[group('docker')]
docker-prod *ARGS:
    docker compose -f docker-compose.prod.yml up --build {{ARGS}}

# --load leaves it in the local daemon so you can `docker save` it; add a
# registry and swap --load for --push if you have somewhere to push it.
#
# Cross-build the production image for an amd64 NAS from this arm64 Mac.
[group('docker')]
docker-build-nas tag="cairndex:nas":
    docker buildx build --platform linux/amd64 \
      -f infra/docker/production.Dockerfile -t {{tag}} --load .
    @echo ""
    @echo "→ docker save {{tag}} | gzip | ssh nas 'gunzip | docker load'"

# Starts it against a throwaway library, creates one through the API, scans a
# generated video, and checks a graceful stop releases the lease. CI runs this.
#
# Prove the production image actually serves, not just that it builds.
[group('docker')]
docker-smoke:
    ./infra/docker/smoke.sh

# ---------------------------------------------------------------------- build --

# Regenerate openapi.json + the typed client. Run after any route change; commit both.
[group('build')]
api:
    cd {{server_dir}} && uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
    cd {{web_dir}} && npm run gen:api

# Run the optimized build without packaging it — for judging real performance.
[group('build')]
release:
    cd {{desktop_dir}} && npx tauri build --no-bundle
    @echo ""
    @echo "→ open {{tauri_dir}}/target/release/cairndex-desktop"

# Builds the PyInstaller sidecar first — the local server the app bundles.
#
# Package the desktop app (.app/.dmg).
[group('build')]
build-desktop:
    cd {{server_dir}} && uv run python packaging/build_sidecar.py
    cd {{desktop_dir}} && npm run tauri build
