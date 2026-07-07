# Cairndex

Cairndex is a local-first, Eagle-inspired media asset manager for a personal
video/image library stored on local disks or NAS-mounted storage. It runs as a
self-hosted Docker app on a Linux NAS/server and is used from a browser.

In **Collection View**, the primary object is an **Asset Bundle** (cover + video
parts + alternate versions + subtitles + screenshots + attachments), not a
single file. Cairndex links existing files in place — it does not copy, move,
rename, or otherwise manage your files in the normal MVP path. A separate
**File View** browses the underlying directories and files inside the active
Cairndex library.

See [docs/product-brief.md](docs/product-brief.md) for the product model and
[AGENTS.md](AGENTS.md) for the canonical engineering rules that govern coding
agents working in this repository.

## Status

Cairndex is past the project-foundation phase. It provides an Eagle-inspired
desktop web browser over asset bundles: portable per-library metadata,
hierarchical **Collections**, a read-only physical **File View**, hierarchical
tags + tag groups, filtering and Smart Collections, scan/probe/thumbnail/
storyboard jobs with high-confidence moved-file repair, and a hardened
single-container production deployment. Media playback runs in a unified
custom **media viewer** — a hand-built video player (auto-hiding controls,
keyboard map, speed, PiP, fullscreen, snapshot, MediaSession) with subtitle
tracks, **seek-bar storyboard trickplay** and chapter ticks, and **watch
progress / resume** — plus a fullscreen image lightbox.

Cairndex is now built around portable, Eagle-like **libraries** (ADR-0008):
each library is a directory carrying its own `.cairndex/` metadata
(`manifest.json`, `library.db`, `cache/`), and a separate server-side
**registry** tracks registered libraries and the job queue. All content APIs are
scoped to one library (`/api/v1/libraries/{id}/…`); the desktop app picks an
active library per tab. The normal maintenance flow is **Update**: scan the
library, persist a reviewable grouping plan, collect technical metadata, refresh
the UI, and open grouping review when suggestions exist. Individual scan,
metadata collection, and grouping-review actions remain in the maintenance
menu. There are no global storage-root content APIs in the current model.

The app is still pre-1.0 and should not be exposed directly to the public
internet. Important follow-ups include single-owner authentication, richer
edit-before-apply grouping review, File View write-mode and desktop-client
integration, cross-filesystem repair candidates, and media
fallback/remux/transcoding. Job progress bars, large-library browse indexing, and
whole-library indexed text search (SQLite FTS5) are now implemented. See
[docs/STATUS.md](docs/STATUS.md) for the current milestone, known gaps, and
recommended next tasks.

## Repository layout

```text
apps/
  server/   # FastAPI backend (Python 3.12+, SQLAlchemy, SQLite, ffmpeg)
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

- [docs/product-brief.md](docs/product-brief.md) — product model, domain concepts, UI direction, and first-release anti-goals
- [AGENTS.md](AGENTS.md) — canonical agent operating rules and engineering constraints
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/data-model.md](docs/data-model.md)
- [docs/filter-language.md](docs/filter-language.md)
- [docs/performance.md](docs/performance.md) — large-library benchmark tooling and baselines
- [docs/adr/](docs/adr/) — Architecture Decision Records
- [docs/STATUS.md](docs/STATUS.md) — current milestone and known issues
- [CHANGELOG.md](CHANGELOG.md)

## License

All rights reserved.
