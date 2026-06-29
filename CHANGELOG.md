# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Added

- **External subtitle auto-link across grouping flows (ADR-0009, phase 6).**
  Grouping a video with its sidecar `.srt`/`.vtt` now links them everywhere a
  bundle is formed, not only via the grouping-plan apply: **fast-add** with
  single-bundle grouping runs `auto_link_external_subtitles` and reports
  `subtitles_linked`, so the ADR-0003 data-model claim ("external subtitles
  auto-link to a same-directory video by basename, language/forced parsed from
  the suffix") holds for the scan/grouping and manual-grouping flows alike.

- **Re-scan additions into confirmed bundles (ADR-0009, phase 5).** When a file
  is discovered in a directory already owned by a *confirmed* bundle, the
  suggester now proposes folding it into that bundle (an **addition** proposal,
  `target_bundle_id` set) rather than spawning a fresh one — so a re-scan that
  drops `cosmos.fr.srt` next to a confirmed *Cosmos* bundle suggests "add to
  Cosmos", never disturbing the confirmed grouping. Applying an addition moves
  the file in, assigns a role, links subtitles, removes the emptied provisional
  bundle, and is idempotent + conflict-aware (a file the user moved into a
  different confirmed bundle is left alone). The apply result reports
  `files_added_to_bundles`; the review UI shows additions as "Add to …".

- **Grouping review UI (ADR-0009, phase 4).** A new sidebar **⧉ Group** action
  opens a review modal that suggests a grouping for the active library and shows
  the plan — proposed bundles and the logical containers that would hold them,
  with each file's role, a confidence badge, and a reason — then applies it on
  confirmation (confirming bundles, creating collections, and linking subtitles;
  nothing on disk changes). The apply result reports how many bundles/collections/
  subtitle links were made and surfaces any conflicts (files that moved, vanished,
  or were already grouped by hand). `useGroupingPlans` / `useGroupingPlan` /
  `useGenerateGroupingPlan` / `useApplyGroupingPlan` wrap the ADR-0009 phase-3
  routes; applying invalidates the browse/collection views. (Interactive
  edit-before-apply — merge/split/reclassify/rename — is a follow-up; this lands
  the review + accept-all + apply slice.)

- **Grouping plan apply service + API (ADR-0009, phase 3).** Durable
  `grouping_plans` / `grouping_proposals` / `grouping_proposal_files` tables store
  a reviewable snapshot of the suggester's output (parent links by
  `parent_proposal_id`; proposal files reference `asset_file_id` as a snapshot id,
  not an FK, so a vanished file surfaces as a conflict rather than cascading). New
  library-scoped routes: `POST /grouping/plans` (suggest + persist, superseding
  the prior open plan), `GET /grouping/plans`, `GET /grouping/plans/{id}`, and
  `POST /grouping/plans/{id}/apply`. Apply is the only step that confirms
  groupings: it merges/splits provisional bundles **preserving `AssetFile.id`**
  (so moved-file repair, subtitles, thumbnails, and notes stay stable), assigns
  roles, selects cover/primary, links external subtitles, and creates the logical
  collections a CONTAINER suggests — never touching the filesystem. It is
  idempotent (re-applying a settled plan is a clean no-op) and conflict-aware (a
  proposal whose files vanished or were manually regrouped is reported as a
  localized conflict and skipped, never overriding a confirmed user decision).

- **Read-only grouping suggester (ADR-0009, phase 2).** A pure heuristic
  (`cairndex.grouping`) turns the files observed in a library into a
  `GroupingPlan` of BUNDLE / CONTAINER proposals with per-file roles, ordering,
  a confidence, and a human-readable reason — leading with content signals and
  using names only as a hint. A folder with one video plus sidecars (or a
  multipart video) reads as a **bundle**; a folder of unrelated items or one
  holding sub-bundles reads as a **container** (a logical-collection suggestion,
  never a filesystem move); nested folders recurse. Roles are derived as ADR-0003
  prescribes (primary video, cover = `cover`/`poster`/`thumb…` image else first
  image, external subtitles, sequence by natural order). Files already in a
  *confirmed* bundle are excluded, so confirmed decisions win over heuristics.
  This phase is read-only: a thin DB adapter (`grouping.service`) snapshots the
  current library and returns a plan; persisting and applying it is phase 3.

