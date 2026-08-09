# Architecture

> Status: current through the media-player foundation M1–M12, plan 2 T0, and plan 3 D4
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

Cairndex is a single-owner, self-hosted application. A FastAPI backend runs
on the server/NAS that can see the media library path; a React/Vite frontend runs
in a browser or inside the Tauri 2 desktop host. Content metadata is **per library**, not server-global: each
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

`apps/desktop` is a thin cross-platform Rust shell over the same `apps/web`
development URL and production build. It owns first-run server configuration,
native window/menu lifecycle, single-instance behavior, window-state
persistence, device-token storage, and per-library local path mappings.
`apps/web/src/platform` is the only
Tauri import boundary: it supplies the exact OS-neutral `HostPlatform`
capabilities, per-OS labels, a browser pass-through implementation, and
a lazily loaded desktop implementation selected by `window.__TAURI_INTERNALS__`.
The shared frontend has one deliberate root-policy difference in development:
the browser root uses React StrictMode replay, while the Tauri root does not.
TanStack Query consumes cancellation signals for library requests; WKWebView can
strand the immediate replacements after StrictMode cleanup aborts the first
startup burst. Production StrictMode has no replay, and browser development
continues to exercise the shared components under it.

The app resolves registry availability before the authorization and ownership
mount gates. A row already marked `unavailable` never becomes the active content
request scope, so it cannot fan out requests that the server must reject. A
remembered offline choice yields to the first available library; when every row
is offline, the shell shows a recovery card with manual Retry and Manage
Libraries actions. The visible shell polls the registry every five seconds only
in that all-unavailable state, stopping as soon as any library is reachable.
This is detection, not path discovery: a moved root still requires the owner to
register its actual location.
The paired token is stored with its normalized issuing server and immutable
approved library ids. Programmatic requests attach it only to those
library-scoped URLs; global and unscoped requests stay anonymous. An unscoped
protected library offers pairing rather than the browser-only cookie form.

Settings → Libraries maps a server registry id to a local or SMB-mounted root.
The native folder picker and all absolute paths stay inside Rust; a mapping is
stored only after `<root>/.cairndex/manifest.json` parses and its portable
`library_uuid` matches the server library, and the proven UUID is persisted
with the root. Reveal/default-app commands receive only
`{library_id, relative_path}` and run their mount-touching work off the IPC
thread. `mappings.rs` rejects empty, absolute, current-directory, and
parent-traversal paths, re-reads the manifest and requires the stored UUID to
still match (rejecting a remounted different volume as `library_mismatch`),
canonicalizes the configured root and target, requires
containment/existence, and reports an unavailable root as a structured
`volume_not_mounted` error. Only then does `host.rs` call the cross-platform
Tauri opener plugin. Plain web and unmapped libraries expose no host action.

