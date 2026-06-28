# Architecture

> Status: current through the Collections + read-only File View refactor branch.
> See `AGENTS.md` for the product brief and `docs/STATUS.md` for current gaps,
> validation state, and recommended next tasks.

## 1. System overview

Cairndex is a single-tenant, self-hosted application: one FastAPI backend
process, one SQLite database, a local cache directory for derived media
(thumbnails, converted subtitles, future transcodes), and a React frontend
served to a browser on the same LAN or a private overlay network such as
Tailscale.

The split backend/client model is important for future TV and remote viewing:
media and metadata live on a NAS/server, while different clients browse and play
the library from elsewhere. A desktop-only client could also operate directly on
an SMB-mounted library path, but the server model gives smoother shared metadata,
scanning, remote playback, and multi-client behavior.

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
services/    HTTP-agnostic business logic for bundles, tags, collections,
             filters, jobs, subtitles, file view, etc.
scanning/    storage-root scanning, fast-add, file classification, fingerprints
media/       ffprobe/ffmpeg adapters, thumbnailing, playback/subtitle helpers
jobs/        DB-backed job registry + worker loop
```

API routes currently cover health, storage roots, File View entries, bundles /
files, tags, tag groups, collections, Smart Collections, filter preview,
playback/subtitles, and jobs.

## 3. Frontend (`apps/web`)

The frontend is an Eagle-inspired dark, three-pane desktop UI:

```text
src/
  api/        typed client over /api/v1 (generated OpenAPI types) +
              TanStack Query hooks, including an infinite browse query
  app/        shell pieces: Sidebar, Toolbar, Browser, Inspector, BundleCard,
              FilterBuilder, CollectionPicker, SmartCollectionEditor, Player,
              LibraryManager, FileView, FileInspector, layouts
  state/      usePersistentState (localStorage for layout/zoom/pane widths)
  lib/        formatting helpers
