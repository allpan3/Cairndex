# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Changed

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
  - **Eagle import** is temporarily removed pending a per-library
    re-implementation (the reader/planner are retained). The global
    storage-root APIs/UI are gone.

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