- **Bundle grouping review state (ADR-0009, phase 1).** `asset_bundles` now
  carries `grouping_state` (`provisional` | `confirmed`), `grouping_source`
  (`legacy` | `scan_suggestion` | `manual` | `fast_add` | `import`),
  `grouping_rule_version`, and `confirmed_at`. The scanner stages newly
  discovered files into `provisional` / `scan_suggestion` bundles awaiting
  review; fast-add and manual creation produce `confirmed` bundles (the user
  already chose the grouping). Bundles created before this change backfill as
  `confirmed` / `legacy` via server defaults. `grouping_state` /
  `grouping_source` are exposed on `BundleRead`. This is schema-and-state only:
  the suggester, apply-plan service, and review UI land in later ADR-0009
  phases, and browse behaviour is unchanged for now.

- **Frontend wiring for optimistic concurrency + per-library maintenance jobs.**
  The bundle inspector and Smart Collection editor now send the entity `version`
  as `If-Match` on edits; a 409 conflict surfaces an inline notice ("changed
  elsewhere — save again to apply over the latest") and the view refetches the
  current server state instead of silently overwriting another client's change.
  The sidebar gained a **Library maintenance** row with **Scan** and **Probe**
  (ffprobe technical metadata) actions; each disables while running and refetches
  affected views.

- **Optimistic concurrency for metadata edits (ADR-0008, phase 9).** The
  frequently edited entities (`asset_bundles`, `asset_files`, `tags`,
  `collections`, `smart_folders`, `subtitle_tracks`) now carry a `version`
  integer (starts at 1, bumped on each edit). Single-entity `PATCH` routes —
  bundles, files, tags, collections, and smart collections — accept an optional
  `If-Match: <version>` header: a stale value is rejected with **409**
  (`version_conflict`) before anything is mutated, while omitting the header
  keeps the previous last-write-wins behaviour (back-compatible). `version` is
  exposed on the read models; OpenAPI and frontend types were regenerated.
  Increment is explicit in the service layer (`persistence/concurrency.py`) so
  internal scan/repair writes never risk `StaleDataError` under the single-writer
  model.

### Changed

- **Update library opens grouping review instead of leaving stale provisional cards.**
  A successful scan job persists an open ADR-0009 grouping plan and returns its
  id/proposal count in the job result without applying it. The frontend now
  treats **Update** as the primary maintenance flow: it waits for filesystem
  discovery/repair, grouping-plan generation, and metadata probe completion
  before invalidating browse/counts/File View/grouping queries, then opens the
  grouping review modal when suggestions exist. Provisional scan-created bundles
  are visibly marked "review" in browse results until the user applies grouping.

- **Hidden library/cache paths are excluded from scan and grouping review.**
  The scanner now prunes dot-directories such as `.cairndex`, skips hidden
  files, drops previously scan-staged provisional hidden rows from local metadata
  on the next scan, and grouping plans ignore hidden paths. Browse also hides
  hidden-only bundles while preserving legitimate empty bundles.

- **Grouping review supports selected accept.** The review modal now explains
  that **Regenerate suggestions** reruns the same heuristic against current
  library state, so unchanged inputs usually produce the same result. Proposals
  have checkboxes, parent toggles cascade to children, **Select all** /
  **Deselect all** controls are available, and **Accept selected** applies only
  the checked proposals.

- **Thumbnail actions moved out of the global sidebar.** The backend thumbnail
  job/API and lazy thumbnail endpoints remain, but the prominent sidebar button
  is removed. Cover fallback now uses explicit cover, then first image, then
  selected/first video, so video-only bundles are still thumbnailable.

- **Individual maintenance actions moved behind the Update overflow menu.** The
  sidebar now shows one primary **Update** button plus a small maintenance menu
  for exception cases: scan new files, collect metadata, or reopen grouping
  review.

- **Per-library derived cache (ADR-0008, phase 8).** Thumbnails and converted
  WebVTT subtitles are now cached inside each library's portable
  `<root>/.cairndex/cache/{thumbnails,subtitles}/` (paths derived from the
  library root via `registry.library_package.cache_dir`) instead of the
  server-global `{CAIRNDEX_DATA_DIR}/cache`. The cache now travels with the
  library folder and is never written beside source media. Removed the unused
  `Settings.cache_dir`. A future `cache_mode` (`inside_library` | `server_local`,
  default `inside_library`) is documented for opting large transcodes into a
  server-local cache; portable cache trades a larger backup footprint for
  self-containment.

- **Per-library content migration — create → scan → browse (ADR-0008, phases
  3–5/7).** Breaking, pre-release clean break. All content metadata now lives in
  each library's own `.cairndex/library.db`; the server keeps only a registry
  (libraries + job queue).
  - **Schema collapse:** dropped the `storage_roots` table and
    `asset_files.storage_root_id`; `asset_files.relative_path` is now relative to
    the library root with `UNIQUE(relative_path)`. The content `jobs` table moved
    to the registry's `job_queue`. Library DBs are created via `create_all` (no
    Alembic chain).
  - **Per-library engine + routing:** content APIs moved under
    `/api/v1/libraries/{library_id}/…` (bundles, collections, tags, tag-groups,
    smart-collections, filters, file-view, playback, fast-add, scan/probe/
    thumbnail enqueue). A `LibrarySession` opens the right `library.db`; path
    resolution derives the library root from the session.
  - **Per-library jobs:** the worker now drains the registry `job_queue`, opens
    the target library DB, runs scan/probe/thumbnail against it, and writes
    durable results into `library.db`.
  - **Frontend:** an active-library bootstrap (one per tab) routes all content
    requests under the selected library; the sidebar gained a library selector
    and a **Scan** action; the library manager creates/registers libraries.
  - The global storage-root APIs/UI are gone.

