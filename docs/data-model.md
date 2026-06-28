# Data model

> Status: current through the Collections/File View refactor. Logical "folders"
> are now **collections**. The core schema is implemented in
> `apps/server/src/cairndex/persistence/models.py` and created per library via
> `create_all` (ADR-0008). Decisions are recorded in ADR-0002 (core
> schema/identity), ADR-0003 (subtitle tracks), and ADR-0006 (scanner identity
> and moved-file repair); ADR-0004 (Eagle import) is **superseded and the feature
> removed**. `AGENTS.md` remains the conceptual product brief; ADR-0007 records
> future File View native handoff / host integration; ADR-0008 records the
> per-library metadata + registry architecture.

## Conventions (ADR-0002)

- **Primary keys**: ULID stored as `CHAR(26)` (`UlidPk`), generated in the app
  layer (`core/ids.py`). Time-sortable IDs double as pagination tie-breakers.
- **Timestamps**: timezone-aware UTC via the `UtcDateTime` type decorator
  (`persistence/types.py`), defaulted in the app layer (`core/time.py`).
  `created_at`/`imported_at` are set on insert; `updated_at` also changes on
  update.
- **Enums**: stored as strings with CHECK-like validation through
  `Enum(..., native_enum=False)`, defined in `domain/enums.py`.
- **Hierarchy**: adjacency list (`parent_id` self-FK) + recursive CTE for
  descendants (tags and collections).
- **FK enforcement**: `PRAGMA foreign_keys=ON` per SQLite connection; WAL mode is
  enabled for the file database.

## Tables

> ADR-0008: these content tables live in each library's own
> `.cairndex/library.db`. There is no `storage_roots` table and no
> `storage_root_id` — the library DB *is* the storage scope, and the library's
> root directory comes from the registry. The runtime `jobs` queue moved to the
> registry (`job_queue`); see the registry section below.

> ADR-0008 phase 9: the frequently edited entities (`asset_bundles`,
> `asset_files`, `tags`, `collections`, `smart_folders`, `subtitle_tracks`) carry
> a `version` integer (default 1, bumped on each edit) for optimistic
> concurrency. Single-entity `PATCH` routes accept an optional `If-Match:
> <version>` precondition and return 409 (`version_conflict`) on a stale edit;
> without it, edits are last-write-wins. See `persistence/concurrency.py`.

### `asset_bundles`

`id`, `title` (nullable), `note`, `rating` (nullable int, CHECK 0–5; NULL =
unrated), `cover_file_id` / `primary_file_id` (FK → `asset_files`, `SET NULL`,
nullable; `use_alter` breaks the FK cycle), `extra_metadata` (JSON),
`created_at`, `imported_at`, `updated_at`.

Current schema note: bundles do **not** have a first-class hyperlink/source
column. Origin/source metadata is stored per file on `asset_files.source`. If
bundle-level source pages become important, add an explicit nullable column or
link table rather than hiding it in `extra_metadata`.

### `asset_files`

`id`, `bundle_id` (FK → `asset_bundles`, **CASCADE** — metadata-only bundle
deletion removes file rows, never the physical file), `relative_path` (relative
to the library root, ADR-0008), `original_filename`, `display_title`, `note`,
`source` (origin — a URL, `magnet:`, `ed2k:`, etc.), `role` (`FileRole`),
`media_kind` (`MediaKind`), `mime_type`, `sequence`,
`size_bytes`/`mtime`/`quick_fingerprint`/`full_hash`/`tech_metadata` (nullable,
filled by scan/probe jobs where available),
`filesystem_device`/`filesystem_inode`/`identity_available` (filesystem identity
captured by the scanner for moved-file repair — ADR-0006), `availability`
(`available`/`missing`), `created_at`, `updated_at`. **Unique**
`(relative_path)` — one physical file is linked at most once per library.

Moved-file repair updates the existing `asset_files` row in place when confidence
is high, preserving `id`, `bundle_id`, collection memberships, tags, rating,
cover/primary references, and subtitle links. The normal scan path does not full
hash large files; `full_hash` remains lazy and available for future duplicate
verification or ambiguous repair workflows.

### `tags`

`id`, `parent_id` (self-FK, `SET NULL`), `name`, `color`, `sort_order`,
timestamps. **Unique** `(parent_id, name)`.

### `tag_groups`

`id`, `name` (unique), `sort_order`, timestamps.

### `tag_group_memberships` (M:N tags ↔ groups)

`group_id` + `tag_id` (composite PK, both CASCADE), `sort_order`. A group is
**not** a hierarchy parent (ADR-0002 / `AGENTS.md`).

### `collections`

