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

`id`, `title` (nullable), `notes` (JSON), `rating` (nullable int, CHECK 0-5;
NULL = unrated), `cover_file_id` (nullable FK to `asset_files`, `SET NULL`,
`use_alter` to break the FK cycle), `primary_file_id` (unused nullable legacy FK
retained for existing databases), `extra_metadata`
(JSON), `manual_order` (int, `server_default 0`), `grouping_state`,
`grouping_source`, `grouping_rule_version`, `confirmed_at`, `version`,
`created_at`, `imported_at`, `updated_at`.

`notes` is an ordered list of freeform owner note/description blocks (the
inspector "NOTES" section, added additively via `ensure_content_indexes`). There
are no predefined roles — each entry is just a separate text block. It is the
single source of truth (there is no scalar `note` column on the bundle;
libraries created before the `notes` column keep an unused `note` column that is
ignored). Blank/whitespace-only blocks are dropped on write, and a row whose
`notes` column is NULL reads back as an empty list. The `notes` filter and the
`q` full-text search both index the notes: the filter
(`docs/filter-language.md`) compiles to a per-note `EXISTS` over
`json_each(notes)`, and the `bundle_search` FTS view concatenates
`json_each(notes)` into its `notes` column. (`ensure_search_schema` rebuilds the
FTS table + triggers when their column set no longer matches, so an existing
library migrates on open.)

`manual_order` is the global owner-defined ("custom") order used when browsing
All/system views with the **Manual** sort (drag-reorder / "Clean up by…"). The
per-collection order lives on `asset_bundle_collections.sort_order` instead.

Grouping review state (ADR-0009): scan stages newly discovered files into
`provisional` / `scan_suggestion` bundles that await user review. Explicit user
actions — fast-add, manual create, or applying a reviewed grouping plan — produce
`confirmed` bundles (`grouping_source` records which action) and stamp
`confirmed_at`. Confirmed groupings are durable and win over heuristics on
re-scan: they are never silently re-split, merged, or retitled.

**Unbundled files** are exactly the `provisional` + `scan_suggestion` bundles.
There is no new column: it is a derived state over the two existing enums, applied
at the query layer (`services/browse.py`). The browse layer confines them to the
`unbundled` system view (and the `unbundled` view count) and hides them from All,
Recent, Uncategorized, Untagged, Missing, and every collection until confirmed.
The manual bundling assistant (`cairndex.manual_bundling`) confirms them by hand
— re-parenting `AssetFile` rows (preserving ids), reaping emptied provisional
source bundles, and auto-linking subtitles — reusing the same metadata-only
membership helpers (`grouping/membership.py`) as grouping apply. The inverse also
holds: deleting a *confirmed* bundle re-stages its files into fresh provisional
one-file bundles (they fall back to Unbundled), while deleting a provisional
bundle removes its rows — so `delete_bundle` never orphans a file the user still
has on disk.

The **Files** surface reflects the same derived state per path: a File Browser entry
carries `linked` plus a derived `unbundled` flag (its owning bundle is
`provisional` + `scan_suggestion`), so the UI can badge a path `unlinked` /
`unbundled` / (in a confirmed bundle). Bundling a File-View selection accepts
`relative_paths`: an unlinked path is staged into a provisional one-file bundle at
apply time (reusing `scanning.fast_add._link`) then confirmed; a path already in a
confirmed bundle is rejected. All still metadata-only.

Current schema note: bundles do **not** have a first-class hyperlink/source
column. Origin/source metadata is stored per file on `asset_files.source`. If
bundle-level source pages become important, add an explicit nullable column or
link table rather than hiding it in `extra_metadata`.

### `asset_files`

`id`, `bundle_id` (FK to `asset_bundles`, **CASCADE** — metadata-only bundle
deletion removes file rows, never the physical file), `relative_path` (library
root relative), indexed derived `directory_path`, `original_filename`,
`display_title`, `note`, `source`, `role`, `media_kind`, `mime_type`, `sequence`,
`size_bytes`, `mtime`,
`quick_fingerprint`, `full_hash`, `tech_metadata`, `filesystem_device`,
`filesystem_inode`, `identity_available`, `availability`, `version`, timestamps.
`relative_path` is unique within a library.

