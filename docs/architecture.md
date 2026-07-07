# Architecture

> Status: current through the media-player foundation M1–M4 (probe enrichment,
> the unified custom media viewer, storyboard trickplay, and watch
> progress/resume; PRs #1–#4 in this repo). See `AGENTS.md` for the product
> brief, `docs/plans/` for the client-platform roadmap, and `docs/STATUS.md`
> for current gaps, validation state, and recommended next tasks.

## 1. System overview

Cairndex is a single-owner, self-hosted web application. A FastAPI backend runs
on the server/NAS that can see the media library path; a React/Vite frontend runs
in the browser. Content metadata is **per library**, not server-global: each
library is a directory with a `.cairndex/` package containing its portable
manifest, content database, and derived-media cache. A separate server-local
registry tracks which libraries are known and owns the runtime job queue.

```text
┌──────────────┐       HTTP/JSON, /api/v1/*        ┌─────────────────────┐
│  apps/web    │ ─────────────────────────────────▶ │  apps/server        │
│  React/Vite  │ ◀───────────────────────────────── │  FastAPI            │
└──────┬───────┘                                     │  API + worker       │
       │ active library id per tab                   └──────────┬──────────┘
       │                                                        │
       │                         ┌──────────────────────────────┼──────────────────────────┐
       │                         ▼                              ▼                          ▼
       │              registry.db (server-local)       library root on disk       ffmpeg/ffprobe
       │              registered_libraries            ┌────────────────────┐     derived media
       │              job_queue                       │ media files         │
       │                                              │ .cairndex/         │
       │                                              │   manifest.json     │
       │                                              │   library.db        │
       │                                              │   cache/            │
       │                                              └────────────────────┘
```

Normal Cairndex operations are metadata-only. The current app does not move,
rename, delete, or rewrite source files. The only filesystem writes in the
current product path are owner-initiated library package creation and generated
cache files under `.cairndex/cache/`.

## 2. Backend (`apps/server`)

The backend is a FastAPI app with a versioned `/api/v1` surface. `create_app()`
registers structured error handlers, includes v1 routers, starts the in-process
worker during lifespan when enabled, and optionally serves the built SPA when
`CAIRNDEX_STATIC_DIR` points at a frontend build.

Implemented layering:

```text
api/          FastAPI routers and request/response schemas
core/         config, app factory, time, structured errors, path helpers
persistence/  content DB models/session helpers for each library.db
domain/       enum/domain definitions
services/     HTTP-agnostic bundle, collection, tag, filter, subtitle, file-view logic
registry/     server-local registered library + job_queue models/services
jobs/         in-process worker and job context
scanning/     scan, fast-add, media classification, fingerprints, repair
media/        ffprobe/ffmpeg adapters, thumbnails, playback/subtitle helpers
grouping/     ADR-0009 suggester, plan store, and apply service
```

Content endpoints are scoped to one library:

- `GET /api/v1/libraries`, `POST /libraries/create`, `POST /libraries/register`,
  `GET /libraries/{id}` are registry endpoints.
- `/api/v1/libraries/{library_id}/bundles`, `/collections`, `/tags`,
  `/tag-groups`, `/smart-collections`, `/filters`, `/file-view`, `/fast-add`,
  `/grouping`, `/jobs`, `/files`, and playback/subtitle routes operate on the
  selected library's `library.db` and library root.
- `GET /api/v1/jobs/{job_id}` is global because job status lives in the registry
  queue.

A `LibrarySession` dependency resolves `{library_id}` through the registry,
refuses unknown/unavailable libraries, opens the matching `.cairndex/library.db`,
and associates the filesystem root with the session. Services that touch files
resolve paths from this session; clients never send unrestricted absolute paths
for content operations.

## 3. Frontend (`apps/web`)

The frontend is an Eagle-inspired, dark, three-pane desktop UI:

```text
src/
  api/        typed client over /api/v1 + TanStack Query hooks
  app/        Sidebar, Toolbar, Browser, Inspector, BundleAlbum, FileView,
              GroupingReview, LibraryManager, SmartCollectionEditor, layouts
  state/      localStorage-backed persistent UI preferences
  lib/        formatting helpers
```

The app picks one active library per browser tab and routes all content requests
under `/api/v1/libraries/{id}/…`. Switching libraries remounts the workspace to
avoid cross-library cache bleed. Server state lives in TanStack Query; UI state
such as active surface, selection, toolbar search, layout, zoom, and pane widths
lives in React/localStorage.

Current browsing surfaces:

- **Collection View:** virtualized bundle browser with grid/list/justified
  layouts, sidebar system views, Smart Collections, collections, tags, toolbar
  controls, selection, batch editing, and an in-bundle album/viewer.
- **File View:** read-only filesystem browser over the active library root,
  separate from Collection View selection and bundle inspection.

The current sidebar maintenance flow exposes one primary **Update** button plus a
small overflow menu for **Scan new files**, **Collect metadata**, and **Review
grouping**. Update waits for scan/grouping-plan generation, metadata probe, and
storyboard generation to finish before invalidating affected queries and opening
grouping review when the scan produced suggestions.

## 4. Library package and registry

A Cairndex library is a directory with this package:

```text
<library-root>/
  media files...
  .cairndex/
    manifest.json
    library.db
    cache/
      thumbnails/
      subtitles/
      storyboards/
```

The manifest stores the portable library identity and display name. `library.db`
holds all content metadata for that library. The cache holds reproducible derived
artifacts and is ignored by scanning/grouping.

The server-local registry DB (`{CAIRNDEX_DATA_DIR}/registry.db`) contains:

- `registered_libraries`: known library roots, manifest paths, availability,
  schema version, and last-opened timestamps;
- `job_queue`: scan/probe/thumbnail jobs, progress, cancellation, terminal state,
  and result payloads.

The registry is runtime/server state, not portable content metadata. Moving a
library folder should keep its `.cairndex/library.db` and cache with it; the
server may need to register the new root path.

## 5. Storage and path safety

Within a library, files are addressed by library-relative POSIX paths. The
content schema stores `AssetFile.relative_path`; there is no `StorageRoot` table
or `storage_root_id` in the current content DB.

Path safety rules:

- content APIs accept stable ids or library-relative paths, never unrestricted
  absolute server paths;
- relative paths are normalized and reject empty paths, absolute forms, Windows
  drive/UNC forms, NUL bytes, and `..` traversal;
- file access re-resolves the target under the library root and rejects symlink
  escapes;
- hidden dotfiles/dot-directories and known cruft are excluded from scan, File
  View, and grouping review;
- sensitive operations such as streaming, thumbnailing, subtitle conversion, and
  File View raw-file preview re-check existence at access time.

## 6. Domain model

The implemented schema is documented in `docs/data-model.md`. Core objects:

- `AssetBundle` — primary user-facing item in Collection View, search, tags,
  collections, and Smart Collections. It carries grouping review state
  (`provisional` or `confirmed`).
- `AssetFile` — one physical file linked into one bundle by library-relative
  path, with role, media kind, order, availability, filesystem identity,
  fingerprint/hash placeholders, source metadata, and technical metadata.
- `Collection` — hierarchical virtual grouping of bundles. Membership is
  many-to-many and never moves source files.
- `Tag` and `TagGroup` — hierarchical tags plus independent tag groups; a tag may
  belong to multiple groups.
- `SmartCollection` — saved, versioned filter AST plus optional view defaults
  (legacy table name `smart_folders`).
- `SubtitleTrack` — external subtitle file or embedded ffprobe stream linked to a
  video file.
- `PlaybackProgress` — owner resume state keyed by stable `AssetFile.id`, with a
  denormalized `bundle_id` synced from file re-parenting for continue-watching
  queries. Completion is only computed when a known duration is reported.
- `GroupingPlan` / `GroupingProposal` / `GroupingProposalFile` — durable,
  reviewable grouping suggestions.

Current schema note: source/origin hyperlink metadata exists at file level
(`AssetFile.source`). Bundle-level source links are deferred until there is a
clear product need.

## 7. Scanning, repair, and grouping

`scan_library()` walks the active library root and is incremental, idempotent,
and non-destructive.

Scanner behavior:

- classifiable media/subtitle/audio files are observed; hidden paths are skipped;
- same-path rows are updated in place;
- disappeared files are marked `missing`, not deleted;
- appeared paths are matched against disappeared rows for high-confidence
  same-file repair before creating new rows;
- repair preserves `AssetFile.id`, bundle membership, tags, collections, rating,
  notes, cover/primary references, subtitles, playback progress, and generated
  cache identity;
- the scan path reads cheap filesystem identity and quick fingerprint only — no
  full hashing of large files.

New files discovered by scan are staged into provisional scan-suggestion bundles.
After scanning, the scan job persists an open grouping plan. The plan is a
snapshot: it can safely report conflicts if files vanish or are manually changed
before apply.

Grouping behavior:

- the suggester proposes BUNDLE and CONTAINER nodes with roles, confidence,
  reasons, parent links, and natural ordering;
- subject-prefix matching can group videos with sidecars/covers in mixed folders;
- confirmed bundles are excluded from re-grouping; new files in confirmed-owned
  directories are proposed as additions;
- applying a plan is the only step that confirms scan-staged bundles, creates
  suggested collections, assigns roles, selects cover/primary, and links external
  subtitles;
- the apply API supports selected proposal ids. Applying selected proposals marks
  the plan applied; unchecked proposals are intentionally left unapplied for that
  plan and can be re-suggested by regenerating against current library state.

## 8. Media processing, thumbnails, playback, and subtitles

`ffprobe` extracts technical metadata into `AssetFile.tech_metadata`. `ffmpeg`
creates thumbnails and subtitle derivatives.

Derived cache:

- thumbnails live under `.cairndex/cache/thumbnails/`;
- converted external WebVTT subtitles live under `.cairndex/cache/subtitles/`;
- storyboard WebVTT indexes and tile sheets live under
  `.cairndex/cache/storyboards/`;
- cache paths are deterministic and reproducible;
- cache files are not content assets and are ignored by scan/grouping.

Storyboard artifacts use this cache layout:

```text
.cairndex/cache/storyboards/{file_id[:2]}/{file_id}/
  index.vtt
  fingerprint.txt
  sb_001.jpg
  sb_002.jpg
```

`fingerprint.txt` stores the source file's quick fingerprint for cheap
request-path validation; `index.vtt` also includes
`NOTE cairndex-quick-fingerprint: {quick_fingerprint}` so the artifact is
self-describing. Manifest `storyboard_url` values and VTT sheet payloads include
`?v={quick_fingerprint}` and storyboard endpoints serve them with immutable cache
headers. A cue payload is always a relative URL plus tile fragment:

```text
storyboard/sb_001.jpg?v={quick_fingerprint}#xywh={x},{y},{w},{h}
```

Clients should resolve that relative to the VTT URL using normal URL rules. The
VTT is an application index for trickplay loaders, not a browser `<track>`.

Thumbnail cover fallback is:

1. explicit `cover_file_id` if it points at a thumbnailable file;
2. first image in the bundle;
3. selected primary video;
4. first video in the bundle;
5. generated placeholder/no thumbnail state.

The global sidebar thumbnail button has been removed, but the backend thumbnail
job endpoint and lazy bundle/file thumbnail endpoints remain.

Direct playback is implemented around bundle/file routes that serve source bytes
with safe path resolution and HTTP range behavior. External SRT/VTT subtitles are
served as browser-native WebVTT through the cache. Storyboard endpoints serve
cached artifacts only and return 404 until the background job has generated a
current index. Embedded subtitle streams are detected and represented, but
extraction/remux/transcode fallback is deferred.

## 9. Filtering and Smart Collections

Filters use a canonical JSON AST (`version`, logical nodes, predicate nodes), not
raw SQL. Pydantic validates incoming expressions and an allowlisted SQLAlchemy
compiler produces bound-parameter queries. The same compiler powers live filter
preview, filtered browse, and Smart Collection CRUD/browse.

The current Smart Collection editor supports one Eagle-style all/any condition
group. The AST supports nested boolean groups for a later richer editor.

Text search is whole-library and indexed (`cairndex.search`). Each library DB
carries a `bundle_search` FTS5 table that indexes, per bundle, its title/note,
its files' display titles/filenames/paths/sources/media kind, and its tag and
collection names — assembled by a `bundle_search_source` view. SQLite triggers
over the underlying tables keep it fresh on every write path (edits, scan,
repair, grouping apply, deletion, tag/collection rename), so no application
plumbing maintains it; `ensure_search_schema` creates and first-populates it on
library open, and `devtools.reindex_search` rebuilds it. Browse's `q` parameter
tokenizes user input into safe quoted prefix terms and composes as a
non-correlated FTS semijoin (`AssetBundle.id IN (SELECT bundle_id FROM
bundle_search WHERE bundle_search MATCH ?)`), so it stacks with views,
collections, filters, sort, and pagination. Results keep the active sort;
relevance ranking is future work.

## 10. File View

File View is a read-only, filesystem-first browser over the active library root:
`GET /api/v1/libraries/{library_id}/file-view/entries?path=...`.

It returns directories first, then files, sorted case-insensitively. Each entry
includes name, library-relative path, kind, size, modified time, extension, MIME
guess, media classification, native support/openable state, and a cheap
linked-to-bundle hint. Raw preview bytes for File View entries are served by
`GET /api/v1/libraries/{library_id}/file?path=...` with the same path-safety
constraints.

File View selection is independent of Collection View/bundle selection, and the
right pane shows `FileInspector` rather than the bundle inspector. There are no
move/rename/delete controls in the current milestone.

## 11. Background jobs

The registry-owned `job_queue` backs a lightweight in-process worker. The worker
claims the oldest queued job, resolves its library, opens the library DB, runs the
registered handler with a `JobContext`, commits durable content work into the
library DB, and records progress/result/error back into the registry row.

Implemented job types:

- scan: discovery, repair, provisional staging, grouping-plan generation;
- probe: ffprobe technical metadata collection;
- thumbnail: library-wide thumbnail generation/reuse.

Progress is observable: each job row carries a coarse `phase` and optional
`message` plus processed/total counts, a terminal `result` summary, and a
sanitized `error`. `JobContext.set_phase(...)` flushes phase transitions
immediately, while `checkpoint(...)` throttles the registry progress write
(≤ one commit per 0.5s) so a huge scan does not commit the registry per batch;
cancellation is still polled every checkpoint. Stored errors are redacted
(`jobs/errors.py`) to keep private filenames/paths out of the API/UI.

The worker is intentionally single-process/single-worker for the SQLite MVP.
Scaling should start with profiling, better scheduling, and bounded concurrency,
not Redis/Celery.

## 12. Eagle migration/import

The Eagle importer is removed and out of scope under the per-library model. A
Cairndex library is its own portable directory populated by scanning. ADR-0004
is retained only as superseded design history. Eagle remains a UI/interaction
reference, not a data source that the current app imports or synchronizes with.

## 13. Deployment topology

Development uses local `uv`/Vite commands or `docker-compose.yml` with separate
backend and frontend services. Production uses the Dockerfile/compose stack under
`infra/` to build the frontend, install the backend, include `ffmpeg`/`ffprobe`,
run as a non-root user, mount app data at `/data`, and mount media/library paths
from the host.

Authentication is an **optional per-library owner passphrase lock** (ADR-0010),
off by default. The passphrase hash (PBKDF2) lives in each library's portable
manifest; unlocking is an in-process server-side session bound to an opaque
HTTP-only cookie, scoped to specific library ids (unlocking one library never
unlocks another). The `get_library_session` dependency is the single content
gate; the `auth/*` endpoints, registry list, health, and static assets stay
reachable while locked. This is a private-network guardrail, not multi-user auth
or public-internet hardening. Production compose still binds locally by default
and is intended to sit behind a private network/Tailscale or an authenticating
reverse proxy, not the public internet.

## 14. Known architectural debt

- richer grouping review editing before apply (merge/split/reclassify/rename);
- browse-summary query optimization and indexes for larger libraries;
- cross-filesystem moved-file repair and manual repair candidates;
- scheduled scans and stronger job scheduling;
- safe File View write mode plus desktop/native host integration;
- single-owner authentication before real remote exposure;
- remux/transcode fallback and embedded subtitle extraction;
- cache policy for future large transcodes (`inside_library` vs server-local).
