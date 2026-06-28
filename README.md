# Cairndex

Cairndex is a local-first, Eagle-inspired media asset manager for a private
video/image library stored on local disks or NAS-mounted storage. It runs as a
self-hosted Docker app on a Linux NAS/server and is used from a browser.

In **Collection View**, the primary object is an **Asset Bundle** (cover + video
parts + alternate versions + subtitles + screenshots + attachments), not a
single file. Cairndex links existing files in place — it does not copy, move,
rename, or otherwise manage your files in the normal MVP path. A separate
**File View** browses the underlying configured storage-root directories.

See [AGENTS.md](AGENTS.md) for the full product brief and canonical engineering
rules that govern this repository.

## Status

Cairndex is past the project-foundation phase. The `main` branch currently
contains the Phase 0–8 MVP foundation: core domain schema and storage-root CRUD,
scan/probe/thumbnail jobs, an Eagle-inspired desktop web browser, filtering and
Smart Collections, direct playback with subtitle tracks, one-way Eagle import,
and a hardened single-container production deployment.

The first major refactor has merged to `main`: logical folders became
hierarchical **Collections**, a read-only physical **File View** was added over
storage roots, the scanner repairs high-confidence moved files while preserving
bundle metadata, and Collection View / File View share one active-library
selector.

The current branch (`feat/per-library-metadata`) begins the move to portable,
Eagle-like **libraries** — each a directory carrying its own `.cairndex/`
metadata (`manifest.json`, `library.db`, `cache/`) — backed by a separate
server-side **registry** (ADR-0008). This first PR adds the registry and the
`GET/POST /api/v1/libraries…` management endpoints; routing content APIs under
`/libraries/{id}` and collapsing the storage-root schema come in later PRs.

The app is still pre-1.0 and should not be exposed directly to the public
internet. Important follow-ups include single-owner authentication, server-side
text search/FTS, browse-query performance/indexing, scheduled scans,
File View write-mode and desktop-client integration, cross-filesystem repair
candidates, and media fallback/remux/transcoding. See [docs/STATUS.md](docs/STATUS.md)
for the current milestone, known gaps, and recommended next tasks.

## Repository layout

```text
apps/
  server/   # FastAPI backend (Python 3.12+, SQLAlchemy, Alembic, SQLite/WAL)
  web/      # React + TypeScript frontend (Vite, TanStack Query/Virtual)
docs/
  adr/                # Architecture Decision Records
  reference/eagle/    # Eagle UI reference screenshots (not committed media)
infra/
  docker/   # Dockerfiles for local/dev and NAS deployment
```

## Quickstart (local development)

Requirements: uv (manages Python 3.12+ for you) and Node.js 20+. See
[docs/development.md](docs/development.md) for full setup, environment variables,
and troubleshooting.

```bash
# Backend — installs Python 3.12 automatically via uv, runs on :8000
cd apps/server
uv sync
uv run uvicorn cairndex.main:app --reload

# Frontend — runs on :5173, proxies /api to the backend
cd apps/web
npm install
npm run dev
```

Health check: `curl http://localhost:8000/api/v1/health`

## Quickstart (Docker)

```bash
docker compose up --build
```

This starts the backend (`:8000`) and frontend dev server (`:5173`). Requires
Docker with the Compose v2 plugin (Docker Desktop on macOS, or `docker-ce` +
`docker-compose-plugin` on Linux). See [docs/deployment.md](docs/deployment.md)
for NAS deployment notes and `docker-compose.prod.yml` for the hardened
single-container production stack.

## Documentation

- [AGENTS.md](AGENTS.md) — canonical product brief and engineering rules
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/data-model.md](docs/data-model.md)
- [docs/filter-language.md](docs/filter-language.md)
- [docs/adr/](docs/adr/) — Architecture Decision Records
- [docs/STATUS.md](docs/STATUS.md) — current milestone and known issues
- [CHANGELOG.md](CHANGELOG.md)

## License

Private project. No license is granted for redistribution.