Filesystem device/inode identities preserve the unsigned 64-bit `stat()` value
as signed two's-complement SQLite integers. This avoids overflow on network
filesystems while preserving exact equality for moved-file repair.

Moved-file repair updates the existing `asset_files` row in place when
confidence is high, preserving `id`, `bundle_id`, collection memberships, tags,
rating, cover/cursor references, and subtitle links. The normal scan path does
not full-hash large files; `full_hash` remains lazy for future duplicate
verification or ambiguous repair workflows. If a conservative scan has already
created an available replacement row, Missing Files can explicitly collapse a
globally unique, live quick-fingerprint match back into the missing row. The
replacement row is removed only from metadata; the original stable id and
established bundle survive, and no source file is changed.

`directory_path` is synchronized from `relative_path` on create and moved-file
repair, additively backfilled for existing libraries, and indexed so File
Browser access can retrieve only one directory's linked rows. `availability` is
refreshed by full scan reconciliation and bounded access-time checks. Opening a
bundle checks all of its linked rows; entering a directory checks its linked
direct children. These checks can change `available` to `missing` when the
stored path has vanished, but do not change the relative path or guess which
unlinked filesystem entry is the moved file. Scan reconciliation performs
automatic high-confidence repair; the explicit Missing Files action handles a
unique replacement that is already linked.

`availability` has a third value, `trashed` (ADR-0013 §3.2), which no scan or
access check ever sets or clears — only a guarded delete and its restore do.
The distinction it draws is the point: `missing` means *we do not know where
this went*, which is the repair machinery's problem, while `trashed` means *we
put it there, and here is how to put it back*. So scan reconciliation skips
trashed rows rather than sweeping them into `missing`, which would empty the
Trash view into Missing Files and make a restore look like a repair. A trashed
row's `relative_path` points at its location **inside** `.cairndex/trash/`,
because that is where the bytes are — which also frees the original path for
something else to take, exactly as Replace needs.

The scanner ignores hidden paths (`.cairndex`, dotfiles/dot-directories, and a
small denylist such as `.DS_Store`, `__pycache__`, `node_modules`, `Thumbs.db`).
A rescan also deletes scan-created provisional rows that point at now-ignored
hidden paths, so portable cache files do not remain as user-visible assets.

### `tags`

`id`, `parent_id` (self-FK, `SET NULL`), `name`, `color`, `sort_order`,
`version`, timestamps. Unique `(parent_id, name)`.

The All Tags management page orders tags by **name (Chinese-aware / pinyin)**, not
by `sort_order`, and its drag gesture **reparents** a tag (sets `parent_id`, via
`update_tag` with the existing cycle guard) rather than reordering siblings. The
`sort_order` column is retained (harmless, defaults to 0) but no longer written —
the manual sibling-reorder endpoint (`PUT /tags/reorder`) was removed once the UI
switched to name ordering + reparent-by-drag.

**Tag deletion (safe-delete):** the delete service blocks a tag that still has
child tags (a friendly 409, no cascade) so the owner deletes or moves the
children first. A *leaf* tag deletes outright; its bundle/tag assignments and
tag-group memberships fall away via the association tables' FK cascade, and no
file or bundle is ever touched. (The schema's `parent_id ON DELETE SET NULL`
would still float orphans if a row were force-deleted, but the service path never
reaches it while children exist.)

### `tag_groups`

`id`, `name` (unique), `sort_order`, timestamps.

### `tag_group_memberships`

Many-to-many tags to groups: `group_id` + `tag_id` composite PK, both CASCADE,
plus `sort_order`. A group is not a hierarchy parent. `sort_order` is the tag's
display order *within that group*: `set_group_tags` stamps it from the assignment
order and `GET /tag-groups/{id}/tags` returns member ids in that order (the
dedicated `PUT /tag-groups/{id}/tags/order` reorder endpoint was removed with the
tag-reorder cleanup). Group membership never changes a tag's hierarchy
`parent_id`.

### `collections`

Hierarchical virtual groupings of bundles. `id`, `parent_id` (self-FK,
`SET NULL`), `name`, `sort_order`, `version`, timestamps. Unique
`(parent_id, name)`. Collections are logical and independent of the physical File
View; membership never moves source files.

### `asset_bundle_tags` / `asset_bundle_collections`

