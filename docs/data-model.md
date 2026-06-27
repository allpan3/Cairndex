# Data model

> Status: current through Phase 8, plus the Collections/File View refactor
> (logical "folders" are now **collections**). The core schema is implemented in
> `apps/server/src/cairndex/persistence/models.py` and evolved by Alembic
> migrations. Decisions are recorded in ADR-0002 (core schema/identity),
> ADR-0003 (subtitle tracks), and ADR-0004 (Eagle import). `AGENTS.md` remains
> the conceptual product brief.

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
- **FK enforcement**: `PRAGMA foreign_keys=ON` per SQLite connection; WAL mode
  is enabled for the file database.

## Tables

### `storage_roots`

`id`, `name` (unique), `canonical_path` (absolute server path — never
client-supplied), `read_only` (default true), `status`
(`available`/`unavailable`), `scan_config` (JSON, nullable and intentionally
extensible), `created_at`, `updated_at`, `last_scanned_at` (nullable).

### `asset_bundles`

`id`, `title` (nullable), `note`, `rating` (nullable int, CHECK 0–5; NULL =
unrated), `cover_file_id` / `primary_file_id` (FK → `asset_files`, `SET NULL`,
nullable; `use_alter` breaks the FK cycle), `extra_metadata` (JSON),
`created_at`, `imported_at`, `updated_at`.

Current schema note: bundles do **not** have a first-class hyperlink/source
column. Origin/source metadata is currently stored on `asset_files.source`
because the implemented Eagle import maps each Eagle item to one linked file.
If bundle-level source pages become important, add an explicit nullable column
or link table through a migration rather than hiding it in `extra_metadata`.

### `asset_files`

`id`, `bundle_id` (FK → `asset_bundles`, **CASCADE** — metadata-only bundle
deletion removes file rows, never the physical file), `storage_root_id` (FK →
`storage_roots`, **RESTRICT** — can't delete a root with linked files),
`relative_path`, `original_filename`, `display_title`, `note`, `source` (origin —
a URL, `magnet:`, `ed2k:`, etc.), `role` (`FileRole`), `media_kind`
(`MediaKind`), `mime_type`, `sequence`,
`size_bytes`/`mtime`/`quick_fingerprint`/`full_hash`/`tech_metadata` (nullable,
filled by scan/probe jobs where available), `availability`
(`available`/`missing`), `created_at`, `updated_at`. **Unique**
`(storage_root_id, relative_path)` — one physical file is linked at most once.

### `tags`

`id`, `parent_id` (self-FK, `SET NULL`), `name`, `color`, `sort_order`,
timestamps. **Unique** `(parent_id, name)`.

### `tag_groups`

`id`, `name` (unique), `sort_order`, timestamps.

### `tag_group_memberships` (M:N tags ↔ groups)

`group_id` + `tag_id` (composite PK, both CASCADE), `sort_order`. A group is
**not** a hierarchy parent (ADR-0002 / `AGENTS.md` §4.6).

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

### `jobs`

`id`, `type` (`scan`/`probe`/`thumbnail`), `status`
(`queued`/`running`/`succeeded`/`failed`/`cancelled`), `payload` (JSON),
`processed`/`total` (progress), `result` (JSON), `error`, `cancel_requested`
(cooperative cancel flag), timestamps + `started_at`/`finished_at`. Backs the
in-process worker (ADR-0001). Asset-file fields `size_bytes`, `mtime`,
`quick_fingerprint`, and `tech_metadata` are populated by scanner/probe jobs;
`full_hash` stays lazy/unused until a deduplication or moved-file repair feature
needs it.

### `subtitle_tracks` (Phase 6, ADR-0003)

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

### `import_records` (Phase 7, ADR-0004)

`id`, `provider` (e.g. `eagle`), `external_id`, `bundle_id` (FK, CASCADE),
`imported_at`, with `UNIQUE(provider, external_id)`. Maps an external item to
the bundle it produced so re-running an import skips already-imported items.
Generic columns keep it reusable for future importers.

## Deferred to later phases

- **Generalized media tracks / embedded-stream extraction** — a future
  `media_tracks` table or expanded subtitle/media-track model plus
  ffmpeg-extracted embedded subtitles as part of the remux/transcode fallback
  milestone.
- **Bundle-level links/sources** — current MVP stores source at the file level;
  add a bundle-level column or link table only if the product needs logical
  asset pages independent of physical-file origins.
- **Moved-file repair state** — missing rows exist now, but candidate matching,
  repair suggestions, and full-hash verification are future workflow work.

## Still open

- Index plan beyond PK/unique constraints, especially for server-side text
  search/SQLite FTS5, browse-summary aggregation, tag/collection membership
  queries, and larger synthetic-library benchmarks.
- Tag/collection delete semantics at the service layer (DB default is `SET NULL` on
  the parent FK → children float to root; the service may later offer
  reparent/cascade choices).