```

Server state lives in TanStack Query. View state such as active browsing mode,
collection/system view, Smart Collection selection, bundle selection, File View
path selection, and toolbar search is local React state; durable browse
preferences persist to localStorage. Collection View's browser is virtualized
with TanStack Virtual over packed grid/list/justified rows so large loaded
windows stay responsive. A typed router remains deferred while the app is a
single shell with mode switches and modals.

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
streaming, probing, subtitle conversion, thumbnails, and File View listing.
Storage roots may be read-only or write-enabled in the schema, but current MVP
behavior is metadata-only and treats source media as immutable.

## 5. Domain model

The implemented schema is documented in `docs/data-model.md` and recorded in
ADR-0002/0003/0004/0006. The core object graph is:

- `StorageRoot` — server-visible mounted root with scan status/timestamps.
- `AssetBundle` — primary user-facing item shown in Collection View,
  browse/search/collections/tags.
- `AssetFile` — one physical file linked into one bundle by
  `storage_root_id + relative_path`, with role, media kind, order,
  availability, filesystem identity, fingerprint/hash placeholders, and
  technical metadata.
- `Tag` — hierarchical tag node using an adjacency list.
- `TagGroup` — navigational grouping independent of tag hierarchy.
- `Collection` — hierarchical virtual grouping (formerly "folder"); bundle
  membership is many-to-many and never moves files on disk. This is the logical
  surface (Collection View), distinct from physical File View directories.
- `SmartCollection` — saved, versioned filter AST plus optional view defaults
  (table still named `smart_folders`).
- `SubtitleTrack` — external subtitle file or embedded ffprobe stream linked to
  a video file.

Background jobs are no longer a content-DB model: the queue lives in the registry
DB as `JobQueueEntry` (`job_queue`), owned by the server (ADR-0008).

Current schema note: source/link metadata is implemented at the `AssetFile`
level as `source` (URL, `magnet:`, `ed2k:`, etc.). There is no first-class
bundle-level hyperlink column in the current MVP schema. If bundle-level source
pages become important, add them with an explicit migration rather than storing
ad hoc values in `extra_metadata`.

## 6. Scanning and media processing

`scan_storage_root()` walks a storage root, links classifiable media files,
updates existing rows by relative path, and marks disappeared files `missing`
instead of deleting metadata. It computes only the quick fingerprint (`size +
mtime`) plus cheap filesystem identity (`st_dev`/`st_ino`) used for moved-file
repair — never a full hash — commits in batches, and reports progress through
the job checkpoint hook. Before creating new bundles it repairs high-confidence
moves in place, preserving `AssetFile.id` and all bundle metadata; see ADR-0006.

`fast_add()` manually links selected files or directories and supports either
one bundle per file or a single bundle for the whole selection. It skips already
linked files and never mutates source media.

Media probing uses `ffprobe` through a thin adapter, normalizing duration,
container, codecs, dimensions, frame rate, stream counts, and embedded subtitle
metadata into `AssetFile.tech_metadata`. Thumbnail generation uses `ffmpeg` and
writes reproducible derived files under the app cache directory, outside any
storage root.

## 7. Filtering and Smart Collections

The filter system uses a canonical JSON AST (`version`, logical nodes, and
predicate nodes), not raw SQL. Incoming expressions are validated by Pydantic
and compiled through an allowlisted SQLAlchemy compiler with bound parameters.
The same compiler path powers live count preview, filtered browse, and saved
Smart Collection CRUD/browse.

The current Smart Collection editor exposes one Eagle-style all/any condition
group. The AST supports nested boolean groups for a later richer editor.

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

## 10. Eagle migration (removed)

Importing from an external Eagle library is **out of scope** and has been
removed. The former `eagle` reader/planner package, the `services.eagle`
importer, and the `import_records` table no longer exist. With the per-library
model (ADR-0008) a Cairndex library is its own portable directory, so content is
populated by scanning the library root rather than by migrating from another app.
ADR-0004 is retained as superseded history. Cairndex's UI remains
Eagle-*inspired* (see `docs/reference/eagle/`); only the import/migration feature
is gone.

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

## 11a. Library registry and per-library metadata (ADR-0008, in progress)

Cairndex is moving from one global content database to an Eagle-like
**per-library** model, kept compatible with the server/client split above. The
direction and the full phase plan are recorded in ADR-0008; this section
describes the shape and what has landed so far.

- A **library** is a directory containing a `.cairndex/` marker:
  `manifest.json` (format/uuid/display name), `library.db` (all of that
  library's content metadata), and `cache/` (portable derived media). The
  library travels with the folder.
- The server keeps a separate **registry** database at
  `{CAIRNDEX_DATA_DIR}/registry.db` (`cairndex.registry`), distinct from any
  library DB. It tracks registered libraries (path, availability, schema
  version) and owns the runtime job queue. It is server-local runtime state,
  never portable metadata.
- Library context is routed by path (`/api/v1/libraries/{library_id}/…`); the
  active library is a client concern, not a server-global setting.

How it works now:

- **Content lives per library.** Each `library.db` holds the full content schema
  (bundles, files, collections, tags, tag groups, smart collections,
  subtitles). There is no `storage_roots` table; `asset_files.relative_path`
  is relative to the library root and unique within the library. A
  `LibrarySession` dependency (`api/deps.py`) resolves `{library_id}` in the
  registry, refuses an unavailable library with 404, and yields a session from a
  per-library engine cache (`registry/library_engine.py`, keyed by id + resolved
  DB path so a moved library re-opens). Content services that touch the
  filesystem derive the library root from the session
  (`persistence.engine.library_root_for_session`).
- **All content APIs are under `/api/v1/libraries/{library_id}/…`** — bundles,
  collections, tags, tag-groups, smart-collections, filters, file-view, playback,
  fast-add, and scan/probe/thumbnail enqueue. The only global routes are health,
  the libraries registry, and job status.
- **Jobs are registry-owned.** The in-process worker drains the registry
  `job_queue`, reads each job's `library_id`, opens that library's DB, runs
  scan/probe/thumbnail against the library root, writes durable results into
  `library.db`, and writes progress/terminal state back to the registry row.
- **Frontend** picks one active library per tab (bootstrapped from
  `GET /api/v1/libraries`) and routes every content request under it; the sidebar
  has a library selector and a Scan action.

Eagle import has been removed entirely (see §10). Remaining ADR-0008 work:
`.cairndex/cache` relocation (phase 8) and optimistic-concurrency versions
(phase 9).

## 12. Browsing surfaces: Collection View and File View

Cairndex has two distinct browsing surfaces:

- **Collection View** — logical, metadata-first, bundle-based. The visible item
  is an `AssetBundle`; Collections are hierarchical virtual groupings and a
  bundle may belong to zero or many. Collection membership never moves files.
- **File View** — physical, filesystem-first, storage-root-scoped. The visible
  items are real directories and files under a configured storage root. The
  first milestone is read-only.

The read-only File View backend is `services/file_view.py`, exposed as
`GET /api/v1/storage-roots/{root_id}/entries?path=...`:

- input is only `storage_root_id + relative_path` (omitted = the root itself),
  never an absolute server path; absolute paths, traversal attempts, NUL bytes,
  and symlink escapes are rejected via `core.paths` and a per-entry real-path
  containment check;
- hidden entries are excluded (dotfiles/dot-directories cover `.git`, `.DS_Store`,
  `.env`, etc., plus a small denylist of non-dot cruft like `__pycache__`,
  `node_modules`, `Thumbs.db`);
- directories are returned first, then files, each sorted case-insensitively;
- each entry carries name, relative path, kind (directory/file), size, modified
  time, extension, a cheap MIME guess, the app's media classification, a
  `supported` flag (can the app preview/play it natively), and a cheap
  `linked`/`bundle_id` hint when the exact path is already linked into a bundle;
- it never moves, renames, deletes, or rewrites anything.

On the frontend, a sidebar mode toggle ("Collections" / "Files") switches the
center pane between the virtualized bundle browser and `FileView` — a library
selector + breadcrumbs + a directory/file table with `openable`, `unsupported`,
and `linked` badges, plus loading/empty/error states (including a friendly "this
library is currently unavailable" state when a root's directory is offline or
moved). File View selection is kept entirely separate from Collection/bundle
selection, and the right pane shows `FileInspector` (path/size/mtime/MIME/
openable/linked facts) — not the bundle inspector — so a filesystem entry is
never mistaken for a bundle. There are no move/rename/delete controls in this
milestone.

Storage roots are presented in the UI as **Libraries** (`LibraryManager`): add
one by absolute server path with directory autocomplete and an optional
"create if missing" toggle, and see each library's available/unavailable status.
Autocomplete is backed by `GET /api/v1/storage-roots/path-suggestions`, which
lists *directories only* (capped, dotfiles skipped) that the server process can
see — host filesystem, or only up to the image root inside a container. Because
that lists directories outside any storage root, it is **owner-configuration
tooling**, consistent with the single-owner, no-public-internet stance (§11); it
never returns file contents and creating a library directory is the only write
the otherwise metadata-only app performs.

No write endpoints exist yet. The module funnels all resolution through the
storage-root allowlist so later write-mode operations can share path validation.
ADR-0007 records the product nuance: the split server/client model primarily
enables future TV and remote viewing, while desktop file actions are more
naturally macOS/native-client features than normal web-client capabilities.

## 13. Known architectural debt

These are the most important architecture follow-ups after the current branch:

- update/rebase `feat/collections-and-file-view` against current `main` before
  merge;
- server-side text search / SQLite FTS5 and removal of client-side-only toolbar
  search;
- browse-summary query optimization and query-pattern indexes for larger
  libraries;
- first-class merge/split/move-file workflows for multi-file bundles;
- cross-filesystem moved-file repair and candidate suggestions for ambiguous
  cases (same-volume repair is implemented — ADR-0006);
- scheduled scans and stronger scan/probe/thumbnail job scheduling;
- safe File View write mode plus desktop-client integration (ADR-0007);
- single-owner authentication before real remote exposure;
- remux/transcode fallback and embedded subtitle extraction for unsupported
  browser playback cases.
