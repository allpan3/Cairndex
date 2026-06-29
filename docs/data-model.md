# Data model

> Status: current through the scan grouping review workflow. Logical "folders"
> are now **collections**. The core content schema is implemented in
> `apps/server/src/cairndex/persistence/models.py` and created per library via
> `create_all` (ADR-0008). Decisions are recorded in ADR-0002 (core
> schema/identity), ADR-0003 (subtitle tracks), ADR-0006 (scanner identity and
> moved-file repair), ADR-0008 (per-library metadata + registry), and ADR-0009
> (suggestion-based grouping). ADR-0004 (Eagle import) is superseded history; the
> importer is removed.

## Conventions

- **Primary keys:** ULID stored as `CHAR(26)` (`UlidPk`), generated in the app
  layer (`core/ids.py`). Time-sortable IDs double as pagination tie-breakers.
- **Timestamps:** timezone-aware UTC via `UtcDateTime`, defaulted in the app
  layer. `created_at`/`imported_at` are set on insert; `updated_at` changes on
  update.
- **Enums:** stored as strings with SQLAlchemy `Enum(..., native_enum=False)`,
  defined in `domain/enums.py`.
- **Hierarchy:** adjacency list (`parent_id` self-FK) plus recursive CTEs for
  descendants where needed (tags and collections).
- **FK enforcement:** `PRAGMA foreign_keys=ON` per SQLite connection; WAL mode is
  enabled for content/library DBs.
- **Optimistic concurrency:** frequently edited content entities carry a
  `version` integer. Single-entity `PATCH` routes accept optional
  `If-Match: <version>` and return 409 (`version_conflict`) on stale edits;
  without it, edits remain last-write-wins.

## Per-library content database

Each Cairndex library is a directory with a `.cairndex/` package. The content
schema below lives in `<library-root>/.cairndex/library.db`. There is no content
`storage_roots` table and no `asset_files.storage_root_id`: the library DB is the
storage scope, and `asset_files.relative_path` is relative to the library root.

### `asset_bundles`

`id`, `title` (nullable), `note`, `rating` (nullable int, CHECK 0-5; NULL =
unrated), `cover_file_id` / `primary_file_id` (nullable FKs to `asset_files`,
`SET NULL`, `use_alter` to break the FK cycle), `extra_metadata` (JSON),
`grouping_state`, `grouping_source`, `grouping_rule_version`, `confirmed_at`,
`version`, `created_at`, `imported_at`, `updated_at`.

Grouping review state (ADR-0009): scan stages newly discovered files into
`provisional` / `scan_suggestion` bundles that await user review. Explicit user
actions — fast-add, manual create, or applying a reviewed grouping plan — produce
`confirmed` bundles (`grouping_source` records which action) and stamp
`confirmed_at`. Confirmed groupings are durable and win over heuristics on
re-scan: they are never silently re-split, merged, or retitled.

Current schema note: bundles do **not** have a first-class hyperlink/source
column. Origin/source metadata is stored per file on `asset_files.source`. If
bundle-level source pages become important, add an explicit nullable column or
link table rather than hiding it in `extra_metadata`.

### `asset_files`

`id`, `bundle_id` (FK to `asset_bundles`, **CASCADE** — metadata-only bundle
deletion removes file rows, never the physical file), `relative_path` (library
root relative), `original_filename`, `display_title`, `note`, `source`, `role`,
`media_kind`, `mime_type`, `sequence`, `size_bytes`, `mtime`,
`quick_fingerprint`, `full_hash`, `tech_metadata`, `filesystem_device`,
`filesystem_inode`, `identity_available`, `availability`, `version`, timestamps.
`relative_path` is unique within a library.

Moved-file repair updates the existing `asset_files` row in place when
confidence is high, preserving `id`, `bundle_id`, collection memberships, tags,
rating, cover/primary references, and subtitle links. The normal scan path does
not full-hash large files; `full_hash` remains lazy for future duplicate
verification or ambiguous repair workflows.

The scanner ignores hidden paths (`.cairndex`, dotfiles/dot-directories, and a
small denylist such as `.DS_Store`, `__pycache__`, `node_modules`, `Thumbs.db`).
A rescan also deletes scan-created provisional rows that point at now-ignored
hidden paths, so portable cache files do not remain as user-visible assets.

### `tags`

`id`, `parent_id` (self-FK, `SET NULL`), `name`, `color`, `sort_order`,
`version`, timestamps. Unique `(parent_id, name)`.

### `tag_groups`

`id`, `name` (unique), `sort_order`, timestamps.

### `tag_group_memberships`

Many-to-many tags to groups: `group_id` + `tag_id` composite PK, both CASCADE,
plus `sort_order`. A group is not a hierarchy parent.

### `collections`

Hierarchical virtual groupings of bundles. `id`, `parent_id` (self-FK,
`SET NULL`), `name`, `sort_order`, `version`, timestamps. Unique
`(parent_id, name)`. Collections are logical and independent of the physical File
View; membership never moves source files.

