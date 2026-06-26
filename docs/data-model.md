# Data model

> Status: Phase 1 — the core schema below is implemented (SQLAlchemy models in
> `apps/server/src/cairndex/persistence/models.py`, first Alembic migration
> `core schema`). Decisions are recorded in
> [ADR-0002](adr/0002-core-schema-identity-and-hierarchy.md). `AGENTS.md` §4
> remains the conceptual source of truth.

## Conventions (ADR-0002)

- **Primary keys**: ULID stored as `CHAR(26)` (`UlidPk`), generated in the app
  layer (`core/ids.py`). Time-sortable → doubles as a pagination tie-breaker.
- **Timestamps**: timezone-aware UTC via the `UtcDateTime` type decorator
  (`persistence/types.py`), defaulted in the app layer (`core/time.py`).
  `created_at`/`imported_at` set on insert; `updated_at` also on update.
- **Enums**: stored as strings with a CHECK constraint
  (`Enum(..., native_enum=False)`), defined in `domain/enums.py`.
- **Hierarchy**: adjacency list (`parent_id` self-FK) + recursive CTE for
  descendants (tags and folders).
- **FK enforcement**: `PRAGMA foreign_keys=ON` per connection; WAL mode.

## Tables

### `storage_roots`
`id`, `name` (unique), `canonical_path` (absolute server path — never
client-supplied), `read_only` (default true), `status`
(`available`/`unavailable`), `scan_config` (JSON, nullable — shape defined in
Phase 2), `created_at`, `updated_at`, `last_scanned_at` (nullable).

### `asset_bundles`
`id`, `title` (nullable), `note`, `rating` (nullable int, CHECK 0–5; NULL =
unrated), `cover_file_id` / `primary_file_id` (FK → `asset_files`, `SET NULL`,
nullable; `use_alter` to break the FK cycle), `extra_metadata` (JSON),
`created_at`, `imported_at`, `updated_at`. (Bundles carry no hyperlink — a
source belongs to the individual file.)

### `asset_files`
`id`, `bundle_id` (FK → `asset_bundles`, **CASCADE** — metadata-only bundle
deletion removes file rows, never the physical file), `storage_root_id`
(FK → `storage_roots`, **RESTRICT** — can't delete a root with linked files),
`relative_path`, `original_filename`, `display_title`, `note`, `source`
(origin — a URL, `magnet:`, `ed2k:`, etc.), `role` (`FileRole`),
`media_kind` (`MediaKind`), `mime_type`, `sequence`,
`size_bytes`/`mtime`/`quick_fingerprint`/`full_hash`/`tech_metadata` (nullable,
filled by the Phase 2 scanner), `availability` (`available`/`missing`),
`created_at`, `updated_at`. **Unique** `(storage_root_id, relative_path)` — one
physical file is linked at most once.

### `tags`
`id`, `parent_id` (self-FK, `SET NULL`), `name`, `color`, `sort_order`,
timestamps. **Unique** `(parent_id, name)`.

### `tag_groups`
`id`, `name` (unique), `sort_order`, timestamps.

### `tag_group_memberships` (M:N tags ↔ groups)
`group_id` + `tag_id` (composite PK, both CASCADE), `sort_order`. A group is
**not** a hierarchy parent (ADR-0002 / `AGENTS.md` §4.6).

### `folders`
`id`, `parent_id` (self-FK, `SET NULL`), `name`, `sort_order`, timestamps.
**Unique** `(parent_id, name)`.

### `asset_bundle_tags` / `asset_bundle_folders` (M:N)
Composite PK of the two FKs, both CASCADE.

### `smart_folders`
`id`, `name` (unique), `filter_version`, `filter_json` (JSON AST — see
`docs/filter-language.md`; never SQL), `default_sort`, `default_layout`,
`sort_order`, timestamps.

### `jobs` (Phase 2)
`id`, `type` (`scan`/`probe`/`thumbnail`), `status`
(`queued`/`running`/`succeeded`/`failed`/`cancelled`), `payload` (JSON),
`processed`/`total` (progress), `result` (JSON), `error`, `cancel_requested`
(cooperative cancel flag), timestamps + `started_at`/`finished_at`. Backs the
in-process worker (ADR-0001). Asset-file fields `size_bytes`, `mtime`,
`quick_fingerprint`, and `tech_metadata` are now populated by the scanner/probe
jobs (full hash stays lazy/unused until a dedup/repair feature needs it).

### `subtitle_tracks` (Phase 6, ADR-0003)
`id`, `bundle_id` (FK, CASCADE), `video_file_id` (FK `asset_files`, CASCADE,
nullable), `source_file_id` (FK `asset_files`, SET NULL, nullable),
`embedded_index` (nullable), `language`, `label`, `format`, `is_default`,
`is_forced`, `sort_order`, timestamps. A track is **exactly one** of external
(an external subtitle `AssetFile` in `source_file_id`) or embedded (an
`ffprobe` stream `embedded_index` inside `video_file_id`'s container), enforced
by two CHECK constraints; uniqueness on `(video_file_id, embedded_index)` and
`source_file_id`. External subtitles auto-link to a same-directory video by
basename (language/forced parsed from the suffix); unmatched ones stay unlinked
for manual attachment.

### `import_records` (Phase 7, ADR-0004)
`id`, `provider` (e.g. `eagle`), `external_id`, `bundle_id` (FK, CASCADE),
`imported_at`, with `UNIQUE(provider, external_id)`. Maps an external item to
the bundle it produced so re-running an import skips already-imported items
(idempotency). Generic columns keep it reusable for future importers.

## Deferred to later phases

- **Generalized media tracks / embedded-stream extraction** — a future
  `media_tracks` table and ffmpeg-extracted embedded subtitles (the §6.2
  transcode/fallback milestone).

## Still open

- Index plan beyond PK/unique constraints — added in Phase 2/5 when the real
  query patterns (scan lookups, filter compilation) exist, justified per
  `AGENTS.md` §11.
- Tag/folder delete semantics at the service layer (DB default is `SET NULL`
  on the parent FK → children float to root; the service may later offer
  reparent/cascade).
