# Architecture

## Portable library storage

[ADR-0035](adr/0035-portable-library-format.md) defines the supported application
format. Normal Create produces a complete portable catalog. Open refuses the old
`cairndex.library` format. No automatic conversion or source mutation occurs.
Working databases, drafts, jobs and caches are private to the serving instance;
the library folder contains its descriptor and immutable metadata history.
Shared ORM and media utilities also support synthetic conversion fixtures. They
do not enable legacy library admission.

Optional access settings are independent per library and server. Hashes live in
`CAIRNDEX_DATA_DIR/library-access/<library_uuid>.json`, outside recovery generations.
Recovery keeps these destination settings. Manage libraries provides access and
private backup controls. See [private recovery](replica-recovery.md) for coverage,
Release, review, activation and explicit retry.


This reference describes implemented storage, serving, media and desktop boundaries.
The [product brief](product-brief.md) defines product intent;
[Project status](STATUS.md) separates current audit dispositions from historical
validation. Accepted ADRs govern decisions; proposed ADRs remain unratified even
where related mechanisms exist in code.

## Playback control and timeline

The [shared viewer](playback.md) separates requested playback from actual pause
and buffering. Media identity owns queued commands; engine identity fences late
events and play results. HLS keeps one VOD timebase across bounded runs, and
incomplete native endings use session recovery without playlist advancement.
Diagnostics remain bounded and local to the viewer.

## Shared-server edit protection

[ADR-0030](adr/0030-shared-server-edit-bases.md) reserves the SQLite writer before
validating an authored request's retained read basis. Persistent unit-clock triggers
cover HTTP and internal writers; content and exact retry receipts commit together.
Clients retain field drafts, use membership deltas, and poll a small revision read to
refresh connected views. [Shared-server edits](shared-server-edits.md) inventories the
protected actions and the separate observation/source-operation boundaries.

## Private metadata replicas

Normal format-three creation uses a private creation intent, independent
seed validation and descriptor-last publication. Completion retries retain the
same package identity and refuse conflicting bytes. The
[creation contract](proposals/unified-library-creation.md) remains restricted to
new roots that can contain source files.

[ADR-0029](adr/0029-cloud-metadata-replicas.md) defines private working databases
and immutable causal metadata transactions. Package version 1 supports bounded
bundle metadata; version 2 supports the complete authored catalog through linked
payloads, indexed revisions/projection, durable asynchronous jobs, retained branches
and private drafts. Scalars merge independently; membership, hierarchies, lifetime
and their validated dependencies use complete reviewed arrangements. Normal saves
and imports update indexed affected rows. Explicit branch recovery reconstructs
history in a separate private store in a background job.

[Private recovery](replica-recovery.md) snapshots SQLite online and independently
validates schema, complete immutable history and private references. A local
administrative command prepares an inspectable candidate, preserving the original.
Exact review hashes and a private process lock coordinate activation with Release,
requests, jobs, exchange and media drain. A private generation binding selects the
new store atomically; the live database is never overwritten. Fresh author
incarnations retain old immutable identities and private retry lineage under
[ADR-0031](adr/0031-private-replica-recovery.md).

[Manual Update](replica-discovery.md), gated by format three and ADR-0032, shares
the bounded replica worker. Private observations/candidates precede catalog
creation; reviewed groupings and verified repairs use guarded causal transactions.
Disk-backed planning retains complete directories and settled owners across worker
batches. Normalized candidates and prepared values support paged collection review,
required ancestors and partial acceptance. Optional authored content evidence
distinguishes complete SHA-256 from samples; full large-file reads require an
explicit cancellable verification job. Same-path claims participate in conflict scopes; inode and
availability remain private. Discovery receipts commit atomically with authored
events, and recovery retains exact prepared intent for explicit revalidation.