The same mapping/validation boundary powers desktop drag (plan 3 D4). Drag-out
(`dragout.rs`) resolves every requested `{library_id, relative_path}` through
`mappings.rs` off the IPC thread, then starts a native OS drag on the main
thread through the cross-platform `drag` crate — the engine behind
`tauri-plugin-drag`, used directly so absolute paths never reach the web layer
(the plugin's only surface is a JS command that takes them); the sole OS edge is
the window handle. Drag-in relies on Tauri's `dragDropEnabled` webview event for
the dropped absolute paths, which `reverse_map_paths` canonicalizes against the
active library's identity-verified root and categorizes into in-library relative
files (fed to Create Bundle), out-of-library files (echoed back as the dropped
absolutes the web itself supplied), and a directory count. In-library media seeds
Create Bundle; the server tolerates and reports by reason any path it can't bundle
in that batch. Outside files are **copied in** when the library permits writing
(ADR-0013 §7): `importer.rs` streams each one to the server's import endpoint,
refusing any path the shell did not itself record from the OS drop event — the
web layer may name a dropped path, never invent one. A read-only library still
gets the in-place-linking explanation, and a dropped folder gets its own message.

An import selection remains a **client-owned sequential batch**, not a registry
job: the bytes live in a browser `File` or a desktop file handle, so putting an
entry in `job_queue` would move neither the upload nor its cancellation to the
server. Browser uploads carry an `AbortSignal`. Desktop uploads cross IPC inside
a batch-scoped cancellation token; stopping makes the Rust reader feeding
`reqwest` return `Interrupted`, which closes the in-flight HTTP request body.
Starlette then raises `ClientDisconnect` from `Request.stream()`, and the normal
ADR-0013 failure path removes `.cairndex/tmp/<operation-id>.part` and marks that
file's journal operation failed. Files whose individual requests already
finished stay imported, with their own journal entries and Undo operations.

Media-element, HLS, subtitle, thumbnail, storyboard, and preview URLs for approved libraries
use the ADR-0017 loopback Rust relay. The relay rotates an unguessable capability
path on configuration, fixes its upstream, permits only scoped read-only media
routes and exact shell origins, rejects redirects, bounds read stalls and
concurrency, and preserves known lengths for large range responses. Tauri 2.11
custom protocols were rejected here because their owned byte response buffers a
whole range instead of streaming it. No bearer is placed in a URL.
Plain web keeps its relative same-origin URLs and cookie behavior. The backend
permits the three packaged Tauri
custom-protocol origins by default; `tauri dev` requires an explicit exact
Vite-origin opt-in through `CAIRNDEX_CORS_EXTRA_ORIGINS`. No source media or
library metadata is stored in the shell.

Normal Cairndex operations are metadata-only: scanning, grouping, playback, and
thumbnailing never move, rename, delete, or rewrite source files. Source media
changes **only** through an explicit, journaled write-mode operation (ADR-0013)
— rename, New Folder, delete-to-trash, restore, and import — which requires both
the owner's per-library opt-in and the deployment switch. Everything else that
touches the disk is owner-initiated library package creation and generated cache
files under `.cairndex/cache/`.

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
file_ops/     ADR-0013 write mode: gate, path validator, journal, operations,
              trash, and streamed imports
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
- `GET|PUT /api/v1/libraries/{id}/write-mode` is registry-level too (ADR-0013):
  it changes a server-side flag and reads the manifest, but never opens
  `library.db`. Endpoints that *use* the capability declare the
  `require_write_mode` dependency, which answers 403 `write_mode_disabled` when
  either the library's flag or `CAIRNDEX_WRITE_MODE` says no.
- `/api/v1/libraries/{id}/file-ops/…` are the guarded write operations
  themselves — `rename`, `mkdir`, `{op}/undo`, and the journal listing. All but
  the listing declare the gate; the listing does not, because turning the
  capability off must not hide what it did while it was on.

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
  desktop/    shell bootstrap, menu-event bridge, app-exit task guard
  platform/   OS-neutral host capabilities, labels, auth transport, path handoff
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
layout, zoom, pane visibility, and pane widths lives in React/localStorage.

Current browsing surfaces:

- **Bundle Browser:** virtualized bundle browser with grid/list/justified
  layouts, sidebar system views, Smart Collections, collections, tags, toolbar
  controls, selection, batch editing, and an in-bundle album/viewer.
- **File Browser:** read-only filesystem browser over the active library root,
  separate from Bundle Browser selection and bundle inspection.

M12 adds one shared card-hover preview path across bundle cards, bundle-album
file tiles, and linked File Browser grid cards. Bundle cards source it from the
ADR-0016 cursor rather than the cover: image cursors show a still, while video
cursors use the behavior below. A module-level owner permits only one active
preview. Direct-capable videos use the existing range `/stream` URL after a
500 ms dwell. Storyboard indexes prefetch after a
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
generation, refreshes the UI, and opens grouping review immediately. Metadata
probe continues in the shared background-job area; storyboard generation is
chained for the same library after successful probe because eligibility and
sampling need duration.

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
    library.db.bak
    locks/
      active-owner.json
```

The manifest stores the portable library identity and display name. `library.db`
holds all content metadata for that library. The cache holds reproducible derived
artifacts and is ignored by scanning/grouping. `locks/active-owner.json` is the
ownership lease (§4.1) and `library.db.bak` its sync-heal snapshot (§4.2).

The server-local registry DB (`{CAIRNDEX_DATA_DIR}/registry.db`) contains:

- `registered_libraries`: known library roots, manifest paths, availability,
  schema version, last-opened timestamps, and the per-library write-mode opt-in
  (ADR-0013 — registry state precisely so a copied library arrives read-only);
- `job_queue`: scan/probe/thumbnail jobs, progress, cancellation, terminal state,
  and result payloads;
- `server_identity`: this install's persistent `server_uuid` and machine name,
  which every lease it writes is stamped with.

The registry is runtime/server state, not portable content metadata. Moving a
library folder should keep its `.cairndex/library.db` and cache with it; the
server may need to register the new root path.

**Portability invariant (ADR-0018 §1):** everything a user would miss lives in
`.cairndex/`, and everything in the registry must be reconstructible from
nothing. This is what makes a cloud-synced library open correctly on a second
machine that has no server state at all. Any future feature that puts
authoritative library state in `registry.db` breaks that and needs a superseding
ADR — worth checking on registry schema changes.

### 4.1 Ownership lease

A server may serve a library only while it holds that library's lease at
`.cairndex/locks/active-owner.json` (ADR-0018). Enforcement lives in the library
folder rather than in any server's registry for a simple reason: the two servers
in a conflict cannot see each other, and a cloud-synced copy of a library has no
server at all. The folder is the one thing every would-be server can observe.

The lease records the holding `server_uuid`, a human-readable `machine_name`, an
optional `advertised_url`, `acquired_at`/`heartbeat_at`, and a `nonce`
regenerated on every write. A server reading it classifies one of five states:

| State        | Meaning                                        | Action                                     |
| ------------ | ---------------------------------------------- | ------------------------------------------ |
| `released`   | No lease, or `released_at` set                 | Acquire silently                           |
| `own`        | Our own `server_uuid` (we crashed)             | Re-acquire silently, however stale         |
| `fresh`      | Foreign, heartbeat within TTL                  | Refuse; offer a redirect to the holder     |
| `stale`      | Foreign, heartbeat older than TTL              | Offer a user-confirmed takeover            |
| `unreadable` | A lease exists but could not be parsed         | Offer a user-confirmed takeover            |

`unreadable` is deliberately not folded into `released`: "we could not find out"
must never become "nobody holds it", or a corrupt file turns into a silent second
writer.

Because no atomic compare-and-swap exists on a synced folder or an SMB share,
acquisition is **write-then-verify** — exclusive-create when no file exists,
otherwise write our nonce, pause, and re-read to confirm it survived. Before a
*stale* takeover the server additionally watches the lease for longer than a
heartbeat period: a live holder writing to the same disk visibly touches the file
during the window, which catches the two-servers-one-NAS-export case without
trusting cross-machine clocks at all. Timestamps only ever suggest staleness;
the observation is what establishes it. Takeover **always** requires explicit user
confirmation — there is no auto-takeover after any TTL.

Holding is a heartbeat that doubles as a watchdog: every interval the server
re-reads the lease *before* rewriting it. A foreign `server_uuid`, or our own
under a nonce we did not write, means ownership moved. The response is fixed: never
fight for it back, stop writing, cancel that library's jobs, and unmount. Heartbeats
continue while a library is idle, because going quiet would make a healthy NAS
server's libraries look abandoned from every other machine.

**Reads need the lease too.** Browsing already writes — bundle cursors,
missing-file reconciliation — and reading a SQLite DB another machine is writing
through a share or a sync engine is exactly what ADR-0008 rejected. There is no
leaseless read-only mount.

The mount gate (`api/deps.py`) covers both the content-session and the streaming
`LibraryAccess` dependency, and costs a dictionary lookup for a library already
held, so it adds no filesystem I/O to the request path. Long jobs re-verify at
start and at every batch boundary. `GET /api/v1/libraries/{id}/ownership` sits
outside the gate on purpose — it is the endpoint a client calls *because* a mount
was refused; `POST .../ownership/takeover` returns 202 and runs the observation
window in the background.

### 4.2 SQLite sync hygiene

A library in WAL mode is up to three files, and a cloud-sync engine uploads
whatever it finds whenever it looks. `persistence/checkpoint.py` plus a
`SqliteMaintenance` timer thread keep the at-rest state coherent (ADR-0018 §6):

- a library idle past a threshold gets `wal_checkpoint(TRUNCATE)` — `TRUNCATE`
  rather than `PASSIVE`, which would leave the WAL at its high-water mark and
  keep the sync engine shipping a large file carrying nothing;
- a periodic consistent snapshot goes to `.cairndex/library.db.bak` via SQLite's
  online backup API, written temp-then-renamed. The backup API is required
  rather than preferred: a file copy taken while a WAL is outstanding silently
  misses everything the WAL holds;
- clean shutdown checkpoints and disposes every library engine *before* releasing
  the leases, so each library is left as a single consistent file before another
  machine is invited to pick it up.

Maintenance only ever touches libraries whose lease this server holds; the set is
supplied to `SqliteMaintenance` as a callable, so `persistence` stays unaware of
the ownership layer. It runs on its own thread rather than sharing the lease
heartbeat's: a slow checkpoint on a sluggish mount must not be able to delay a
heartbeat into looking stale to other machines.

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
- successful bundle file-list and playback-manifest reads check every linked
  member of that bundle; File Browser directory reads use the indexed
  `AssetFile.directory_path` key to check only linked direct children;
- hidden dotfiles/dot-directories and known cruft are excluded from scan, File
  View, and grouping review;
- sensitive operations such as streaming, thumbnailing, subtitle conversion, and
  File Browser raw-file preview re-check existence at access time.

Both access paths persist newly vanished files as `missing`. Directory listings
return the number of changed rows so the client refreshes bundle/count queries
only after a real availability update. They never search the library or infer a
moved file's new path. The scanner remains the reconciliation boundary for
high-confidence moved-file repair that preserves the existing `AssetFile.id`
and bundle metadata.

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
- `BundleCursor` — one current ordered media file per bundle, stored separately
  from versioned bundle metadata. It also represents images, while video time
  remains in `PlaybackProgress` (ADR-0016).
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
  notes, cover/cursor references, subtitles, playback progress, and generated
  cache identity;
- the scan path reads cheap filesystem identity and quick fingerprint only — no
  full hashing of large files.

When an SMB/network rename changes both basename and inode, the conservative
automatic match may stage the new path separately. Missing Files includes both
confirmed and stale provisional bundles and offers a compact explicit relink
only for a globally unique, re-statted quick-fingerprint match. The repair
collapses the replacement metadata row into the original stable file id and
bundle; source files are never moved, renamed, or deleted.

New files discovered by scan are staged into provisional scan-suggestion bundles.
After scanning, the scan job persists an open grouping plan. The plan is a
snapshot: it can safely report conflicts if files vanish or are manually changed
before apply.

Grouping behavior:

- observations include only files marked available by the latest scan; missing
  rows remain in the library database for repair and metadata continuity but do
  not enter a new plan, and a stale plan treats them as apply conflicts;
- the suggester proposes BUNDLE and CONTAINER nodes with roles, confidence,
  reasons, parent links, and a stable video → audio → image → remaining-files
  order (natural path order within each group);
- multi-video directories are partitioned by normalized filename stem before
  matching each candidate against confirmed bundles in the same directory;
  balanced matching folds conservative trailing rendition labels, while narrow
  and wide per-directory modes respectively retain literal stems or use a
  broader subject/source prefix;
- grouping plans persist those per-directory stem modes, and the review controls
  regenerate a complete superseding snapshot while seeding the returned plan
  directly into the client cache;
- grouping review persists whole-row file drag-and-drop within or across bundle
  proposals, accepting either the target bundle heading or file list as a drop,
  bundle reparenting into suggested collections, and bundle/collection title
  edits before apply; reviewed file sequence becomes playlist order;
- additions to confirmed bundles retain that bundle as a reversible target while
  persisting a target-title snapshot, a derived fresh-bundle title, and the
  owner's existing/new destination choice; switching modes recomputes roles but
  preserves the reviewed sequence and proposal identity;
- relevant existing collection branches remain in the review plan even when
  their confirmed bundles are excluded; additions prefer their target bundle's
  collection, while fresh top-level proposals reuse the deepest matching
  collection path, and apply resolves those nodes to existing collections;
- bundle proposals with no files and collection proposals with no file-backed
  descendants are automatically excluded from the accepted selection;
- explicitly edited proposals retain their original bundle identity while
  confirmed bundles remain outside every grouping-regeneration candidate set;
- subject-prefix matching can group videos with sidecars/covers in mixed folders;
- confirmed bundles are excluded from re-grouping; each new filename-stem group
  in their directory is proposed against a unique matching owner (with a narrow
  directory-only fallback), while an explicit new-bundle override applies those
  files separately and leaves the confirmed target untouched;
- applying a plan is the only step that confirms scan-staged bundles, creates
  suggested collections, assigns roles, selects a cover, and links external
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

`index.fingerprint` stores the storyboard format version, the sampling mode, and
the source file's quick fingerprint for cheap request-path validation without
reading the VTT; `index.vtt` keeps a quick-fingerprint note for artifact
inspection. Storyboard format v3 samples **keyframes only** (`-skip_frame
nokey`), so generation cost stops scaling with how hard a video is to decode —
`fps=1/n` sampling decodes a video from end to end, which is what made a
network-mounted library slow (docs/performance.md). Tiles land on the keyframe
at or before each sample point, so scrubbing is only as fine as the source's
GOP, and each cue carries the timestamp of the frame it holds rather than a
nominal grid position: cues are as uneven as the source's keyframes and run to
the next sampled frame. `CAIRNDEX_STORYBOARD_SAMPLING=exact` restores
full-decode sampling on exact interval boundaries. The mode is part of the cache
key, so changing it invalidates cached sheets. Old-format indexes are rejected
even when their source fingerprint still matches. Manifest `storyboard_url` values and VTT sheet
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
3. first video in the bundle;
4. generated placeholder/no thumbnail state.

The global sidebar thumbnail button has been removed, but the backend thumbnail
job endpoint and lazy bundle/file thumbnail endpoints remain.

M9 adds an optional `AssetFile.cover_time`. When set through the path-safe
`POST /files/{id}/cover-frame` action, video thumbnail regeneration uses a
single `-ss` frame extraction at that timestamp instead of the representative
frame filter; clearing it restores automatic extraction. Browse cover keys and
file thumbnail URLs include a changing version only for custom-frame covers so
TanStack invalidation also bypasses immutable browser image caches. Storyboard
generation parses `showinfo` sample timestamps from its existing ffmpeg pass and
builds one cue per sampled frame, so the tile list and the cue list are the same
list; sheet capacity still caps them where the tile filter pads a final sheet.
Keyframe sampling emits sheets at irregular intervals, so the pass pins the
output sync mode — the muxer's default duplicates sheets to reach a constant
frame rate, which would point every cue past the first sheet at a copy.
EOF requests clamp to a decodable frame 100 ms before probed duration, and reset
restores the bundle cover displaced by the selection. Bundle detail surfaces use
`updated_at` as their image version. Cover-file selection optimistically updates
bundle detail, adopts the authoritative PATCH response, and refreshes browse
artwork in the background; metadata detail reads do not perform member-path
checks. Bundle file-list, playback, and scan paths retain missing-file
reconciliation. Cover-frame mutations optimistically update file queries and
refetch version-bearing bundle/browse/collection data. Collection timestamps
are touched through reverse membership plus ancestor traversal, not
an all-collection scan. Storyboard parsing removes ANSI control sequences and
falls back to the nominal sampling grid, capped by emitted-sheet capacity and
warned about, when `showinfo` is absent. A video whose keyframes cannot describe
it — fewer than two usable samples, or a keyframe pass ffmpeg rejects — is
decoded in full once rather than reduced to a one-tile storyboard.

Bundle browse summaries keep the cover key solely for static artwork and expose
the effective bundle cursor separately: file id/update time, media kind/path,
MIME, probe codecs/container/duration, and incomplete video position. The cursor
is resolved from the persisted row, legacy progress fallback, then ordered
supported files. Card hover therefore shows a still image or video preview even
when the chosen cover is different. Missing current files keep their cursor id
for the viewer's missing state but expose no hover source (ADR-0016).

The media viewer uses the same ordered supported file list for initial open,
previous/next, and end-of-video advance. Changing the selected media writes the
bundle cursor without bumping bundle metadata/version. `primary_file_id` remains
only as an unread legacy column for existing databases; the API and inspector no
longer expose a primary-file action.

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
HEIC/HEIF, TIFF, and BMP use Pillow plus `pi-heif` (decode-only by design —
its `pillow-heif` sibling bundles a GPL encoder Cairndex never calls; see
THIRD-PARTY-NOTICES.md). PSD is not advertised as
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
  route so browser `navigator.sendBeacon` (POST-only) can reap a session on
  `pagehide` (same pattern as the M4 progress beacon). Desktop app exit instead
  registers an awaitable task that uses the ordinary authenticated DELETE through
  `hostFetch`; the GET/HEAD-only media relay never accepts teardown writes.

**Web engine integration (M7, `apps/web/src/app/viewer/player/`).** The custom
player drives delivery through the `PlaybackEngine` seam. A memoized capability
profile (`caps.ts`) is computed once via `canPlayType` + `MediaSource.isTypeSupported`
and only advertises probe-confirmed formats. When a video starts, `MediaViewer`
(via `useHlsSession`) POSTs a playback decision: `direct` uses `NativeEngine`
(progressive `video.src`), `native_hls` uses `NativeEngine` with the m3u8, and
otherwise `HlsEngine` lazy-loads **hls.js** (a separate build chunk) and attaches
over MediaSource. The hook owns the session lifecycle — teardown on close/switch/
unmount, a browser `sendBeacon` on `pagehide`, an awaitable DELETE during desktop
exit, and transparent re-attach at the current playhead when a session idles out
(segment/playlist 404 or an hls.js fatal error). Quality (`max_height` ladder),
audio-track, and subtitle burn-in choices re-decide and start a new session at
the current position rather than switching in-stream; resume/watch-progress
works unchanged over the 1:1 VOD timeline.

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
video/audio codecs and their primary-stream bitrates, the primary audio sample
rate, and duration for card hover preview and exports; SQLite extracts only
those JSON keys in the existing batched membership query, while unlinked paths
remain null. Image files are
openable when they are browser-native or
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

Stopping a job takes three paths, because a checkpoint is not always close
enough to be the answer. A **queued** job is closed out where it is cancelled —
nothing is running it, so flagging it and leaving it queued would only let a
worker start work already refused. A **running** job sees the flag at its next
checkpoint. Work that spends minutes inside a single external call sees it
sooner: `core/abort` holds a cooperative abort signal in a context variable, the
worker binds it to the job for the duration of the handler, and `run_ffmpeg`
waits in short slices so it can stop the process where it stands rather than a
whole file later. `OperationAborted` sits deliberately outside the error types
callers treat as a failed derivative, so a stop is recorded as CANCELLED rather
than as work that failed — and a handler building into a temp directory must
clean up in a `finally`, since a stop does not pass through its failure path.

A job whose process dies leaves its row RUNNING with nobody left to finish it.
The registry is server-local and its worker runs in-process, so any RUNNING row
a worker finds while taking over the queue is by definition abandoned; it closes
them out as FAILED ("interrupted"). That is what stops a dead job occupying the
sidebar forever, absorbing cancels no one observes, and blocking the dedupe that
matches QUEUED. Recovery is a rerun: the library-wide jobs all skip work that is
already current, so it costs only what was lost.

Client import batches reuse the **presentation**, not the execution model: each
active batch is another stoppable row in `sidebar__foot` beside every active job.
The row names the current file and its position in the original selection;
collision resolution is a waiting state, and a stop becomes a disabled
"Stopping import…" control while the in-flight request unwinds. Imports and jobs
render as one list, so an upload never replaces or hides concurrent maintenance
work. A stopped batch is reported as a partial success — completed imports,
skips, the interrupted file, and files never attempted — rather than as a failed
job or an implied rollback of the files already copied.

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
registry connection while bytes stream. The desktop shell starts and polls the
anonymous pairing side while an unlocked same-origin browser approves scope;
its stored bearer covers JSON and relayed media requests. Library auth status
validates explicit bearer credentials so a scoped protected library mounts
without a browser cookie. Passphrase-less libraries remain
anonymous when no Bearer-scheme header is supplied; unrelated authorization
schemes continue through the cookie path. Existing but unreadable manifests
fail closed, and setting or replacing a library passphrase revokes every live
device token scoped to that library. Unavailable libraries cannot be selected
for pairing but do not block emergency token revocation. `GET /api/v1/health` advertises
`api_features` (`trickplay`, `hls`, `progress`, `pairing`) for additive client
feature detection. This remains a private-network guardrail, not multi-user
auth or public-internet hardening. Production compose still binds locally by
default and is intended to sit behind a private network/Tailscale or an
authenticating reverse proxy, not the public internet.

## 14. Known architectural debt

- grouping bundle/container reclassification before apply;
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