### `asset_bundle_tags` / `asset_bundle_collections`

Many-to-many membership tables with composite PKs and CASCADE FKs. Collection
membership is virtual and never moves files on disk.

### `smart_folders` (model `SmartCollection`)

Saved **Smart Collections**. The ORM model is `SmartCollection` and the API is
`/api/v1/libraries/{library_id}/smart-collections`; the table keeps the legacy
name `smart_folders` to avoid a second data migration. Columns: `id`, `name`,
`filter_version`, `filter_json` (versioned JSON AST; see
`docs/filter-language.md`), `default_sort`, `default_layout`, `sort_order`,
`version`, timestamps.

### `subtitle_tracks`

`id`, `bundle_id` (FK, CASCADE), `video_file_id` (FK to `asset_files`, CASCADE,
nullable), `source_file_id` (FK to `asset_files`, SET NULL, nullable),
`embedded_index` (nullable), `language`, `label`, `format`, `is_default`,
`is_forced`, `sort_order`, `version`, timestamps.

A track is exactly one of external (`source_file_id`) or embedded
(`embedded_index` inside `video_file_id`), enforced by CHECK constraints.
External subtitles auto-link to a same-directory video by basename, with
language/forced parsed from the suffix. Auto-link runs on every path that forms a
bundle: grouping-plan apply and fast-add single-bundle grouping.

### `grouping_plans` / `grouping_proposals` / `grouping_proposal_files`

Durable, reviewable snapshots of the grouping suggester output.

- `grouping_plans`: `id`, `scan_job_id` (nullable; registry job id, no cross-DB
  FK), `status` (`open` | `applied` | `superseded` | `cancelled`),
  `rule_version`, `generated_at`, `applied_at`, `version`, timestamps. Generating
  a new plan supersedes the prior open one. Scan jobs generate an open plan and
  return its id/proposal count without applying it.
- `grouping_proposals`: `id`, `plan_id` (FK, CASCADE), `parent_proposal_id` (self
  FK, SET NULL), `target_bundle_id` (plain id for addition proposals), `kind`
  (`bundle` | `container`), `title`, `directory`, `confidence`, `reason`,
  `sort_order`.
- `grouping_proposal_files`: `id`, `proposal_id` (FK, CASCADE), `asset_file_id`
  (snapshot id, not an FK), `relative_path` (display snapshot), `proposed_role`,
  `sequence`.

Apply is idempotent and conflict-aware: it merges/splits provisional bundles
preserving `AssetFile.id`, assigns roles, selects cover/primary, links external
subtitles, creates suggested collections, and never touches the filesystem.
`POST /grouping/plans/{id}/apply` may include `proposal_ids`; when supplied, only
that selected subset is accepted and the plan is marked applied, so unchecked
proposals are not retained as pending work for the same plan.

## Registry database

The registry DB lives at `{CAIRNDEX_DATA_DIR}/registry.db` and is server-local
runtime state. It is not portable library metadata and has its own
`create_all`-based lifecycle.

### `registered_libraries`

`id`, `library_uuid` (copied from the library manifest, unique), `name`,
`root_path` (absolute, normalized, unique), `manifest_path`, `status`,
`schema_version`, timestamps, `last_opened_at`. One row per known
`<root>/.cairndex/` library package.

### `job_queue`

`id`, `library_id` (FK to `registered_libraries`, CASCADE), `job_type`, `status`,
`payload` (JSON), `processed`, `total`, `result` (JSON), `error`,
`cancel_requested`, timestamps, `started_at`, `finished_at`.

The in-process worker consumes this registry queue. Each job names a library;
the worker opens that library's `library.db`, runs scan/probe/thumbnail handlers
against the library root, commits durable content results into the library DB,
and writes progress/terminal state back to the registry row.

## Non-table model surfaces

### File View entries

Read-only File View entries are produced by `services/file_view.py` from the live
filesystem under the active library root. They are response models rather than
persistent rows. Each entry is derived from a library-relative path, path-safety
checks, filesystem metadata, media classification, and an optional linked
`AssetFile` lookup. Hidden entries are excluded.

Future native file handoff and write mode are documented in ADR-0007 and have no
schema yet.

### Derived media cache

Thumbnails and converted WebVTT subtitles are generated under the library's
portable `.cairndex/cache/{thumbnails,subtitles}/`. These are reproducible cache
artifacts, not `AssetFile` rows, and scanners intentionally ignore them.

## Deferred to later phases

- Generalized media tracks / embedded-stream extraction and remux/transcode
  fallback.
- Bundle-level links/sources if needed beyond current file-level `source`.
- Cross-filesystem moved-file repair, ambiguous repair candidates, duplicate/copy
  resolution, and optional full-hash verification.
- File View write/native integration.
- Index plan beyond current PK/unique constraints, especially for server-side
  text search/SQLite FTS5, browse-summary aggregation, tag/collection membership
  queries, and larger-library benchmarks.
- Tag/collection delete service semantics beyond current FK defaults.
