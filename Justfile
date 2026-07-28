# Cairndex task runner. Run `just` on its own to list everything.
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

default:
    @just --list

# ---------------------------------------------------------------- development --

# Backend on :8000 (live-reloading).
server:
    cd {{server_dir}} && uv run uvicorn cairndex.main:app --reload --port 8000

# Backend on :8000, trusting the `tauri dev` webview origin. Use with `just desktop`.
server-desktop:
    cd {{server_dir}} && CAIRNDEX_CORS_EXTRA_ORIGINS={{dev_origin}} \
      uv run uvicorn cairndex.main:app --reload --port 8000

# Frontend on :5173, proxying /api to :8000.
web:
    cd {{web_dir}} && npm run dev

# Backend + frontend together; Ctrl-C stops both.
dev:
    #!/usr/bin/env bash
    set -uo pipefail
    trap 'kill 0' EXIT INT TERM
    (cd {{server_dir}} && uv run uvicorn cairndex.main:app --reload --port 8000) &
    (cd {{web_dir}} && npm run dev) &
    wait

# Desktop shell against a live source server (run `just server-desktop` first).
desktop:
    cd {{desktop_dir}} && npm run tauri dev

# `tauri dev` — both desktop recipes below — serves the web app from Vite, which
# means React's development build and StrictMode's double render. That is fine
# for exercising behaviour, but it is not shipped performance: judge speed with
# `just release`.

# Desktop shell on its bundled sidecar, rebuilt if stale (dev frontend).
bundled:
    cd {{desktop_dir}} && npm run dev:bundled

# Run the optimized build without packaging it — for judging real performance.
release:
    cd {{desktop_dir}} && npx tauri build --no-bundle
    @echo ""
    @echo "→ open {{tauri_dir}}/target/release/cairndex-desktop"

# ---------------------------------------------------------------------- gates --

# Everything: server, web, desktop. What CI checks.
check: check-server check-web check-desktop

check-server:
    cd {{server_dir}} && uv run ruff format --check . \
      && uv run ruff check . \
      && uv run mypy src packaging \
      && uv run pytest -q

# `npm run typecheck` is `tsc -b`, not `tsc --noEmit`. The root tsconfig is
# solution-style (`"files": []` plus project references), so a plain `tsc
# --noEmit` type-checks *nothing* and exits 0 — this gate passed clean while CI
# failed on three type errors in test files. Build mode follows the references
# and is what `npm run build` (and therefore CI) actually enforces.
check-web:
    cd {{web_dir}} && npm run lint \
      && npm run format:check \
      && npm run typecheck \
      && npm run test

check-desktop:
    cd {{tauri_dir}} && cargo fmt --check \
      && cargo clippy --all-targets -- -D warnings \
      && cargo test

# ---------------------------------------------------------------------- tests --

test: test-server test-web test-desktop

test-server *ARGS:
    cd {{server_dir}} && uv run pytest {{ARGS}}

test-web *ARGS:
    cd {{web_dir}} && npx vitest run {{ARGS}}

test-desktop *ARGS:
    cd {{tauri_dir}} && cargo test {{ARGS}}

# Browser-only end-to-end tests (APIs intercepted; boots its own dev server).
e2e *ARGS:
    cd {{web_dir}} && npm run test:e2e:frontend -- {{ARGS}}

# End-to-end against a real backend. Needs `uv sync` and ffmpeg.
e2e-full *ARGS:
    cd {{web_dir}} && npm run test:e2e:fullstack -- {{ARGS}}

# ------------------------------------------------------------------ formatting --

# Auto-fix formatting and the lint rules that can be fixed.
fmt:
    cd {{server_dir}} && uv run ruff format . && uv run ruff check --fix .
    cd {{web_dir}} && npm run format
    cd {{tauri_dir}} && cargo fmt

# ------------------------------------------------------------------- artifacts --

# Regenerate openapi.json + the typed client. Run after any route change; commit both.
api:
    cd {{server_dir}} && uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
    cd {{web_dir}} && npm run gen:api

# Build the PyInstaller sidecar the desktop app bundles as its local server.
sidecar:
    cd {{server_dir}} && uv run python packaging/build_sidecar.py

# Package the desktop app (.app/.dmg). Requires a built sidecar.
build-desktop: sidecar
    cd {{desktop_dir}} && npm run tauri build

# Production SPA build.
build-web:
    cd {{web_dir}} && npm run build