### Removed

- **Eagle import — removed entirely.** The one-way Eagle library importer is out
  of scope under the per-library model (ADR-0008): a Cairndex library is its own
  portable directory populated by scanning, not by migrating from another app.
  Deleted the `cairndex.eagle` reader/planner package, the `services.eagle`
  importer, its tests, and the `import_records` table / `ImportRecord` model.
  ADR-0004 is retained as superseded history. Cairndex's UI remains
  Eagle-*inspired* — only the import feature is gone.

### Added

- **Per-library engine + route scoping (ADR-0008, phase 2/3).** Introduces a
  per-library content engine/session cache (`cairndex.registry.library_engine`)
  and a `LibrarySession` dependency that resolves `{library_id}` against the
  registry, refuses an unavailable (offline/moved) library with 404, and opens
  the right `library.db` — no server-global "active library". The first
  library-scoped content routes land under
  `/api/v1/libraries/{library_id}/collections` (create/list/get/update/delete),
  alongside the existing global `/collections` (full migration is a later PR).
  Tests prove two registered libraries are fully isolated (a collection created
  in one is invisible to the other; each route reads its own on-disk
  `library.db`). OpenAPI + frontend types regenerated.

- **Per-library metadata architecture — registry skeleton (ADR-0008, phase 1).**
  Groundwork for moving from one global content database to portable, Eagle-like
  libraries (each a directory with a `.cairndex/` marker holding
  `manifest.json`, `library.db`, and `cache/`) while keeping the server/client
  split. Adds a separate **registry** database (`{CAIRNDEX_DATA_DIR}/
  registry.db`, package `cairndex.registry`) that tracks registered libraries
  (and a `job_queue` table for the future per-library worker), the on-disk
  library package handler, and global endpoints: `GET /api/v1/libraries`,
  `POST /api/v1/libraries/create` (builds the package + an initialized
  `library.db`), `POST /api/v1/libraries/register` (validates an existing
  marker), and `GET /api/v1/libraries/{id}` (availability re-probed on read).
  Existing storage-root-scoped content APIs are unchanged; routing them under
  `/libraries/{id}`, the per-library engine cache, and the `storage_roots`
  schema collapse are sequenced into later PRs. Backend tests cover
  create/register/list and the error cases (missing root, relative path,
  duplicate/existing library, missing marker, invalid manifest, unavailable
  path).

- **Shared library selector + File View file preview.** Collection View and
  File View now share a single active-library (storage root) selector. Browse
  results, sidebar system-view counts, and collection/tag counts are optionally
  scoped to the active library (`storage_root_id` query param on
  `/api/v1/bundles/browse`, `/counts`, and the filtered browse body), without
  changing the root-independent nature of collections. File View can now open a
  file in an in-app preview lightbox via a new read-only, path-safe content
  endpoint `GET /api/v1/storage-roots/{root_id}/file?path=...` (`FileResponse`
  with HTTP Range support; same scoping/safety as `/entries`, and files need not
  be linked into a bundle). Sidebar and file icons switched to inline SVGs
  (`app/icons.tsx`); the File View file table moved to a CSS-grid layout for
  column alignment.

- **Library management UI + path autocomplete.** Storage roots are surfaced in
  the UI as **Libraries**. A new manager (the "+ Library" button in File View,
  or the "Add a library" call-to-action when none exist) lists existing libraries
  with an available/unavailable badge and lets you add one by absolute server
  path — with **Jellyfin-style directory autocomplete** (`GET
  /api/v1/storage-roots/path-suggestions?path=...`, which lists only directories
  the server process can see) and an optional **"create the folder if it doesn't
  exist"** toggle (`StorageRootCreate.create_if_missing`, owner setup only). When
  a library's directory is offline/moved, File View now shows a clear "This
  library is currently unavailable" state instead of a raw HTTP error (the API
  client surfaces the server's structured message). Covered by backend tests and
  a Playwright e2e (`e2e/libraries.spec.ts`).