Many-to-many membership tables with composite PKs and CASCADE FKs. Collection
membership is virtual and never moves files on disk. `asset_bundle_collections`
also carries `sort_order` (int, `server_default 0`): the bundle's manual order
*within that collection*, used by the **Manual** browse sort and rewritten by
drag-reorder / "Clean up by…". The global counterpart is
`asset_bundles.manual_order`.

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

### `playback_progress`

Owner watch/resume state for playable videos. Columns:

`file_id` (PK, FK to `asset_files`, CASCADE), `bundle_id` (denormalized current
bundle id for continue-watching queries), `position_s`, `duration_s` (nullable),
`completed` (integer boolean, default 0), `updated_at`, and `user_id`.

`user_id = NULL` means the single owner. The nullable column is reserved for a
future multi-user model without changing the current single-owner auth surface.

Progress is keyed by stable `AssetFile.id`, so high-confidence moved-file repair
keeps resume state without a special repair step. The ORM syncs the denormalized
`bundle_id` from the single `AssetFile.bundle_id` re-parent hook whenever a file
moves between bundles. Deleting an `AssetFile` cascades progress cleanup because
library DB connections run with `PRAGMA foreign_keys=ON`.

`completed` is computed only when `duration_s` is known and positive
(`position_s / duration_s >= 0.95`). Clients send the media element duration
whenever it is finite; a `NULL` duration means the completion threshold cannot be
computed yet, so the row remains in-progress until a later report includes a
known duration or the user restarts it.

Indexes:

- `ix_playback_progress_bundle_id` for bundle-scoped lookup;
- `ix_playback_progress_completed_updated_at` for continue-watching
  (`completed = 0`, newest `updated_at` first).

### `bundle_cursors`

One current ordered-media location per bundle (ADR-0016). Columns:

`bundle_id` (PK, FK to `asset_bundles`, CASCADE), `file_id` (unique FK to
`asset_files`, CASCADE), and `updated_at`.

The row is intentionally separate from `asset_bundles`: changing the current
viewer file is owner navigation state and does not bump the bundle's optimistic
metadata version. The current timestamp for a video remains in
`playback_progress`; an image needs only this pointer. Re-parenting the current
file clears the old bundle's cursor in the same ORM hook that syncs progress
ownership. Existing libraries add the table through the normal metadata
bootstrap when opened.

### `grouping_plans` / `grouping_proposals` / `grouping_proposal_files`

Durable, reviewable snapshots of the grouping suggester output.

- `grouping_plans`: `id`, `scan_job_id` (nullable; registry job id, no cross-DB
  FK), `status` (`open` | `applied` | `superseded` | `cancelled`),
  `rule_version`, `stem_modes` (JSON map from library-relative directory to
  `narrow` | `balanced` | `wide`), `generated_at`, `applied_at`, `version`,
  timestamps. Generating a new plan supersedes the prior open one. Scan jobs
  generate an open plan and return its id/proposal count without applying it.
- `grouping_proposals`: `id`, `plan_id` (FK, CASCADE), `parent_proposal_id` (self
  FK, SET NULL), `target_bundle_id` (plain id for addition proposals),
  `target_bundle_title` (nullable display snapshot), `create_new_bundle`
  (additive destination override, default false),
  `base_bundle_id` (the stable original identity used by explicitly edited
  bundle proposals), `owner_edited`, `kind` (`bundle` | `container`), `title`,
  `directory`, `confidence`, `reason`, `sort_order`.
- `grouping_proposal_files`: `id`, `proposal_id` (FK, CASCADE), `asset_file_id`
  (snapshot id, not an FK), `relative_path` (display snapshot), `proposed_role`,
  `sequence`.

