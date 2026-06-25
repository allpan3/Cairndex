# Development guide

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| [`uv`](https://docs.astral.sh/uv/) | Backend dependency + Python version management | Installs Python 3.12 for you even though the host may ship an older system Python. |
| Node.js 20+ | Frontend tooling | `npm` ships with Node; no separate package manager required. |
| Docker + Compose v2 plugin | Optional, for the containerized dev stack | macOS: install Docker Desktop. Linux: `docker-ce` + `docker-compose-plugin`. |
| `ffmpeg` / `ffprobe` | Media probing/thumbnailing | Not required until Phase 2. macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt install ffmpeg`. |

Cairndex is developed on macOS and deployed on Linux; avoid macOS-only or
Linux-only assumptions in code (path separators, case sensitivity, process
APIs).

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
```

## Running both together without Docker

Run the two `dev` commands above in separate terminals. The Vite dev server
proxies `/api/*` to `http://localhost:8000` (see `apps/web/vite.config.ts`),
so the frontend never needs CORS configuration in development.

## Running with Docker

```bash
docker compose up --build
```

Starts the backend on `:8000` and the frontend dev server on `:5173` with
source bind-mounted for live reload. This is a development convenience, not
the NAS production deployment shape — see `docs/deployment.md`.

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
