# Architecture

> Status: current through the media-player foundation M1–M12 and plan 2 T0
> (probe enrichment, the unified custom media viewer, storyboard trickplay,
> watch progress/resume, image viewer v2 with preview derivatives, the
> server-side playback decision + HLS remux/transcode session foundation, and
> the web hls.js/native-HLS engine
> integration, player polish, card hover previews, and device pairing/scoped
> bearer tokens; merged through M12 #12, with T0 on `feat/device-pairing`). See
> `AGENTS.md` for the product brief, `docs/plans/` for the client-platform
> roadmap, and `docs/STATUS.md` for current gaps, validation state, and
> recommended next tasks.

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
services/     HTTP-agnostic bundle, collection, tag, filter, subtitle, file-browser logic
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
  `/tag-groups`, `/smart-collections`, `/filters`, `/file-browser`, `/fast-add`,
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
  app/        Sidebar, Toolbar, Browser, Inspector, BundleAlbum, FileBrowser,
              GroupingReview, LibraryManager, SmartCollectionEditor, layouts
  state/      localStorage-backed persistent UI preferences
  lib/        formatting helpers
```

The app picks one active library per browser tab and routes all content requests
under `/api/v1/libraries/{id}/…`. Before switching, the app points the API client
at the next library and removes every active-library content query from TanStack
Query; the global library registry and library-id-keyed auth queries remain.
The library-keyed workspace then remounts to reset local UI state. This prevents
the shared 30-second fresh cache from rendering the previous library under the
new selection. UI state such as active surface, selection, toolbar search,
layout, zoom, and pane widths lives in React/localStorage.

Current browsing surfaces:

- **Bundle Browser:** virtualized bundle browser with grid/list/justified
  layouts, sidebar system views, Smart Collections, collections, tags, toolbar
  controls, selection, batch editing, and an in-bundle album/viewer.
- **File Browser:** read-only filesystem browser over the active library root,
  separate from Bundle Browser selection and bundle inspection.

M12 adds one shared card-hover preview path across video effective-cover bundle
cards, bundle-album file tiles, and linked File Browser grid cards. A module-level
owner permits only one active preview. Direct-capable sources use the existing
range `/stream` URL after a 500 ms dwell. Storyboard indexes prefetch after a
150 ms sub-dwell; motion pauses and hides the still-mounted direct video,
renders the cursor-time sprite, and performs no video seeks. After 250 ms rest,
one seek lands on the displayed storyboard cue's sampled timestamp and playback
resumes. Final pointer time is used only when no storyboard is available; the
paused video frame then stays visible during motion. Non-direct sources use the
same sprite path without mounting video. The hover path never calls the
playback-decision or HLS-session APIs. Leave, guarded interactions, and
virtualized unmount pause the element, remove its source, and reload it.

Local list/picker search uses the shared `app/pinyin.ts` matcher. It preserves
case-insensitive literal substring matching and adds contiguous full-pinyin,
initial-letter, partial, mixed, and polyphonic matching for Chinese names. This
covers tag/collection pickers (single- and multi-bundle), tag filters, All Tags,
File Browser names, and local file-selection filters. Exact-name checks for
inline **Create** actions remain literal, so a pinyin alias never suppresses
creating a distinct Latin name. `pinyin-pro` is lockfile-pinned and runs fully
offline; its dictionary is a separate ~142 kB gzip lazy chunk loaded when a
search-bearing surface mounts, keeping it out of the initial app bundle. The
maintenance cost is one frontend-only dependency and its lockfile update; there
is no schema, API, server runtime, or external-service dependency.

Server-backed whole-library Bundle Browser search remains the SQLite FTS path
described in §9 and does not yet index pinyin aliases. Extending pinyin there
would require persisted aliases plus an FTS rebuild, so it is intentionally
outside this low-cost picker enhancement.

The current sidebar maintenance flow exposes one primary **Update** button plus a
small overflow menu for **Scan new files**, **Collect metadata**, **Suggest
grouping**, and **Generate storyboards**. Update waits for scan/grouping-plan
generation and metadata probe, then starts storyboard generation in the
background.

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
  File Browser raw-file preview re-check existence at access time.

## 6. Domain model

The implemented schema is documented in `docs/data-model.md`. Core objects:

- `AssetBundle` — primary user-facing item in Bundle Browser, search, tags,
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
- image previews live under `.cairndex/cache/previews/`;
- converted external WebVTT subtitles live under `.cairndex/cache/subtitles/`;
- storyboard WebVTT indexes and tile sheets live under
  `.cairndex/cache/storyboards/`;
- cache paths are deterministic and reproducible;
- cache files are not content assets and are ignored by scan/grouping.

Storyboard artifacts use this cache layout:

```text
.cairndex/cache/storyboards/{file_id[:2]}/{file_id}/
  index.vtt
  index.fingerprint
  sb_001.jpg
  sb_002.jpg
```

`index.fingerprint` stores the storyboard format version plus the source file's
quick fingerprint for cheap request-path validation without reading the VTT;
`index.vtt` keeps a quick-fingerprint note for artifact inspection. Storyboard
format v2 anchors ffmpeg sampling at t=0 and selects the source frame active at
each VTT cue boundary. Old-format indexes are rejected even when their source
fingerprint still matches. Manifest `storyboard_url` values and VTT sheet
payloads include a URL-encoded token derived from the format plus quick
fingerprint. VTT responses use `Cache-Control: no-cache` so clients revalidate
the index; versioned JPEG
sheets remain immutable. A cue payload is always a relative URL plus tile
fragment:

```text
storyboard/sb_001.jpg?v={format-and-fingerprint-token}#xywh={x},{y},{w},{h}
```

Clients should resolve that relative to the VTT URL using normal URL rules. The
VTT is an application index for trickplay loaders, not a browser `<track>`.
After a storyboard format change, existing libraries require an explicit
Update/storyboards run; request handlers never generate derivatives on demand.

Thumbnail cover fallback is:

1. explicit `cover_file_id` if it points at a thumbnailable file;
2. first image in the bundle;
3. selected primary video;
4. first video in the bundle;
5. generated placeholder/no thumbnail state.

The global sidebar thumbnail button has been removed, but the backend thumbnail
job endpoint and lazy bundle/file thumbnail endpoints remain.

M9 adds an optional `AssetFile.cover_time`. When set through the path-safe
`POST /files/{id}/cover-frame` action, video thumbnail regeneration uses a
single `-ss` frame extraction at that timestamp instead of the representative
frame filter; clearing it restores automatic extraction. Browse cover keys and
file thumbnail URLs include a changing version only for custom-frame covers so
TanStack invalidation also bypasses immutable browser image caches. Storyboard
generation now parses `showinfo` frame indices from its existing ffmpeg pass and
limits VTT cues to real sampled frames before the tile filter pads a final sheet.
EOF requests clamp to a decodable frame 100 ms before probed duration, and reset
restores the bundle cover displaced by the selection. Bundle detail surfaces use
`updated_at` as their image version; cover mutations optimistically update file
queries and refetch version-bearing bundle/browse/collection data. Collection
timestamps are touched through reverse membership plus ancestor traversal, not
an all-collection scan. Storyboard parsing removes ANSI control sequences and
falls back to emitted-sheet capacity with a warning when `showinfo` is absent.

Bundle browse summaries expose nullable effective-cover video file id, relative
path, ffmpeg container list, video/audio codecs, and duration for M12 without
another query: the fields are derived beside the existing cover key from the
already-loaded ordered file list. Image, missing, and empty effective covers
return null preview fields.

Image preview derivatives are lazy-only in M5 and use this deterministic cache
layout:

```text
.cairndex/cache/previews/{file_id[:2]}/{file_id}_{size}.webp
.cairndex/cache/previews/{file_id[:2]}/{file_id}_{size}.fingerprint
.cairndex/cache/previews/pa/path_{sha256(relative_path)[:32]}_{size}.webp
.cairndex/cache/previews/pa/path_{sha256(relative_path)[:32]}_{size}.fingerprint
```

`size` is allowlisted to `640`, `1600`, or `2560`. The first request re-resolves
the source under the library root, rejects missing or unsupported sources,
decodes behind a bounded in-process semaphore, writes the WebP derivative by
atomic replacement, and records the source quick fingerprint in the shared
`.fingerprint` sidecar. Linked-file preview URLs include `?v={quick_fingerprint}`;
File Browser path previews use a path-hash cache key plus a stat-derived quick
fingerprint because the file need not be linked into a bundle. The endpoint
serves current derivatives with `Cache-Control: public, max-age=31536000,
immutable`. Browser-native raster images can downscale from the original;
HEIC/HEIF, TIFF, and BMP use Pillow plus pillow-heif. PSD is not advertised as
openable until a tested decoder path exists. These dependencies are kept out of
normal request paths until a preview must be generated and were added to unlock
non-browser image formats and sized preview delivery for all clients, including
future TV clients. There is intentionally no preview precompute job in this
slice.

Direct playback is implemented around bundle/file routes that serve source bytes
with safe path resolution and HTTP range behavior. External SRT/VTT subtitles are
served as browser-native WebVTT through the cache. Storyboard endpoints serve
cached artifacts only and return 404 until the background job has generated a
current index. Embedded subtitle streams are detected and represented, but their
extraction to servable text tracks is deferred (M8).

### Playback decisions and HLS sessions (ADR-0014)

Clients declare a capability profile (containers, video/audio codecs,
`max_height`, `native_hls`) and the server decides how to deliver each file
(plan 1 §6):

- `POST /api/v1/libraries/{library_id}/files/{file_id}/playback-decision` runs a
  pure decision matrix (`media/playback.decide_playback`) over the source's M1
  `tech_metadata` versus the caps — container+codecs in caps → `direct`; codecs
  in caps but container not → `remux`; otherwise → `transcode`. A non-default
  audio track or an unsupported audio codec forces at least remux; a burn-in
  subtitle or a source taller than the height cap forces transcode. Legacy rows
  missing M1 keys degrade safely (unknown codec is optimistic; it never 500s).
  The response also carries duration, audio streams, subtitles, chapters,
  `storyboard_url`, and resume `progress`. For `direct` it returns a
  `stream_url`; for remux/transcode it **starts an HLS session** and returns
  `{session {id, playlist_url}}`.
- Sessions are interactive in-process runtime state, **not** background jobs
  (`media/hls.SessionManager` — a dict guarded by locks, not the `job_queue`).
  `POST .../playback-sessions` starts one explicitly (e.g. a mid-play
  quality/audio switch with `start_s`); `GET .../{session_id}/index.m3u8`
  returns a VOD fMP4 playlist computed up front from the known duration (6 s
  target); `GET .../{session_id}/{init.mp4|{n}.m4s}` serves the shared init
  segment and media segments; `DELETE .../{session_id}` tears the session down.
  One ffmpeg per session writes segments sequentially; serving a segment ahead
  of the encoder waits (bounded), and a far seek kills and restarts ffmpeg at
  the requested segment (`-ss` + `-start_number`). Remux copies video with an
  AAC audio fallback and accepts keyframe drift; transcode uses `libx264`
  `veryfast` with `force_key_frames` for exact 6 s boundaries and a capped
  ladder honoring `max_height`.
- Session output is **server-local and ephemeral** under
  `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` — never inside a library
  package. Concurrency is bounded (`CAIRNDEX_TRANSCODE_MAX_SESSIONS`, default 2;
  a structured 429 beyond it), an idle reaper kills + deletes sessions with no
  fetch for `CAIRNDEX_TRANSCODE_IDLE_TIMEOUT` seconds (default 60), and all
  sessions are torn down on server shutdown. Session routes use the same
  `LibrarySession` gating as direct streams; session ids are random and scoped
  to their library; ffmpeg args come only from server-side-resolved paths.
  Optional `CAIRNDEX_FFMPEG_HWACCEL` adds a decode-only hwaccel prefix for
  transcode sessions.
- A POST `.../playback-sessions/{session_id}/teardown` alias mirrors the DELETE
  route so `navigator.sendBeacon` (POST-only) can reap a session on `pagehide`
  (same pattern as the M4 progress beacon).

**Web engine integration (M7, `apps/web/src/app/viewer/player/`).** The custom
player drives delivery through the `PlaybackEngine` seam. A memoized capability
profile (`caps.ts`) is computed once via `canPlayType` + `MediaSource.isTypeSupported`
and only advertises probe-confirmed formats. When a video starts, `MediaViewer`
(via `useHlsSession`) POSTs a playback decision: `direct` uses `NativeEngine`
(progressive `video.src`), `native_hls` uses `NativeEngine` with the m3u8, and
otherwise `HlsEngine` lazy-loads **hls.js** (a separate build chunk) and attaches
over MediaSource. The hook owns the session lifecycle — teardown on close/switch/
unmount, a `sendBeacon` teardown on `pagehide`, and transparent re-attach at the
current playhead when a session idles out (segment/playlist 404 or an hls.js fatal
error). Quality (`max_height` ladder), audio-track, and subtitle burn-in choices
re-decide and start a new session at the current position rather than switching
in-stream; resume/watch-progress works unchanged over the 1:1 VOD timeline.

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

## 10. File Browser

File Browser is a read-only, filesystem-first browser over the active library root:
`GET /api/v1/libraries/{library_id}/file-browser/entries?path=...`.

It returns directories first, then files, sorted case-insensitively. Each entry
includes name, library-relative path, kind, size, modified time, extension, MIME
guess, media classification, native support/openable state, and a cheap
linked-to-bundle hint. Linked entries also carry nullable file id, container,
video/audio codecs, and duration for card hover preview; SQLite extracts only
those JSON keys in the existing batched membership query, while unlinked paths
remain null. Image files are openable when they are browser-native or
preview-capable through the preview pipeline, so HEIC/TIFF/BMP can now appear as
supported even though the browser never receives the original bytes directly.
Raw preview bytes for File Browser entries are served by
`GET /api/v1/libraries/{library_id}/file?path=...` with the same path-safety
constraints.

File Browser selection is independent of Bundle Browser/bundle selection, and the
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

Authentication combines the **optional per-library owner passphrase lock**
(ADR-0010) with owner-paired **device bearer tokens** (ADR-0015). Browser
unlocks remain in-process sessions bound to opaque HTTP-only cookies; native
clients pair through a six-character code and receive one high-entropy token
whose salted hash, explicit library-id scope, usage timestamps, and revocation
state live in the server registry. `get_library_session` and the short-lived
`LibraryAccess` streaming gate accept either credential without holding a
registry connection while bytes stream. Passphrase-less libraries remain
anonymous when no bearer header is supplied. `GET /api/v1/health` advertises
`api_features` (`trickplay`, `hls`, `progress`, `pairing`) for additive client
feature detection. This remains a private-network guardrail, not multi-user
auth or public-internet hardening. Production compose still binds locally by
default and is intended to sit behind a private network/Tailscale or an
authenticating reverse proxy, not the public internet.

## 14. Known architectural debt

- richer grouping review editing before apply (merge/split/reclassify/rename);
- browse-summary query optimization and indexes for larger libraries;
- cross-filesystem moved-file repair and manual repair candidates;
- scheduled scans and stronger job scheduling;
- safe File Browser write mode plus desktop/native host integration;
- single-owner authentication before real remote exposure;
- embedded subtitle extraction to servable text tracks (M8) — the web
  hls.js/native-HLS engine integration for the M6 remux/transcode sessions
  landed in M7;
- transcode-cache location is settled (ADR-0014: server-local ephemeral under
  `{CAIRNDEX_DATA_DIR}/transcode/`, never inside a library package).