- **Read-only File View backend (Phase 4).** A new physical, storage-root-scoped
  filesystem browser, distinct from the logical Collection View:
  `GET /api/v1/storage-roots/{root_id}/entries?path=...`
  (`services/file_view.py`). Input is only `storage_root_id + relative_path`
  (omitted = the root); absolute paths, `..` traversal, NUL bytes, and symlink
  escapes are rejected. Hidden entries (dotfiles/dot-dirs, `__pycache__`,
  `node_modules`, `Thumbs.db`) are excluded; directories sort before files. Each
  entry reports name/relative-path/kind/size/mtime/extension/MIME, the app's
  media classification, a `supported` (natively previewable) flag, and a cheap
  `linked`/`bundle_id` hint. Strictly read-only — no move/rename/delete. OpenAPI
  and frontend types regenerated.
- **Read-only File View UI (Phase 5).** A sidebar mode toggle switches the center
  pane between the bundle-first **Collection View** and a new **File View**
  (`FileView`): a storage-root selector, breadcrumb navigation,
  directories-first listing, and `openable`/`unsupported`/`linked` badges, with
  loading/empty/error states. Selecting a file shows its path/size/MIME/openable
  details in a dedicated `FileInspector` (not the bundle inspector); File View
  selection never collides with Collection/bundle selection. No move/rename/
  delete controls. Covered by a Playwright e2e (`e2e/file-view.spec.ts`).
- **Moved-file repair during scans (Phase 6, ADR-0006).** The scanner now
  captures cheap filesystem identity (`st_dev`/`st_ino` → new `asset_files`
  columns `filesystem_device`/`filesystem_inode`/`identity_available`) and, on a
  re-scan, repairs high-confidence moves **in place** before creating new
  bundles: an appeared path is matched 1:1 to a disappeared row by filesystem
  identity (survives content edits on the same volume) or by quick fingerprint +
  basename, preserving `AssetFile.id` and the bundle's collections, tags, rating,
  note, cover/primary, and subtitle links. Ambiguous matches and copies are never
  auto-repaired or merged; same-path edits remain updates. Streaming/thumbnail/
  subtitle path resolution now re-checks existence at access time and marks a
  vanished file `missing`. No full hashing on the scan path. Migration backfills
  identity lazily on the next scan.
- **File View host-integration plan (Phase 7, ADR-0007).** Documents future
  `open with default app`, reveal-in-file-manager, and write-mode support as a
  native/desktop-client milestone, not part of the first read-only web File View.
  The first File View implementation remains read-only.
- **In-bundle view — open a bundle to browse and inspect its files.**
  - Double-clicking a bundle (grid card or list row) opens an inline **album
    view** in the center pane: a thumbnail grid of every file in the bundle,
    with a back-to-library breadcrumb. Clicking a file opens a fullscreen
    **viewer** (lightbox) showing the full-resolution image or an inline video,
    with prev/next navigation (on-screen chevrons and ←/→), an info-card
    fallback for files the browser can't render, and Esc to step back out
    (viewer → album → library).
  - New `GET /api/v1/files/{file_id}/content` serves a file's original bytes
    (path-safe, HTTP Range-capable, mime guessed from the filename) so the viewer
    can show full-size images; the video-only path resolver in `media/playback.py`
    was generalized into `resolve_file_path`.
- **Phase 8 — packaging and deployment hardening** (ADR-0005).
  - The backend serves the built SPA when `CAIRNDEX_STATIC_DIR` is set, so a
    single container ships both halves: FastAPI keeps owning `/api/v1` and serves
    `index.html` (with deep-link fallback) and hashed assets for everything else.
    Unset in dev — Vite serves the frontend separately.
  - Hardened production image (`infra/docker/production.Dockerfile`): multi-stage
    build (SPA + locked backend) into a slim non-root runtime (UID 10001) with
    `ffmpeg`/`ffprobe` for scan/thumbnail/subtitle work.
  - `docker-compose.prod.yml`: read-only container rootfs + `tmpfs`, media
    mounted **read-only** at `/storage/media`, a writable app-data volume at
    `/data`, `no-new-privileges`; `.env.example` documents the host knobs.
  - `infra/backup.sh`: WAL-safe online SQLite backup with an integrity check.
  - Production deployment guide (`docs/deployment.md`): topology, env-var
    reference, backup/restore, and the no-auth/not-public-internet stance. CI
    now also builds the production image.
