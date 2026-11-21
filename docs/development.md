# Development guide

This guide covers setting up, running and testing Cairndex from a checkout. Reference
material lives in the topic documents:

- [architecture.md](architecture.md): how the server, web app and desktop shell fit together;
- [desktop.md](desktop.md): desktop shell behavior, menus, deep links and the bundled local server;
- [ci.md](ci.md): what CI runs, required checks and the publication privacy workflow;
- [deployment.md](deployment.md): container deployment, desktop distribution and releases;
- [performance.md](performance.md): benchmark baselines and storage measurements.

## Prerequisites

| Tool                       | Why                                            | Notes                                                                                                |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `uv`                       | Backend dependency + Python version management | Installs Python 3.12 for you even though the host may ship an older system Python.                   |
| Node.js 22                 | Frontend tooling                               | The version CI uses. `npm` ships with Node; no separate package manager required.                    |
| Stable Rust + Cargo        | Tauri 2 desktop host                           | Required only for `apps/desktop`; install with rustup and include `clippy` + `rustfmt`.               |
| Docker + Compose v2 plugin | Optional, for the containerized dev stack and for building the deployment image | macOS: install Docker Desktop. Linux: `docker-ce` + `docker-compose-plugin`. See [Running with Docker](#running-with-docker). |
| `ffmpeg` / `ffprobe`       | Media probing, thumbnails, subtitle conversion | Required for full media behavior. macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt install ffmpeg`. |

Cairndex is developed on macOS and deployed on Linux; avoid macOS-only or
Linux-only assumptions in code (path separators, case sensitivity, process
APIs, filesystem identity reliability).

## Backend (`apps/server`)

```bash
cd apps/server
uv sync                 # creates .venv, installs locked deps + Python 3.12
uv run uvicorn cairndex.main:app --reload --port 8000
```

`just dev` starts the server and Vite together. Ctrl-C targets the Uvicorn
reloader and waits for application shutdown to drain work and close private
stores. `just dev-smoke` creates a disposable portable library and verifies that
Ctrl-C releases its private process lock, with no SQLite in the library folder.

Checks (run from `apps/server`):

```bash
uv run ruff format --check .   # formatting
uv run ruff check .            # linting
uv run mypy src packaging      # type checking (packaging/ gates what ships)
uv run pytest                  # tests
```

Auto-fix formatting/lint issues with `uv run ruff format .` and
`uv run ruff check --fix .`.

Rules that are easy to miss when changing backend code:

- SQL-backed JSON dependencies use `Depends(..., scope="function")` so commit and
  rollback finish before response headers. Keep yielding parent dependencies in
  that scope too. Streaming handlers retain explicit session factories for short
  resolution scopes. FastAPI 0.121 is the minimum version for function scopes.
- SQLite writers share `persistence/sqlite_durability.py`. Use `connect_writable`
  for raw file writers and backup destinations; read-only URI connections and
  in-memory schema validators can use `sqlite3.connect`. See
  [ADR-0039](adr/0039-macos-sqlite-durability.md).
- A correlated lookup that compares a JSON expression index with a TEXT column,
  such as `json_extract(f.body, '$.bundle_id') = b.entity`, must write `+b.entity`.
  Otherwise the column's affinity makes SQLite scan every file row for each bundle.
  The plan test in `tests/test_catalog_browse.py` fails on such a scan.
- When changing persistence models, update the relevant bootstrap, tests and docs
  in the same branch. Do not assume an Alembic global-content migration chain is
  the active mechanism unless a new ADR reinstates one.
- Removing a library is metadata-only. It never deletes a folder, a `.cairndex/`
  package or a media file; physical deletion is a separate capability that does
  not exist.

## Frontend (`apps/web`)

```bash
cd apps/web
npm install
npm run dev              # http://localhost:5173, proxies /api to :8000
```

Checks (run from `apps/web`):

```bash
npm run lint              # eslint
npm run format:check      # prettier --check
npm run typecheck         # tsc --noEmit
npm run test              # vitest run
npm run test:e2e          # playwright (boots its own dev server)
npm run test:e2e:frontend # browser-only tests with intercepted APIs
npm run test:e2e:fullstack # real-backend tests; requires uv sync + ffmpeg
npm run build             # production SPA build
```

Local runs save an HTML report and exit on failure. Open it with
`npx playwright show-report` from `apps/web`.

CI keeps the frontend job Node-only and runs `@fullstack` Playwright tests in a
separate job that provisions the locked backend environment and ffmpeg.

### Frontend API types (generated from OpenAPI)

The frontend's request/response types are generated from the backend's OpenAPI
schema so the two cannot drift. Regenerate after backend API changes:

```bash
# 1. dump the schema from the backend (apps/server)
uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
# 2. generate TypeScript types (apps/web)
npm run gen:api          # writes src/api/schema.d.ts
```

Both `openapi.json` and `schema.d.ts` are committed (generated, excluded from
lint/format), so the web app, its type checks and the desktop build need no Python
environment. `just api` runs both steps. The backend test
`tests/test_generated_api.py` fails when `openapi.json` is stale, and the frontend
CI job regenerates `schema.d.ts` and fails on any difference. `gen:api` uses
`npx openapi-typescript` rather than a devDependency because that tool's
TypeScript peer range does not yet include TS 6; the script pins an exact version
so the generated file does not change with a new release.

## Running both together without Docker

Run the backend and frontend dev commands above in separate terminals, or use
`just dev`. Browser-mode Vite proxies `/api/*` to `http://localhost:8000` (see
`apps/web/vite.config.ts`), so it needs no CORS configuration. The Tauri host
uses the server URL stored by its first-run screen instead.

For a manual check, open the app, use the sidebar `+` to add a library
directory of synthetic media, then run **Update**. For portable libraries, Update
saves private observations and grouping suggestions and opens review when
suggestions exist; [replica-discovery.md](replica-discovery.md) describes the
review. Confirm afterwards that source bytes are unchanged.

## Desktop (`apps/desktop`)

The Tauri 2 shell hosts the same `apps/web` Vite development server and
production `dist`; there is no desktop frontend fork.

```bash
cd apps/desktop
npm install
npm run tauri dev
```

`tauri dev` gives you two ways to provide the server the frontend calls:

- **A standalone server you run from source** — the `:8000` uvicorn above, which
  the desktop connects to like any other server (enter `http://127.0.0.1:8000`
  on the first-run screen). It runs your **live** code under `--reload`, needs no
  rebuild, and lets the desktop and the web app share one server and one set of
  libraries. **Prefer this while iterating**, on the frontend or the server.
- **"This Computer" — the bundled sidecar**, which the shell spawns itself. This
  is the self-contained server end users get, but it is a **PyInstaller build of
  `apps/server` frozen at build time**. Run `just bundled` from the repository
  root: it rebuilds stale server code, detects stale signing and verifies that the
  linked FFmpeg/FFprobe still match the pinned cache. Use it to verify the
  self-contained application.

The dev webview's origin is Vite's `http://127.0.0.1:5173`, which is **not** one
of the packaged `tauri://` origins the backend trusts by default. The bundled
sidecar needs nothing: in development the shell starts it with
`CAIRNDEX_CORS_EXTRA_ORIGINS` set to that origin. A standalone server must opt the
origin in itself:

```bash
cd apps/server
CAIRNDEX_CORS_EXTRA_ORIGINS=http://127.0.0.1:5173 \
  uv run uvicorn cairndex.main:app --reload --port 8000
```

Leave that variable unset outside deliberate local development.

Desktop checks:

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cd ..
npm run tauri build
```

CI runs these Rust checks on both macOS and Ubuntu; only macOS bundles the app.
Two things catch people running them locally:

- **The desktop crate does not compile without the sidecar path.**
  `tauri.conf.json` stages `packaging/dist/cairndex-sidecar` as a bundle resource,
  and `tauri-build` copies resources at compile time, so `cargo check`,
  `cargo test` and `tauri dev` fail with `resource path
  ../../server/packaging/dist/cairndex-sidecar doesn't exist`. Build the sidecar
  (below) or, if you only need the Rust to compile, create the directory empty:
  `mkdir -p apps/server/packaging/dist/cairndex-sidecar`.
- **The Rust lifecycle test skips without a sidecar.** It spawns the real bundle
  only when `CAIRNDEX_SIDECAR_BIN` points at one, so set it locally or the test
  passes without proving anything:

  ```bash
  cd apps/desktop/src-tauri
  CAIRNDEX_SIDECAR_BIN=$PWD/../../server/packaging/dist/cairndex-sidecar/cairndex-sidecar \
    cargo test --locked
  ```

Keep native capabilities in cross-platform Tauri plugins, with any unavoidable
target-OS conditional isolated in one clearly named host module, and keep all
Tauri imports in `apps/web/src/platform/desktop.ts`. To change the menu bar or
shortcuts, edit `apps/web/src/platform/keymap.json`;
[desktop.md](desktop.md#menus-and-shortcuts) explains its rules.

## Local-server sidecar (`apps/server/packaging`)

The desktop app bundles the Python server as a PyInstaller one-dir build:

```bash
cd apps/server
uv run python packaging/fetch_ffmpeg.py       # pinned static binaries
uv run python packaging/build_sidecar.py      # -> packaging/dist/cairndex-sidecar/
uv run python packaging/smoke_test.py         # runs the bundle and drives it over HTTP
```

`build_sidecar.py --development` writes a checkout-local development build to
`packaging/dist/development/cairndex-sidecar/` and links the verified media tools
from the cache; never distribute that directory. On Linux, build with
`--skip-ffmpeg`, because that platform has no redistributable pin.

**Run the smoke test after any dependency change.** The unit suite imports from
source, where every module is present, so it cannot catch a frozen bundle that is
missing a dynamically resolved import. After any packaging or license change, also
verify the built app with
`./infra/verify_macos_distribution.sh apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app`.

For local macOS builds, opt into a persistent sidecar signing identity once:

```bash
cd apps/server
uv run python packaging/macos_signing.py create-local
```

It creates a non-exportable signing key in your default Keychain and keeps its
configuration outside the checkout, so rebuilt sidecars and apps keep one signing
identity. [desktop.md](desktop.md#local-server-sidecar) covers the sidecar's
contract with the shell, FFmpeg pinning and signing in detail.

## Running with Docker

The native loop above is the primary one. The containerized stack is the
alternative for when you want the deployment's environment rather than your
Mac's — checking Linux behavior, reproducing something a NAS does, or working
without a local `uv`/Node toolchain. Both halves hot-reload.

```bash
cp .env.example .env          # then set CAIRNDEX_DEV_LIBRARY_PATH
just docker-dev-library       # optional: seed a scratch library
just docker-dev               # == docker compose up --build
```

Backend on `:8000`, Vite on `:5173`. Source is bind-mounted: editing
`apps/server/src` restarts uvicorn, editing `apps/web/src` hot-updates the
browser. The stack installs ffmpeg/ffprobe, mounts `CAIRNDEX_DEV_LIBRARY_PATH` at
`/libraries/main`, keeps registry state in the `cairndex-dev-data` volume, and
watches only `src` for reloads.

- **Use a scratch library.** Point `CAIRNDEX_DEV_LIBRARY_PATH` at synthetic media,
  not a library another app is using: separate private stores do not serialize two
  servers' physical source operations. `just docker-dev-library` seeds
  `var/docker-library` with fourteen small generated clips, covers and subtitles.
  `devtools.synthetic_library` is not a substitute; it writes rows for files that
  do not exist.
- **The dev container has its own private data**, separate from the
  `apps/server/var` that native `just dev` uses, so the two never contend for one
  private registry. To run both at once, set `CAIRNDEX_DEV_API_PORT` /
  `CAIRNDEX_DEV_WEB_PORT` to free ports.
- **Stop it** with `just docker-dev-down`, which keeps the registry volume, or
  `just docker-dev-down --volumes` to discard it.
- **After a `uv.lock` or `package.json` change**, run
  `docker compose up --build --force-recreate`: `node_modules` lives in an
  anonymous volume that a plain `up --build` reuses.

`just docker-prod` runs the production image the NAS runs, and `just docker-smoke`
builds a fresh image and smoke-tests it against a throwaway library.
[deployment.md](deployment.md#verifying-an-image-actually-works) describes what the
smoke and image checks prove.

## Focused tests

Tests use generated synthetic fixtures only. Never point a test, option or
benchmark at an owner library, registry or private store, and keep generated
libraries and receipts out of Git. Run the full gates above before reporting a
branch complete; while working, these focused sets cover the riskier areas:

| Area | Backend (from `apps/server`) | Browser (from `apps/web`) |
| --- | --- | --- |
| Library migration and conversion | `tests/test_library_migration.py`, `tests/test_replica_catalog.py`, `tests/test_legacy_conversion*.py` | `e2e/legacy-conversion.spec.ts` |
| Portable Create/Open, access and recovery | `tests/test_replica_creation.py`, `tests/test_replica_recovery.py` | `npm run test:e2e` |
| Source operations and SMB | `tests/test_portable_source_*.py`, `tests/test_smb_*.py` | `e2e/source-operations.spec.ts` |
| Maintenance | `tests/test_replica_maintenance.py` | `e2e/catalog-maintenance.spec.ts` |
| Unindexed media in the File Browser | `tests/test_replica_path_media.py` | `e2e/catalog-path-media.spec.ts` |
| Private Unbundled | `tests/test_catalog_private_unbundled.py` | `e2e/catalog-private-unbundled.spec.ts` |
| Search | `tests/test_catalog_search_fields.py`, `tests/test_catalog_browse.py` | |
| Publication privacy gate | `tests/test_privacy_gate.py` | |

Model-fixture tests reuse the content schema but do not qualify public old-format
admission; use real portable API fixtures for admission, authorization, isolation
and serving-lifecycle checks. Fixture coverage of the current schema also does not
qualify historical releases or mounted storage, which need their own runs.

`tests/test_portable_source_binary.py` runs the HTTP review, identity, recovery
and restart path against source, or against a frozen sidecar named by
`CAIRNDEX_RECOVERY_TEST_BINARY`. To run it, the process-exit cases in
`test_portable_source_operations.py` and `e2e/source-operations.spec.ts` on a
disposable mounted share, set `CAIRNDEX_SOURCE_TEST_PARENT` to an explicitly
selected scratch directory on that share. Each test creates a fresh synthetic
library there; private SQLite stays in local test storage. Qualifying the packaged
sidecar's Keychain access needs its `authorize-smb` command (see
[deployment.md](deployment.md)); background work cannot request a prompt.

For distribution work, run the desktop launcher test with
`npm --prefix apps/desktop test` and the checks in
[desktop.md](desktop.md#signing) and
[deployment.md](deployment.md#verifying-an-image-actually-works).

Browser tests that change bundle files must wait for the window's save
acknowledgement as well as the server's new order, and search checks must wait
for replica admission before expecting browser controls. Wait for real completion
signals, not timeouts. A browser test with synthetic HTML drop events does not
qualify a Finder drop; test native OS delivery separately.

## Performance and storage tooling

To profile browse/query performance at scale, generate a synthetic library and
benchmark it; no real media is touched. [performance.md](performance.md) records
the baselines.

```bash
# From apps/server — generate a synthetic library on disk (fast bulk inserts)
uv run python -m cairndex.devtools.synthetic_library \
    --library-root /tmp/cairndex-synth \
    --bundles 100000 --files-per-bundle 1-5 \
    --collections 1000 --tags 2000 --seed 1234

# Time the hot paths; --explain dumps EXPLAIN QUERY PLAN, --json writes a report
uv run python -m cairndex.devtools.benchmark_queries \
    --library-root /tmp/cairndex-synth --iterations 20 --explain
```

`uv run python -m cairndex.devtools.benchmark_sqlite_durability` compares SQLite
durability policies on fresh synthetic temp databases; pass
`--storage smb --parent <scratch-directory>` for an already mounted test share. It
removes its own temporary directory and reports no paths.

Retained ORM fixtures keep a per-library `bundle_search` FTS5 index. To rebuild it
after a bulk external change, run
`uv run python -m cairndex.devtools.reindex_search --library-root <path>` or
`--library-id <id>`.

## Repository conventions

- One branch per feature/fix (see `AGENTS.md`). Branch from `main`.
- Conventional-style commit messages (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`).
- Update `CHANGELOG.md` under `Unreleased` and `docs/STATUS.md` in the same
  branch as any user-visible or operational change.
- Record consequential decisions in `docs/adr/` (see `docs/adr/README.md`).
- Do not commit source media, databases, caches, thumbnails, or secrets —
  `.gitignore` is only a convenience and is not a publication boundary.
- Install the repository's staged-content, commit-message, and pre-push privacy
  hooks once per clone with `just install-privacy-hooks`. Add known owner data to
  the untracked `cairndex-private-patterns` file in the clone's shared Git
  directory, which every linked worktree reads; the scanner never prints a
  matched literal. The scanner needs a Git whose `rev-list --objects -z` output
  is NUL-delimited: Git 2.54 has it, the Git 2.43 package in Ubuntu 24.04 does
  not, and on such a Git the scanner stops instead of passing (use the
  `git-core` PPA there).
- Keep the root `VERSION`, Python, npm, Cargo, lockfile, and Tauri versions in
  sync. `python3 infra/release_version.py` checks every source; passing
  `--tag vX.Y.Z` also checks the release tag. `/api/v1/health`, OpenAPI and
  **Settings → About** read the version from installed package metadata; the
  health schema accepts only a 7–64 character hexadecimal `CAIRNDEX_BUILD_COMMIT`
  because the endpoint is unauthenticated.

Before pushing ordinary branch work, run `just privacy-range origin/main HEAD`.
For a recreated repository, rewritten history, changed remote, first tag, or
first push of a ref, run `just privacy-history HEAD` instead. Before creating or
editing a PR, put the exact proposed title and body in files and run:

```bash
just privacy-pr origin/main /tmp/pr-title.txt /tmp/pr-body.md HEAD
```

`AGENTS.md` defines the full publication gate. PRs should be green before merge;
[ci.md](ci.md) describes what CI runs and which checks `main` requires.