Apply is idempotent and conflict-aware: it merges/splits provisional bundles
preserving `AssetFile.id`, assigns roles, selects a cover, links external
subtitles, creates suggested collections, and never touches the filesystem.
`POST /grouping/plans/{id}/apply` may include `proposal_ids`; when supplied, only
that selected subset is accepted and the plan is marked applied, so unchecked
proposals are not retained as pending work for the same plan.
`PATCH /grouping/plans/{id}/proposals/{proposal_id}` can retitle a BUNDLE or
CONTAINER proposal while the plan is open. `PUT
/grouping/plans/{id}/proposals/{proposal_id}/destination` switches an addition
between its existing target and a separate new bundle while retaining the target
id as a reversible alternative. Existing mode uses addition roles; new mode uses
normal bundle roles without changing reviewed sequence and permits proposal
rename. A missing target blocks switching back to existing mode but does not
block applying new mode. Legacy open plans backfill the target-title snapshot
and derive their fresh-bundle title on first switch. `PUT
/grouping/plans/{id}/proposals/{proposal_id}/files/{asset_file_id}/move` moves a
stable file id to an exact position within any BUNDLE proposal and rewrites dense
sequence/derived-role values for every affected proposal. `PUT
/grouping/plans/{id}/proposals/{proposal_id}/parent` reparents a BUNDLE proposal
into a CONTAINER proposal or back to the top level. These owner edits are marked
explicitly so apply can preserve `base_bundle_id` across reviewed provisional
membership changes. Confirmed bundles remain outside regenerated plans.
`POST /grouping/plans` accepts the bounded `stem_modes` map used to regenerate
that snapshot; omitting a directory selects the balanced default.

### `file_operations`

The guarded-write journal (ADR-0013 §3.1): `id`, `op`, `status`, `payload`
(JSON), `error`, `created_at`, `finished_at`. In the **library** DB, not the
registry, so the history travels with the library the way the operations'
effects do.

`status` moves `pending` → `done` | `failed`, or `done` → `undone`. The
`pending` row is written **and committed before the filesystem is touched**;
the content rows and the `done` status are then written in one transaction, so
metadata and status can never disagree. A crash in between leaves a `pending`
row that the reconciler settles on the next library open by looking at the
filesystem: source gone and destination present means the operation happened
(finish the metadata side), source present and destination absent means it did
not (`failed`), and anything else is left to the scanner's moved-file repair
rather than guessed at.

`payload` is JSON rather than columns because each verb has a different shape
and this table must not grow a column per operation. For `rename` it carries
`source`, `destination`, and — once finished — `files_updated`; for `mkdir`,
`destination`; for `trash`, the requested `paths` and the resulting `entries`
(each with `original_path`, `stored_path`, `file_id`, `is_directory`); for
`import`, the `destination`, `filename` and `size_bytes` written. It is also
what Undo reads to apply the inverse.

**The journal is the trash's index.** A `trash` row still in `done` has not been
restored (`undone`) or permanently deleted (`emptied`), so listing the trash is
one query against this table and no second table has to be kept in step with it.
A Replace records `replaced_operation_id` pointing at the `trash` row for the
file it displaced — so the displaced file appears in the Trash view like any
other deletion, and undoing the rename restores it.

Renaming updates `AssetFile.relative_path` (and the derived `directory_path`)
in the same transaction, **preserving `AssetFile.id`**, which is what carries
bundle membership, covers, subtitle links, notes, ratings, and cache identity
across the rename. A directory rename repoints every row beneath it, matched on
path segments in Python — a SQL `LIKE 'Show/S01%'` rewrite would also sweep up
`Show/S01 extras/`.

## Registry database

The registry DB lives at `{CAIRNDEX_DATA_DIR}/registry.db` and is server-local
runtime state. It is not portable library metadata and has its own
`create_all`-based lifecycle.

### `registered_libraries`

`id`, `library_uuid` (copied from the library manifest, unique), `name`,
`root_path` (absolute, normalized, unique), `manifest_path`, `status`,
`schema_version`, `write_mode_enabled`, timestamps, `last_opened_at`. One row per
known `<root>/.cairndex/` library package.

`write_mode_enabled` (default false) is the owner's per-library opt-in to
guarded file operations (ADR-0013). It lives here rather than in the portable
manifest **on purpose**: a library copied to another server must arrive
read-only, never carrying write permission with it. `CAIRNDEX_WRITE_MODE=disabled`
overrides it deployment-wide. Registries created before ADR-0013 gain the column
additively, defaulting to off.

### `job_queue`

`id`, `library_id` (FK to `registered_libraries`, CASCADE), `job_type`, `status`,
`payload` (JSON), `processed`, `total`, `result` (JSON), `error`,
`cancel_requested`, timestamps, `started_at`, `finished_at`.

### `device_tokens`

