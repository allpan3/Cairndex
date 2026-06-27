# Architecture

> Status: current through Phase 8. This document summarizes what is implemented
> on `main`; see `AGENTS.md` for the product brief and `docs/STATUS.md` for
> current gaps and recommended next tasks.

## 1. System overview

Cairndex is a single-tenant, self-hosted application: one FastAPI backend
process, one SQLite database, a local cache directory for derived media
(thumbnails, converted subtitles, future transcodes), and a React frontend
served to a browser on the same LAN or a private overlay network such as
Tailscale.

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

No component copies, moves, renames, deletes, or rewrites files under a storage
root in the normal MVP path. The database stores `storage_root_id +
relative_path` for linked files, never a client-supplied unrestricted absolute
path.

## 2. Backend (`apps/server`)

The backend is a FastAPI app with a versioned `/api/v1` surface. `create_app()`
registers structured error handlers, includes all v1 routers, starts the
in-process worker during lifespan when enabled, and optionally mounts the built
SPA when `CAIRNDEX_STATIC_DIR` points at a frontend build.

Implemented layering:

```text
api/         FastAPI routers and request/response schemas
core/        config, app factory, time, errors, path-safety helpers
persistence/ SQLAlchemy models, engine/session setup, Alembic migrations
domain/      enum/domain definitions
services/    HTTP-agnostic business logic for bundles, roots, tags, folders,
             filters, jobs, subtitles, Eagle import, etc.
scanning/    storage-root scanning, fast-add, file classification, fingerprints
media/       ffprobe/ffmpeg adapters, thumbnailing, playback/subtitle helpers
jobs/        DB-backed job registry + worker loop
```

API routes currently cover health, storage roots, bundles/files, tags, tag
groups, folders, Smart Folders, filter preview, playback/subtitles, Eagle
import, and jobs.

## 3. Frontend (`apps/web`)

The frontend is an Eagle-inspired dark, three-pane desktop UI:

```text
src/
  api/        typed client over /api/v1 (generated OpenAPI types) +
              TanStack Query hooks, including an infinite browse query
  app/        shell pieces: Sidebar, Toolbar, Browser, Inspector, BundleCard,
              FilterBuilder, SmartFolderEditor, Player, EagleImport, layouts
  state/      usePersistentState (localStorage for layout/zoom/pane widths)
  lib/        formatting helpers
```

Server state lives in TanStack Query. View state such as selection, active
folder/system view, Smart Folder selection, and toolbar search is local React
state; durable browse preferences persist to localStorage. The browser is
virtualized with TanStack Virtual over packed grid/list/justified rows so large
loaded windows stay responsive. A typed router remains deferred while the app is
a single browse surface with modals.

## 4. Storage and path safety

A `StorageRoot` is an owner-configured, server-visible absolute directory. Its
`canonical_path` is validated and stored on the server; clients identify roots
by stable IDs and linked files by root-relative paths.

All externally influenced file paths must pass through `core.paths`:

- `normalize_relative_path()` rejects empty paths, absolute paths, Windows drive
  and UNC forms, null bytes, and `..` traversal, then stores a clean POSIX
  relative path.
- `resolve_within_root()` resolves a normalized relative path under a canonical
  root and rejects symlink escapes outside the root.

Services re-resolve paths at access time for sensitive operations such as
streaming, probing, subtitle conversion, and thumbnails. Storage roots may be
read-only or write-enabled in the schema, but current MVP behavior is
metadata-only and treats source media as immutable.

## 5. Domain model

The implemented schema is documented in `docs/data-model.md` and recorded in
ADR-0002/0003/0004. The core object graph is:

- `StorageRoot` — server-visible mounted root with scan status/timestamps.
- `AssetBundle` — primary user-facing item shown in browse/search/folders/tags.
- `AssetFile` — one physical file linked into one bundle by
  `storage_root_id + relative_path`, with role, media kind, order,
  availability, fingerprint/hash placeholders, and technical metadata.
- `Tag` — hierarchical tag node using an adjacency list.
- `TagGroup` — navigational grouping independent of tag hierarchy.
- `Folder` — hierarchical virtual collection; bundle membership is many-to-many.
- `SmartFolder` — saved, versioned filter AST plus optional view defaults.
- `SubtitleTrack` — external subtitle file or embedded ffprobe stream linked to
  a video file.
- `ImportRecord` — provider/external ID mapping for idempotent imports.
- `Job` — DB-backed queued/running/terminal background job.

Current schema note: source/link metadata is implemented at the `AssetFile`
level as `source` (URL, `magnet:`, `ed2k:`, etc.). There is no first-class
bundle-level hyperlink column in the current MVP schema. If bundle-level source
pages become important, add them with an explicit migration rather than storing
ad hoc values in `extra_metadata`.

