# Development guide

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| `uv` | Backend dependency + Python version management | Installs Python 3.12 for you even though the host may ship an older system Python. |
| Node.js 20+ | Frontend tooling | `npm` ships with Node; no separate package manager required. |
| Docker + Compose v2 plugin | Optional, for the containerized dev stack | macOS: install Docker Desktop. Linux: `docker-ce` + `docker-compose-plugin`. |
| `ffmpeg` / `ffprobe` | Media probing, thumbnails, subtitle conversion | Required for full media behavior. macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt install ffmpeg`. |

Cairndex is developed on macOS and deployed on Linux; avoid macOS-only or
Linux-only assumptions in code (path separators, case sensitivity, process
APIs, filesystem identity reliability).

## Backend (`apps/server`)

```bash
cd apps/server
uv sync                 # creates .venv, installs locked deps + Python 3.12
uv run uvicorn cairndex.main:app --reload --port 8000
```

Checks (run from `apps/server`):

```bash
uv run ruff format --check .   # formatting
uv run ruff check .            # linting
uv run mypy src                # type checking
uv run pytest                  # tests
```

Auto-fix formatting/lint issues with `uv run ruff format .` and
`uv run ruff check --fix .`.

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
npm run build             # production SPA build
```

## Databases and local state

Cairndex now uses the ADR-0008 per-library model:

- the server-local registry DB lives under `CAIRNDEX_DATA_DIR` as
  `registry.db` and tracks registered libraries plus the runtime `job_queue`;
- each library is a directory with `.cairndex/manifest.json`,
  `.cairndex/library.db`, and `.cairndex/cache/`;
- content tables are created in each `library.db` via the current SQLAlchemy
  metadata bootstrap for this pre-1.0 phase;
- there is no current global content DB, no `storage_roots` content table, and no
  `asset_files.storage_root_id`.

For local manual testing, start the backend and frontend, open the app, use the
sidebar `+` to create or register a library directory, then run **Update**.
Update scans files, persists a grouping plan, collects ffprobe metadata,
refreshes the UI, opens grouping review when suggestions exist, and starts
missing/stale storyboard generation in the background. The maintenance overflow
menu exposes standalone **Scan new files**, **Suggest grouping**, **Collect
metadata**, and **Generate storyboards** actions.

When changing persistence models, update the relevant bootstrap/tests/docs in the
same branch. Do not assume an Alembic global-content migration chain is still the
active mechanism unless a new ADR reinstates one.

## Frontend API types (generated from OpenAPI)

The frontend's request/response types are generated from the backend's OpenAPI
schema so the two cannot drift. Regenerate after backend API changes:

```bash
# 1. dump the schema from the backend (apps/server)
uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
# 2. generate TypeScript types (apps/web)
npm run gen:api          # writes src/api/schema.d.ts
```

Both `openapi.json` and `schema.d.ts` are committed (generated, excluded from
lint/format). `gen:api` uses `npx openapi-typescript` rather than a pinned
devDependency because that tool's TypeScript peer range does not yet include
TS 6.

## Large-library performance tooling

To profile browse/query performance at scale, generate a synthetic library and
benchmark it (no real media is touched). See [performance.md](performance.md)
for the recorded baselines and the indexes/query rewrite they justify.

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

## Search index

Whole-library text search uses a per-library SQLite FTS5 index (`bundle_search`)
kept fresh by triggers. It is created and first-populated automatically when a
library DB is opened. To rebuild it for one library (after a bulk external change
or to recover from drift):

```bash
uv run python -m cairndex.devtools.reindex_search --library-root /path/to/library
# or by registry id:
uv run python -m cairndex.devtools.reindex_search --library-id <id>
```

## Running both together without Docker

Run the backend and frontend dev commands above in separate terminals. The Vite
dev server proxies `/api/*` to `http://localhost:8000` (see
`apps/web/vite.config.ts`), so the frontend never needs CORS configuration in
development.

## Running with Docker

```bash
docker compose up --build
```

Starts the backend on `:8000` and the frontend dev server on `:5173` with source
bind-mounted for live reload. This is a development convenience, not the NAS
production deployment shape — see `docs/deployment.md`.

## Repository conventions

- One branch per feature/fix (see `AGENTS.md` §16). Branch from `main`.
- Conventional-style commit messages (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`).
- Update `CHANGELOG.md` under `Unreleased` and `docs/STATUS.md` in the same
  branch as any user-visible or operational change.
- Record consequential decisions in `docs/adr/` (see `docs/adr/README.md`).
- Do not commit source media, databases, caches, thumbnails, or secrets —
  enforced by `.gitignore`, but review diffs before pushing regardless.

## CI

`.github/workflows/ci.yml` runs on every push/PR: backend lint + type-check +
tests, frontend lint + type-check + unit tests, and a Docker image build
validation. PRs should be green before merge.
