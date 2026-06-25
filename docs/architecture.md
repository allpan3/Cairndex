# Architecture

> Status: skeleton (Phase 0). Sections marked **TBD** are filled in by the
> milestone that introduces the relevant subsystem. See `AGENTS.md` for the
> product brief this architecture implements and `docs/STATUS.md` for the
> current milestone.

## 1. System overview

Cairndex is a single-tenant, self-hosted application: one FastAPI backend
process, one SQLite database, a local cache directory for derived media
(thumbnails, converted subtitles, future transcodes), and a React frontend
served to a browser on the same LAN (later Tailscale).

```text
┌──────────────┐       HTTP/JSON, /api/v1/*        ┌─────────────────────┐
│  apps/web    │ ─────────────────────────────────▶ │  apps/server        │
│  (React/Vite)│ ◀───────────────────────────────── │  (FastAPI)          │
└──────────────┘                                     │  ├─ API routes      │
                                                      │  ├─ domain services │
                                                      │  ├─ job worker      │
                                                      │  └─ media adapters  │
                                                      │     (ffmpeg/ffprobe)│
                                                      └──────────┬──────────┘
                                                                 │
                                          ┌──────────────────────┼─────────────────────┐
                                          ▼                      ▼                     ▼
                                 SQLite (WAL)            Cache dir (derived)   Storage roots (read,
                                 metadata only            thumbnails/subs       linked in place)
```

No component copies, moves, or rewrites files under a storage root. The
database stores `storage_root_id + relative_path`, never a client-supplied
absolute path (see §4 and `docs/data-model.md`).

## 2. Backend (`apps/server`)

Layering (enforced as the codebase grows past Phase 0's minimal shell):

```text
api/        FastAPI routers — request/response schemas only, no business logic
domain/     Pydantic/dataclass models + service classes (bundles, tags, folders, ...)
persistence/ SQLAlchemy models, repositories, Alembic migrations
scanning/   Storage-root scanning, fingerprinting, missing-file detection
media/      ffprobe/ffmpeg adapters, thumbnailing, subtitle conversion
jobs/       DB-backed job table + worker loop
core/       config, app factory, logging, path-safety helpers
```

Phase 0 only implements `core/` (app factory, settings) and a single
`api/v1/health` route. Everything else is **TBD** starting Phase 1.

## 3. Frontend (`apps/web`)

Phase 0 ships an app shell only (no routing, no data fetching beyond an
optional health check). The target shape, introduced incrementally from
Phase 3 onward:

```text
src/
  app/          router setup, layout shell (sidebar / toolbar / browser / inspector)
  features/     bundle browser, inspector, tag picker, folder tree, smart folders
  api/          generated/typed client over /api/v1, TanStack Query hooks
  components/   shared UI primitives (Radix-based)
```

## 4. Storage and path safety — **TBD (Phase 1)**

Will document: `StorageRoot` resolution, relative-path normalization,
symlink-escape prevention, and the rule that no API accepts a client-supplied
absolute path. See `AGENTS.md` §5 and §12 for the constraints this section
must satisfy.

## 5. Domain model — **TBD (Phase 1)**

See `docs/data-model.md` once schema work begins.

## 6. Scanning and media processing — **TBD (Phase 2)**

Will document the scan job lifecycle, fingerprint/hash strategy, and the
ffprobe/ffmpeg adapter boundary.

## 7. Filtering and Smart Folders — **TBD (Phase 5)**

See `docs/filter-language.md`.

## 8. Playback and subtitles — **TBD (Phase 6)**

## 9. Background jobs

A `jobs` table (introduced in Phase 2) backs an in-process worker — see
[ADR-0001](adr/0001-stack-and-database-choice.md) for why this replaces
Celery/Redis at this scale. Jobs are polled, not pushed; the worker runs in
the same process as the API server for the MVP.

## 10. Deployment topology

See `docs/deployment.md`. Summary: one Docker container (or two — server and
a static frontend build — composed together) on a Linux NAS, bind-mounting
storage roots read-only by default and a writable app-data volume for the
SQLite database and derived-media cache.