## 6. Scanning and media processing

`scan_storage_root()` walks a storage root, links classifiable media files,
updates existing rows by relative path, and marks disappeared files `missing`
instead of deleting metadata. It computes only the quick fingerprint used by the
MVP scan path (`size + mtime`), commits in batches, and reports progress through
the job checkpoint hook.

`fast_add()` manually links selected files or directories and supports either
one bundle per file or a single bundle for the whole selection. It skips already
linked files and never mutates source media.

Media probing uses `ffprobe` through a thin adapter, normalizing duration,
container, codecs, dimensions, frame rate, stream counts, and embedded subtitle
metadata into `AssetFile.tech_metadata`. Thumbnail generation uses `ffmpeg` and
writes reproducible derived files under the app cache directory, outside any
storage root.

## 7. Filtering and Smart Folders

The filter system uses a canonical JSON AST (`version`, logical nodes, and
predicate nodes), not raw SQL. Incoming expressions are validated by Pydantic
and compiled through an allowlisted SQLAlchemy compiler with bound parameters.
The same compiler path powers:

- live count preview at `POST /api/v1/filters/preview`;
- filtered browse at `POST /api/v1/bundles/browse`;
- saved Smart Folder CRUD and browse.

The current Smart Folder editor exposes one Eagle-style all/any condition group.
The AST supports nested `and`/`or`/`not` groups for a later richer editor.

Current gap: toolbar text search in the frontend filters the already-loaded
client-side page/window by title. Server-side text search and SQLite FTS5 are
not implemented yet.

## 8. Playback and subtitles

Direct playback is implemented around a per-bundle manifest:

- `GET /api/v1/bundles/{id}/playback` lists videos, playability, stream URLs,
  dimensions/duration, and subtitle tracks.
- `GET /api/v1/files/{id}/stream` resolves the path safely and serves the file
  with Starlette/FastAPI `FileResponse`, including HTTP Range behavior.
- `GET /api/v1/subtitles/{id}/vtt` serves external SRT/VTT subtitles as cached
  browser-native WebVTT.

Playability is conservative: unsupported or unreliable containers/codecs are
reported as fallback states instead of pretending the browser can play every
file. Embedded subtitle streams are detected and represented as tracks, but
embedded extraction/remux/transcode fallback is deferred.

## 9. Background jobs

A `jobs` table backs a lightweight in-process worker (ADR-0001). The API enqueues
jobs and exposes status/progress/cancellation endpoints. The worker polls the
oldest queued job, marks it running, calls a registered handler, and marks a
terminal status. Handlers report progress through `JobContext.checkpoint()`,
which commits progress and observes cooperative cancellation.

This is intentionally single-process/single-worker for the SQLite MVP. Scaling
is by process supervision and tighter scheduling, not Redis/Celery.

## 10. Eagle migration

The Eagle importer is one-way, read-only, and idempotent:

- `eagle.reader` parses an Eagle `.library` directory without writing to it.
- `eagle.planner` produces a dry-run report with counts and advisory merge
  suggestions.
- `services.eagle.import_library()` registers the Eagle `images/` directory as a
  read-only storage root, creates/reuses folders/tags/tag groups, maps each new
  live Eagle item to one bundle + linked file, and records `ImportRecord` rows
  so reruns skip existing items.

Applying merge suggestions in-app is a follow-up; imports currently preserve
safety by not auto-merging destructively.

## 11. Deployment topology

Development uses `docker-compose.yml` with separate backend and Vite frontend
containers or the local quickstart commands from `README.md`.

Production uses `infra/docker/production.Dockerfile` plus
`docker-compose.prod.yml`: a multi-stage image builds the frontend, installs the
backend, runs as non-root UID 10001, includes `ffmpeg`/`ffprobe`, applies
Alembic migrations on startup, serves the built SPA from FastAPI, mounts app
data at `/data`, and mounts media read-only at `/storage/media` by default.

There is no application authentication yet. Production compose binds to
`127.0.0.1` by default and is intended to sit behind a private network/Tailscale
or an authenticating reverse proxy, not the public internet.

## 12. Known architectural debt

These are the most important architecture follow-ups after the Phase 0–8 MVP
foundation:

- server-side text search / SQLite FTS5 and removal of client-side-only toolbar
  search;
- browse-summary query optimization and query-pattern indexes for larger
  libraries;
- first-class merge/split/move-file workflows for multi-file bundles and Eagle
  merge suggestions;
- moved-file repair using path candidates, filename, size, timestamps, quick
  hashes, and optional full hashes;
- scheduled scans and stronger scan/probe/thumbnail job scheduling;
- single-owner authentication before real remote exposure;
- remux/transcode fallback and embedded subtitle extraction for unsupported
  browser playback cases.