Hierarchical virtual groupings of bundles (formerly "folders" — renamed in the
Collections/File View refactor; the table was `folders`). `id`, `parent_id`
(self-FK, `SET NULL`), `name`, `sort_order`, timestamps. **Unique**
`(parent_id, name)`. Collections are purely logical and independent of the
physical File View.

### `asset_bundle_tags` / `asset_bundle_collections` (M:N)

Composite PK of the two FKs, both CASCADE. Collection membership is virtual and
never moves files on disk.

### `smart_folders` (model `SmartCollection`)

Saved **Smart Collections** (formerly "Smart Folders"). The ORM model is
`SmartCollection` and the API is `/api/v1/smart-collections`; the table keeps the
legacy name `smart_folders` to avoid a second data migration. `id`, `name`
(unique), `filter_version`, `filter_json` (versioned JSON AST — see
`docs/filter-language.md`; never SQL), `default_sort`, `default_layout`,
`sort_order`, timestamps.

> The background-job queue is **not** a content table — it lives in the registry
> DB as `job_queue` (ADR-0008; see the registry section). Asset-file fields
> `size_bytes`, `mtime`, `quick_fingerprint`, filesystem identity, and
> `tech_metadata` are still populated by scanner/probe jobs, which open the
> library DB to write their durable results.

### `subtitle_tracks` (ADR-0003)

`id`, `bundle_id` (FK, CASCADE), `video_file_id` (FK `asset_files`, CASCADE,
nullable), `source_file_id` (FK `asset_files`, SET NULL, nullable),
`embedded_index` (nullable), `language`, `label`, `format`, `is_default`,
`is_forced`, `sort_order`, timestamps. A track is **exactly one** of external
(an external subtitle `AssetFile` in `source_file_id`) or embedded (an `ffprobe`
stream `embedded_index` inside `video_file_id`'s container), enforced by CHECK
constraints; uniqueness on `(video_file_id, embedded_index)` and
`source_file_id`. External subtitles auto-link to a same-directory video by
basename (language/forced parsed from the suffix); unmatched ones stay unlinked
for manual attachment.

## Registry database (ADR-0008, separate from the content DB)

These tables live in the **registry** DB (`{CAIRNDEX_DATA_DIR}/registry.db`,
package `cairndex.registry`), not in the content/library DB. They are
server-local runtime state and use their own metadata/schema lifecycle
(bootstrapped via `create_all`, not the content Alembic chain).

### `registered_libraries`

`id`, `library_uuid` (the library's own identity, copied from its manifest,
`UNIQUE`), `name`, `root_path` (absolute, normalized, `UNIQUE`), `manifest_path`,
`status` (`available`/`unavailable`, re-probed on read), `schema_version`,
timestamps + `last_opened_at`. One row per `<root>/.cairndex/` library package
the server knows about.

### `job_queue`

`id`, `library_id` (FK `registered_libraries`, CASCADE), `job_type`, `status`,
`payload` (JSON), `processed`/`total`, `result` (JSON), `error`,
`cancel_requested`, timestamps + `started_at`/`finished_at`. The registry will
own the runtime job queue so the worker can open the target library DB by
`library_id`; the per-library worker that consumes these rows lands in a later
PR (ADR-0008 phase 7). The current in-process worker still uses the content-DB
`jobs` table.

## Non-table model surfaces

### File View entries

Read-only File View entries are produced by `services/file_view.py` from the live
filesystem under the active library's root. They are response models rather than
persistent rows. Each entry is derived from a library-relative path, path-safety
checks, filesystem metadata, media classification, and an optional linked
`AssetFile` lookup.

Future native file handoff and write mode are documented in ADR-0007 and
intentionally have no schema yet.

## Deferred to later phases

- **Generalized media tracks / embedded-stream extraction** — a future
  `media_tracks` table or expanded subtitle/media-track model plus
  ffmpeg-extracted embedded subtitles as part of the remux/transcode fallback
  milestone.
- **Bundle-level links/sources** — current MVP stores source at the file level;
  add a bundle-level column or link table only if the product needs logical
  asset pages independent of physical-file origins.
- **Moved-file repair improvements** — same-volume high-confidence repair is
  implemented (ADR-0006). Still future: cross-filesystem repair, candidate
  suggestions for ambiguous cases, duplicate/copy resolution, and optional
  full-hash verification.
- **File View write/native integration** — future desktop/native integration is
  planned in ADR-0007; no persistent model exists yet.

## Still open

- Index plan beyond PK/unique constraints, especially for server-side text
  search/SQLite FTS5, browse-summary aggregation, tag/collection membership
  queries, and larger synthetic-library benchmarks.
- Tag/collection delete semantics at the service layer (DB default is `SET NULL`
  on the parent FK → children float to root; the service may later offer
  reparent/cascade choices).