Server-issued native-client credentials (ADR-0015): `id`, display `name`,
salted `token_hash`, JSON `library_ids` scope, `created_at`, nullable
`last_used_at`, and nullable `revoked_at`. Bearer plaintext is returned only by
the first approved pairing poll and never stored. Revocation retains the row for
owner audit. This is registry/runtime state, not portable library metadata.

### `server_identity`

This install's stable identity (ADR-0018 §2): `id`, `server_uuid` (unique),
`machine_name`, `created_at`. Exactly one row, created on first use. Every
ownership lease this server writes carries the `server_uuid`, so it must survive
restarts — a regenerated identity would make a crashed server fail to recognize
its own lease and demand a takeover confirmation on every start. `machine_name`
is refreshed from the host (or `CAIRNDEX_MACHINE_NAME`) on read, so renaming a
machine shows up in the next lease write without minting a new identity.

Server-local infrastructure, not library state, so it does not conflict with the
ADR-0018 §1 portability invariant: nothing here is authoritative for a library,
and a fresh install simply mints a new identity.

### Ownership lease (not a table)

The active-owner lease is a JSON file *inside each library* at
`.cairndex/locks/active-owner.json`, not a registry row — deliberately, since two
conflicting servers cannot see each other's registries and a synced library copy
has no server at all. See `docs/architecture.md` §4.1 and ADR-0018.

The in-process worker consumes this registry queue. Each job names a library;
the worker opens that library's `library.db`, runs scan/probe/thumbnail/storyboard
handlers against the library root, commits durable content results into the
library DB, and writes progress/terminal state back to the registry row.

## Non-table model surfaces

### File Browser entries

Read-only File Browser entries are produced by `services/file_view.py` from the live
filesystem under the active library root. They are response models rather than
persistent rows. Each entry is derived from a library-relative path, path-safety
checks, filesystem metadata, media classification, and an optional linked
`AssetFile` lookup. Hidden entries are excluded. `supported`/openable is derived
from media kind plus format support: video/audio are playable, browser-native
images remain openable, and preview-capable images such as HEIC, TIFF, and BMP
are openable through the server preview pipeline.

Future native file handoff and write mode are documented in ADR-0007 and have no
schema yet.

### Derived media cache

Thumbnails, image previews, converted WebVTT subtitles, and storyboard trickplay
artifacts are generated under the library's portable `.cairndex/cache/` package:

- `thumbnails/{file_id[:2]}/{file_id}.jpg`
- `previews/{file_id[:2]}/{file_id}_{size}.webp`
- `previews/{file_id[:2]}/{file_id}_{size}.fingerprint`
- `previews/pa/path_{sha256(relative_path)[:32]}_{size}.webp` for File Browser path previews
- `previews/pa/path_{sha256(relative_path)[:32]}_{size}.fingerprint`
- `subtitles/{track_id[:2]}/{track_id}.vtt`
- `storyboards/{file_id[:2]}/{file_id}/{index.vtt,index.fingerprint,sb_*.jpg}`

Preview `size` is restricted to `640`, `1600`, or `2560`. Preview fingerprint
sidecars store the source file's quick fingerprint; the storyboard index
sidecar stores its format version plus that fingerprint, so stale-format checks
do not open the full VTT. These are reproducible cache artifacts, not
`AssetFile` rows, and scanners intentionally ignore them.

Video `AssetFile` rows may store nullable `cover_time`; it selects the
timestamp used whenever that file's thumbnail is regenerated. Clearing the
field restores automatic representative-frame selection. A private nullable
`cover_previous_file_id` remembers the bundle cover displaced by the first
custom-frame selection so reset restores an image or automatic cover; a newer
manual cover choice is never overwritten. These values are portable metadata in
`library.db`; only the derived JPEG changes, never the original.

## Deferred to later phases

- Generalized media tracks / embedded-stream extraction and remux/transcode
  fallback.
- Bundle-level links/sources if needed beyond current file-level `source`.
- Cross-filesystem moved-file repair, ambiguous repair candidates, duplicate/copy
  resolution, and optional full-hash verification.
- File Browser write/native integration.
- Index plan beyond current PK/unique constraints, especially for server-side
  text search/SQLite FTS5, browse-summary aggregation, tag/collection membership
  queries, and larger-library benchmarks.
- Collection delete service semantics beyond current FK defaults (tag delete now
  has explicit safe-delete semantics — see `tags` above).