The media adapter reads validated authored rows into detached file/track values;
it never presents the catalog as a legacy ORM session. Allowlisted indexed media
routes share the existing playback decisions, viewer and HLS manager. Observations,
resume and cursors stay private, and source generations fence bytes, caches,
subprocess inputs and progress. Playlist reads touch metadata only; selected-file
probes are bounded. [Local media](replica-catalog.md#local-media) defines the limits.

Bulk catalog reads use explicit bounded bundle IDs and retain displayed field,
lifetime and membership bases. Background previews prepare one causal transaction;
the client retains its exact targets and retry identity until the receipt is known.
Random ordering uses a seed with stable IDs. Missing Files reads recorded private
unavailable observations. Unbundled reads authored provisional files with bounded
pages. These query paths do not inspect source bytes or add shared local facts.

The ordinary browse adapter uses private FTS5 and indexed catalog rows, with SQL
search/count/order before bounded pagination. It reuses the shared virtual browser
and scalar inspector controls. Causal job receipts advance only acknowledged field
bases; pending requests and newer drafts remain separate. Complete conflict review
retains its existing controls. Legacy ORM mutation paths remain fenced.

Ordinary inspector membership choices use paginated projection reads and retained
preview jobs. Explicit Apply preserves edge/lifetime bases and collection-cover
clearing. Cover drafts retain the selected file's lifetime basis. Guarded cover
derivatives and selected-file facts use the private media adapter; these local
observations never enter authored history. No content schema migration is required.

The API and shared app select the advertised capability. Replica packages never
open legacy content/lease/source-write paths. The [catalog workflow](replica-catalog.md)
and [migration contract](replica-migration.md) define wire limits, schema inventory,
synthetic conversion/rollback and unavailable real conversion.

## Library release and recovery

Release stops new library requests and drains admitted work before closing the
private store, exchange handles and media sessions. The registry retains Release
intent across restart. Reopen permits serving again. Client disconnects do not
release a library. A failed drain keeps admission closed; retry Release.

Private recovery preparation and activation require Release and acquire the
private binding lock. A persisted Release flag alone does not prove drain is
complete. Recovery creates a separate candidate and leaves original stores intact.
The owner reviews the candidate before activation. Snapshots exclude source media,
credentials, server settings and browser text that has not reached the server.

## 1. System overview

Cairndex is a single-owner application. FastAPI serves one or more registered
portable libraries. React runs in a browser or the Tauri desktop host. Each root
contains source media and immutable authored metadata under `.cairndex`. Private
SQLite, credentials, jobs and media caches stay in server storage. A registry maps
stable library IDs to mounted roots. ffmpeg and ffprobe process selected media.

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
request scope, so it cannot fan out requests that the server must reject. The remembered server and library remain intended destinations during outages;
no available sibling silently replaces them. Retry refreshes registry availability,
and the persistent server controls can select or reconnect another destination.
Registry recovery polls while a row is unavailable or a read has failed. Ownership
and auth polling detect changes during a session; content remains behind their gates.

Ownership connection controls accept the advertised address or an explicitly
chosen alternative, including saved desktop addresses. Alternatives use the same
connection preparation and portable library UUID check. They do not infer server
identity from a display name, copy credentials, or change serving ownership.

Desktop activation verifies compatibility before committing stored selection and
transport. Preparation can be cancelled; the brief store/relay commit completes
atomically from the client's perspective. Failed configuration preserves the old
transport and restores the stored selection. A successful reconnect creates a new
QueryClient even for the same server. Within a server, library switching removes
content queries and advances a monotonic request scope. Guarded responses, mutation
callbacks and cache access stop late continuations from reaching a replacement
library. Explicit new-library indexing follows its server and library across a
selection change. Private drafts and content preferences include server/library
identity; local replica drafts use the stable managed-local key across ephemeral
sidecar ports. See [connections](connections.md).

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
the window handle.

The desktop window prevents file drops from navigating away from the application.
Portable libraries support reviewed file-picker Copy and bounded source operations
through the private journal described below. Incoming OS drag remains paused.
Retained native import and journal utilities are not an application workflow.
Native mapping and drag integration have separate qualification limits in STATUS.

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

Normal operations preserve source media. Metadata publication writes immutable
objects to `.cairndex`; generated derivatives stay in private server storage.

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

Current content endpoints are scoped under `/api/v1/libraries/{library_id}/replica`:
`catalog` serves authored metadata, `media` serves local files and derivatives,
and `discovery` manages Update. Private administration uses `auth`, `ownership`
and `private-recovery`. Registry routes create, register and remove registrations.

Old ORM route definitions and source-journal utilities remain for internal tests.
Public admission refuses the old format, and portable packages cannot open a
folder SQLite database through those routes. They are not supported application
workflows. Current OpenAPI documents the available route definitions.

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

The app has one selected server and one intended library and routes content requests
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
- **File Browser:** filesystem browser, read-only by default, over the active library root,
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
directory File Browser names, and local file-selection filters. Exact-name checks for
inline **Create** actions remain literal, so a pinyin alias never suppresses
creating a distinct Latin name. `pinyin-pro` is lockfile-pinned and runs fully
offline; its dictionary is a separate ~142 kB gzip lazy chunk loaded when a
search-bearing surface mounts, keeping it out of the initial app bundle. The
maintenance cost is one frontend-only dependency and its lockfile update; there
is no schema, API, server runtime, or external-service dependency.

Bundle Browser uses the SQLite FTS path described in §9. Unbundled uses literal
server-side filename matching. Neither indexes pinyin aliases; server-side pinyin
matching remains outside the local picker enhancement.

The current sidebar maintenance flow exposes one primary **Update** button plus a
small overflow menu for **Scan new files**, **Collect metadata**, **Suggest
grouping**, and **Generate storyboards**. Update waits for scan/grouping-plan
generation, refreshes the UI, and opens grouping review immediately. Metadata
probe continues in the shared background-job area; storyboard generation is
chained for the same library after successful probe because eligibility and
sampling need duration.

**Scan new files is discovery on its own.** The grouping pass is a separate item
in the same menu, so the scan job takes `suggest_grouping`
(`POST …/jobs/scan?suggest_grouping=false`) and reports a null
`grouping_plan_id` when it is off — the client opens grouping review off that
key, so a scan-only run cannot open a dialog nobody asked for. Update sends the
default and is unchanged.

**Creating a library indexes it.** A folder that has only become a library holds
no rows, so every surface is empty and the playback decision has no metadata to
work from. `useIndexNewLibrary` enqueues discovery (without the grouping pass)
then metadata, scoped to the new library id rather than the active one, and
nudges the active-jobs query so the sidebar reports it like any other job.
Storyboards stay deliberate. *Registering* an existing library does not trigger
this: it arrives with its own database, and re-reading a large tree unasked is
what Update is for.

## 4. Library package and registry

The descriptor and immutable history in `.cairndex/` are portable. The complete
seed and retained transactions reconstruct authored metadata. The private indexed
SQLite projection serves queries; there is no working database in the library.
Normal Create records exact private intent and publishes the descriptor last.
Old-format admission is refused before content, ownership or source operations.

The private registry tracks registered roots, serving intent, device tokens and
`recovery_tasks`. Each recovery task stores its immutable request, library and
descriptor, state and result. A partial unique index permits one queued/running
task per library. The worker claims queued work with a conditional update.

`BindingLock` excludes a second process from the same private store. Release stops
new requests, drains admitted work and closes the binding. Recovery activation
requires the exact review receipt and process exclusion. Independent servers use
independent stores and never share a mutable SQLite database or a lease file.

Access hashes are stored outside store generations, under private `library-access`.
A protection change revokes device tokens and browser grants for that library.
Unreadable access records refuse access even if a browser previously unlocked it.
Recovery does not restore credentials or change destination access settings.

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
- `Moment` — one instant (`end_s IS NULL`) or one span the owner marked inside
  a video, with an optional comment and its own tags. Keyed by `AssetFile.id`
  with a denormalized `bundle_id` synced by the same re-parent hook
  `PlaybackProgress` uses. A moment's tags propagate to its bundle additively
  (ADR-0025); a range moment is the loop pair the player's clip range loops.

File reads return nullable notes and verbatim origin text (`AssetFile.source`),
including non-HTTP strings. Displayed file names derive from the current path;
the stored legacy title is retained without alias inference. File name writes
accept only omitted/null values or an exact filename echo; other names fail
before mutation. See the [file contract](data-model.md#asset_files).
Bundle-level source links are deferred until there is a clear product need.

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
  proposals, accepting either the target bundle heading or file list as a drop.
  Bundle and new-collection proposals can be reparented among speculative
  CONTAINER proposals by drag-and-drop. Their bounded, searchable placement
  popover instead reads only the library's current persisted collections and
  renders that hierarchy as independently foldable indented rows; draft
  collection suggestions never appear as settled picker destinations. Proposal
  rows show only their direct destination; full paths remain in accessibility
  labels and tooltips, while search results add only their direct parent for
  visible disambiguation. Choosing a persisted collection resolves its current
  ancestor path into stable read-only plan context and returns the committed
  whole plan. New proposals can be retitled/reclassified before apply, while
  existing collection context is read-only. Reviewed file sequence becomes
  playlist order;
- review folding is client-only state keyed by proposal content: a collection
  disclosure hides its descendant proposal list and a bundle disclosure hides
  its file list. Plans start expanded; per-row and global fold controls never
  change selection, placement, drag targets, persisted plan data, or apply
  payloads;
- additions to confirmed bundles retain that bundle as a reversible target while
  persisting a target-title snapshot, a derived fresh-bundle title, and the
  owner's existing/new destination choice; switching modes recomputes roles but
  preserves the reviewed sequence and proposal identity;
- relevant existing collection branches remain in the review plan even when
  their confirmed bundles are excluded; additions prefer their target bundle's
  collection, while fresh top-level proposals reuse the deepest matching
  collection path. Those structural nodes carry stable `target_collection_id`
  values, so apply reuses the exact collection and conflicts if it disappeared
  or moved instead of inferring identity from a repeated name;
- only file-backed bundle proposals are accepted. Collection checkboxes are
  tri-state bulk selectors for descendant bundles, and apply computes the full
  ancestor closure of each selected bundle. Empty bundles and collections with
  no file-backed descendants therefore expose no selectable work;
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
- a bundle-to-collection conversion response is a durability boundary: it
  commits the new child proposal IDs and reloads the complete plan before those
  IDs reach the client, so an immediate apply request cannot outrun request
  teardown or inherit a stale ORM proposal collection;
- the apply API supports selected proposal ids and resolves only their required
  collection paths. Accepted rows retire; unchecked bundles retain their proposal
  IDs and edits in the same open plan until the remaining work is accepted;
- acceptance commits library metadata and its exact request receipt before retiring
  plan rows. A pending settlement on that receipt finishes disposable-plan cleanup
  before subsequent metadata reads/writes. Recovery never reapplies content, and
  startup still discards unconfirmed plans (ADR-0022). Superseded plans cannot apply.

Incomplete walks mark unseen links missing but defer new staging and moved-file
repair until a complete retry; Update reports the incomplete read as a failed job.
The scanner ignores media symlinks, fences root identity at commit/reconciliation
boundaries, and preserves journaled trash state. A cancelled walk retains committed
same-path observations without accepting provisional grouping.

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

Clients should resolve that relative to the VTT URL using normal URL rules.

Three surfaces consume the sheets, all cropping client-side rather than asking the
server for a frame: the seek-bar hover tooltip, the grid's hover preview, and each
**moment** row in the Bundle Inspector (plan 7). The last is why a moment
needs no thumbnail of its own — the sheet already exists for every scanned video,
and the crop is the same `StoryboardTile` the other two use. A video whose
storyboard has not been generated yet simply draws the row without one.

The
VTT is an application index for trickplay loaders, not a browser `<track>`.
After a storyboard format change, existing libraries require an explicit
Update/storyboards run; request handlers never generate derivatives on demand.
The library-wide job enumerates candidates in bounded keyset-paged batches and
fully buffers each page before starting ffmpeg. Its per-file progress callback
is also a content-session commit/cancellation checkpoint, so a streaming SQLite
cursor must never survive across that callback; this matters most when a slow
network file keeps one page active for minutes.

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
  subtitle, a source taller than the height cap, **a colour depth the client did
  not confirm, or Dolby Vision** forces transcode. Legacy rows missing M1 keys
  degrade safely (unknown codec is optimistic; it never 500s).
  The response also carries duration, audio streams, subtitles, chapters,
  `storyboard_url`, and resume `progress`. For `direct` it returns a
  `stream_url`; for remux/transcode it **starts an HLS session** and returns
  `{session {id, playlist_url}}`. A client that already received `direct` may
  repeat the decision with `force_hls` and `start_s` when progressive delivery
  proves unhealthy. If that client declared HLS support, the server preserves
  the codecs and starts a copy-only remux at the requested source segment;
  otherwise the original decision is unchanged.
- **An `hev1` source is relabelled rather than remuxed.** AVFoundation refuses
  the `hev1` four-character code at every colour depth while MediaSource accepts
  it, which is the only reason such a file needed a session: MSE is the only route
  to a decoder that takes it, and HLS the only route to MSE. But the two tags
  differ in five bytes — the sample-entry fourCC and `array_completeness` on the
  VPS/SPS/PPS arrays in `hvcC` — so `media/hevc_relabel` finds those offsets and
  the stream routes patch them as the bytes go past (`media/ranged_stream`), which
  is byte-identical to what `ffmpeg -tag:v hvc1` writes. The decision then treats
  the source as `hvc1` and answers `direct`. The guard is load-bearing: a file
  whose parameter sets are not provably complete in `hvcC` returns no relabel and
  goes to a session, because claiming `hvc1` for a stream that varies them in-band
  breaks playback partway. Offsets are cached in-process on the file's identity,
  so the decision and the stream route do not each re-parse `moov`.
- **Depth is asked for separately from the codec family**, because the family is
  not the whole answer: every capability string a browser can be probed with
  (`avc1.640028`, `hvc1.1.6.L93.B0`) names an 8-bit profile, so a 10-bit source
  clears the family test and is then refused by the engine. Clients advertise
  `h26410`/`hevc10`/`vp910`/`av110` alongside the family names for the depths
  they separately confirmed (`viewer/player/caps.ts`), and a source deeper than
  8 bits needs the matching token. Same shape as the `hvc1`/`hev1` codec tags
  beside it, and equally optimistic when the row carries no depth.
- **The row is topped up on the way to the decision.** An unprobed row has no
  codec, depth or duration, and the matrix is optimistic about all three — so
  playback would answer `direct` for everything in a library whose metadata job
  has not run. `probe_service.ensure_probed` probes that one file's header
  (bounded by `ON_ACCESS_PROBE_TIMEOUT_S`, under the client's 15 s decision
  deadline), writes it back, and stays silent on failure. The library-wide probe
  job is still what fills a library in bulk.
- **A File Browser path need not be indexed at all.**
  `POST /api/v1/libraries/{library_id}/file-browser/playback-decision` takes a
  library-relative `path` instead of a file id and reaches the same matrix and
  the same sessions, with `probe_service.probe_path` (a small identity-keyed
  in-process cache) standing in for stored metadata. Its sessions live under
  `…/file-browser/playback-sessions/{session_id}/…` and share the manager,
  concurrency bound, and reaper with the per-file ones; internally they are
  keyed for reuse by `path:{relative_path}`, which never leaves the server. What
  needs a row is absent rather than faked: subtitles, storyboards, resume, and
  cover frames. Path safety is the File Browser's own — relative only, no
  traversal, no symlink escape — and non-video paths are refused.
- Sessions are interactive in-process runtime state, **not** background jobs
  (`media/hls.SessionManager` — a dict guarded by locks, not the `job_queue`).
  `POST .../playback-sessions` starts one explicitly (e.g. a mid-play
  quality/audio switch with `start_s`); `GET .../{session_id}/index.m3u8`
  returns a VOD fMP4 playlist computed up front from the known duration (6 s
  target); `GET .../{session_id}/{init.mp4|{n}.m4s}` serves the shared init
  segment and media segments; `DELETE .../{session_id}` tears the session down.
  One ffmpeg per session writes only the requested segment plus the configured
  lookahead, then exits; the next uncached segment starts another bounded run.
  This keeps copy-remux from duplicating the whole source at disk speed on the
  NAS. Serving a segment ahead of the encoder waits (bounded), and a far seek
  kills and restarts ffmpeg at the requested segment (`-ss` + `-start_number`).
  Each run writes a distinct init file, and the stable init route publishes it
  only after the first complete media fragment proves the init is closed. Remux copies video with an
  AAC audio fallback; its playlist follows source keyframes found by a bounded
  probe, with a uniform-grid fallback when probing fails. Transcode uses
  `libx264` `veryfast` with `force_key_frames` for exact 6 s boundaries and a
  capped ladder honoring `max_height`.
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
works unchanged over the 1:1 VOD timeline. Native progressive delivery is also
observed: a seek that remains unresolved for 3 seconds, sustained playback below
75% of real time for 8 seconds, or a dead read transparently re-decides with
`force_hls` at the live playhead before surfacing the existing interrupted card.
This is a delivery fallback, not a format fallback, so it remuxes without video
encoding. A deployment can set `CAIRNDEX_PREFER_HLS=true` to make that copy-only
HLS decision from initial play instead. Production Docker Compose does so by
default because remote progressive playback can generate enough short Range
requests to starve despite ample aggregate NAS throughput. A viewer opened from
a saved moment seeds the hook's first `startAt`, sends the same value as
`start_s` in that initial decision, and configures hls.js `startPosition` before
auto-loading begins. An HLS-first deployment therefore creates its first bounded
generation near the moment and gives the client that same initial load target,
instead of relying on a separate post-metadata seek to redirect an already
running pipeline. hls.js may still request leading fragments to establish its
timeline before fetching that target; those probes are distinct from choosing
time zero as the intended playback position.

## 9. Filtering and Smart Collections

Filters use a canonical JSON AST (`version`, logical nodes, predicate nodes), not
raw SQL. Pydantic validates incoming expressions and an allowlisted SQLAlchemy
compiler produces bound-parameter queries. The same compiler powers live filter
preview, filtered browse, and Smart Collection CRUD/browse.

The Smart Collection editor supports one all/any condition group. Saved expressions
outside its faithful subset have protected conditions while renaming remains
available. Unrelated saves omit the filter and retain the opening concurrency
version. Preview, browse and facets share the visible-bundle scope; empty and
confirmed missing bundles remain eligible, while scan-staged and hidden-only
bundles are excluded. See [filter contracts](filter-language.md).

Text search covers the whole active library through `cairndex.search`. The
`bundle_search` FTS5 table indexes bundle titles, every ordered bundle note,
member-file notes and moment comments. File names, paths, origins, media kinds,
tag names and collection names are excluded; explicit tag/collection and file
predicates remain available. Collection-name exclusion is the current working
assumption. Unbundled files remain outside ordinary Bundle Browser search.

SQLite triggers maintain the affected bundle rows on note/title edits, file
membership changes and moment insertion/edit/deletion. Moment ownership resolves
through its file; grouping transfers move its searchable comments too. Unrelated
technical metadata and tag/collection changes do not rewrite FTS rows.

Each FTS `rowid` equals its bundle's SQLite `rowid`; trigger maintenance uses that
key, avoiding scans of the unindexed `bundle_id` column. The version-two source
view carries an explicit schema marker. On ownership-approved library open,
`ensure_search_schema` checks columns, version and trigger definitions. A stale
cache is replaced and filled in batches of at most 256 bundle rowids inside one
explicit SQLite transaction. Failure rolls back the old cache and schema together;
a successful reopen does no rebuild. Migration total work scales with library
size and holds a write transaction; Python holds only one batch. Sources and
saved metadata are unchanged. Manual maintenance rebuilds use the same batches.

Browse's `q` parameter
tokenizes user input into safe quoted prefix terms and composes as a
non-correlated FTS semijoin (`AssetBundle.id IN (SELECT bundle_id FROM
bundle_search WHERE bundle_search MATCH ?)`), so it stacks with views,
collections, filters, sort, and pagination. Results keep the active sort;
relevance ranking is future work.

Complete catalogs use the same AST compiler through query-local relations over
private committed rows. Counts, previews and sorting precede pagination. These
relations do not create a legacy content database. Unknown device observations
retain SQL unknown semantics; source reads remain separate from bundle queries.

## 10. File Browser

Complete catalogs connect the shared File Browser to a no-follow, root-scoped
direct-directory read. Local entries and catalog paths remain distinct; absent
bytes cannot remove metadata. The physical list keeps its unpaginated directory
contract. The indexed catalog endpoint keeps cursor pagination. See the
[catalog boundary](replica-catalog.md#ordinary-browse-and-edit-boundary).

The Unbundled queue uses
`GET /api/v1/libraries/{library_id}/manual-bundling/unbundled-files` with `q`,
`sort=name|type|size|added|modified`, `order=asc|desc`, `offset` and `limit` (1–200).
It queries indexed scan-staged files within that library without filesystem I/O.
Hidden path segments follow the scanner's shared visibility rules. Literal
case-insensitive filename substring matching, global ordering and stable
name/path/ID ties precede pagination. Date Added is the DB indexing time; Date
Modified is stored mtime. SQL counts the eligible set and returns only one page;
substring matching and global sorting still examine the eligible rows.
Query keys include library and criteria, criteria changes start at offset zero,
and cancelled/old-scope requests cannot populate the current view. Empty results
and failed reads have distinct messages with retry. Pagination is deterministic
for an unchanged catalog; concurrent catalog edits can change offset boundaries.
General recursive filesystem search and directory pagination are separate work.

File Browser lists the active library root through a read-only endpoint:
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
right pane shows file details. Source writes are unavailable.
Directory listing currently returns the complete directory; pagination is
owner-deferred. Unbundled uses the separate paginated SQL path above.

## 11. Background jobs

The replica worker performs bounded exchange, catalog jobs and Update work for
opened private stores. Durable catalog jobs retain exact operation identities.
A separate single worker runs registry-backed private backup and recovery tasks.
Only one queued or running recovery task is allowed per library. Startup marks
interrupted recovery tasks for explicit retry. Running recovery operations finish;
queued recovery tasks can be stopped.

The old registry `job_queue` and worker utilities remain for synthetic model
checks. The application does not start that worker. No Redis or Celery is used.

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

- measured large-library aggregate/descendant-query tuning and broader scale qualification;
- ambiguous cross-filesystem/content-changed repair and duplicate verification beyond
  the implemented explicit unique-candidate relink;
- scheduled scans and stronger job scheduling;
- incomplete, paused desktop file integration: QSpace, multi-file OS delivery and
  app-origin self-return;
- token rotation/expiry and hardened public exposure, beyond optional private-network guards;
- embedded subtitle extraction to servable text tracks (M8) — the web
  hls.js/native-HLS engine integration for the M6 remux/transcode sessions
  landed in M7;
- ADR-0014, ADR-0015 and ADR-0017 still require owner ratification. Implemented
  HLS caches are server-local and ephemeral under `{CAIRNDEX_DATA_DIR}/transcode/`,
  outside the library package; that implementation does not ratify ADR-0014.

Managed library connections disable SQLite's implicit checkpoint on last close.
Lost-owner disposal therefore retains the database and WAL recovery bytes without
folding them into the main file. Clean handoff explicitly checkpoints through a
fresh connection after draining; an old session factory cannot revive a retired
engine after reopening.

## Portable source-operation workers

`replicas/source_journal.py` retains exact private intent and review state.
`source_plan.py` prepares filesystem and catalog conditions. `source_execute.py`
applies accepted reviews with durable capture and publication checkpoints.
`source_files.py` supplies no-follow reads, independent versions and atomic
no-replace relocation. `source_claims.py` binds shared recovery directories to
private authors and exact intent. `source_undo.py` prepares conditional inverses. `source_trees.py` creates bounded
directory versions and content indexes; `source_catalog.py` retains catalog
identity across directory operations.

A pool of two source workers uses library lifecycle admission and the per-library
exchange lock. HTTP exchange does not execute source copies. Byte-block checks
observe cancellation, Release, root identity and write permission. Source receipt
exchange never executes a remote physical operation. `catalog_source_edit` roots
make the changed semantics explicit to strict older readers. See
[ADR-0036](adr/0036-portable-source-operations.md).