- **Phase 7 — Eagle migration (one-way, read-only, idempotent).**
  - Read-only parser for an Eagle `.library` directory (folders, tag groups,
    per-item metadata) — ADR-0004; the Eagle library is never written to.
  - Dry-run planner (`POST /eagle/preview`) reports new/skipped/folders/tags plus
    advisory merge suggestions, with no DB writes; the executor
    (`POST /eagle/import`) maps each item → one bundle + linked file
    (title/note/rating/source/tags/folders), registers the library as a storage
    root, and records `import_records` so re-imports skip existing items
    (`UNIQUE(provider, external_id)`).
  - Desktop "Import from Eagle" dialog: enter a library path, preview the report,
    then commit.
- **Phase 6 — subtitles and direct playback.** Subtitle tracks, direct playback,
  range streaming, external SRT→WebVTT conversion, and a player modal are
  implemented; remux/transcode fallback remains a later milestone.
- **Phase 5 — filtering and Smart Folders.** Canonical filter AST, compiler,
  Smart Folder CRUD, preview, filtered browse, and an Eagle-style editor were
  implemented. The Collections refactor renames this feature to Smart
  Collections in code/API/UI while keeping the legacy `smart_folders` table name.
- **Phase 4 — bundle editing and organization.** Bundle/file editing, tag and
  collection assignment, file reorder/cover/primary controls, metadata-only file
  removal, and batch metadata edits are implemented.
- **Phase 3 — desktop app shell and browsing views.** Eagle-inspired three-pane
  UI, virtualized grid/list/justified layouts, sidebar counts, toolbar controls,
  keyboard navigation, and persisted layout preferences are implemented.
- **Phase 2 — scanner, indexing, and media metadata.** DB-backed jobs,
  incremental scanner, ffprobe metadata, thumbnail generation, async root jobs,
  and fast-add are implemented.
- **Phase 1 — core domain and storage roots.** SQLAlchemy schema, first Alembic
  migration, path safety, domain services, CRUD APIs, synthetic seeding, OpenAPI
  types, repository foundation, Docker development environment, and CI are
  implemented.

### Changed

- **Collections + File View refactor (complete through Phase 8 on
  `feat/collections-and-file-view`).** The logical grouping concept formerly
  called "folder" is now **collection** to reserve file/folder terminology for
  the physical File View.
  - *Backend DB/model rename (Phase 1):* `folders` → `collections`,
    `asset_bundle_folders` → `asset_bundle_collections`, `folder_id` →
    `collection_id`; ORM `Folder` → `Collection`; service module
    `services/folders.py` → `services/collections.py`. Data-preserving migration;
    every existing ID and membership is preserved.
  - *API/schema/filter rename (Phase 2, breaking — no aliases):*
    `/api/v1/folders*` → `/api/v1/collections*`, `/bundles/{id}/folders` →
    `/bundles/{id}/collections`, browse `folder_id` → `collection_id`, filter
    field `folders` → `collections`, Smart Folders → Smart Collections, and
    `Folder*`/`BundleFolders` schemas → `Collection*`/`BundleCollections`.
    OpenAPI and generated frontend API types were regenerated.
  - *Frontend rename (Phase 3):* sidebar, picker, editor, filter builder, hooks,
    state names, tests, and labels now use Collection / Smart Collection
    terminology.
  - *Final docs audit (Phase 8):* README, architecture, data model, status,
    changelog, ADRs, and PR description were reviewed/updated.
    `feat/collections-and-file-view` still needs to be updated/rebased against
    current `main` before merge because current `main` has the latest
    `AGENTS.md`.
- Refreshed current-state documentation after the Phase 0–8 roadmap: README,
  architecture, data model, status, and agent instructions now describe the
  implemented app instead of the old Phase 0/TBD skeleton, and clarify the
  current file-level source/link metadata model.

### Fixed

- `.gitignore` no longer blanket-ignores media extensions at the repo root. The
  `*.ts` glob silently shadowed all TypeScript source; source media is kept out
  via directory ignores (`data/`, `storage/`, `var/`) instead.

### Removed

- N/A

### Security

- N/A

### Internal

- Enforced TypeScript strict mode (`strict`, `noUncheckedIndexedAccess`) in both
  frontend tsconfigs, which the Vite scaffold omitted (AGENTS.md §9).
- `get_settings()` memoizes the `Settings` instance (`lru_cache`) so config is
  read from the environment once per process.
