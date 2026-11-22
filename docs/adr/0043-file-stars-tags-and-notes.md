# ADR-0043: Per-file stars, tags, notes, and one-way bundle tag propagation

- Status: accepted
- Date: 2026-11-18
- Branch/PR: `feat/file-stars-tags-notes`

## Context

In the current product model, owners organize multi-file bundles (photo sets, comics/manga chapters, multi-clip videos) using bundle-level 0–5 `rating`, `tags`, and `notes`. Individual `asset_files` rows already store authored scalar fields (`display_title`, `note`, `source`, `cover_time`) indexed by full-text search, and Moments ([ADR-0025](0025-moment-tag-propagation.md)) already attach tags to time ranges inside a video with one-way propagation to the parent bundle.

Owners also need lightweight per-file curation without polluting bundle-level half-star scoring or requiring destructive filesystem changes:

1. Opening a bundle directly into its Album / Folder view with one click or keyboard shortcut (`⌘↓` on macOS, `Alt+↓` on Windows/Linux).
2. Marking standout individual files in a bundle with a binary **Star** (`starred: bool`) — visible in the sidebar file list, viewer rail, Open Bundle album grid/list, and File Inspector, and filterable inside the bundle and via Smart Collections (`has_starred_files`).
3. Editing per-file **Tags** (using the shared `tags` hierarchy), **Note**, and **Source** URL in the File Inspector, and filtering an Open Bundle's files by starred state and file tags.
4. Remaining lossless and backwards-compatible with existing Format-3 portable libraries ([ADR-0035](0035-portable-library-format.md)): already-published replica objects for `asset_files` have a fixed field set and must continue to open cleanly without rewriting event history.

Constraints from `AGENTS.md` and `docs/replica-catalog.md`: single-owner-first and metadata-first (no source media rewrites), no N+1 request-time queries, complete server-side filtering and paginated tag choices, deterministic tie-breakers, and full causal/conflict semantics across replicas.

## Decision

1. **Binary File Star (`asset_file_stars`), separate from bundle `rating`:**
   Individual files have an on/off **Star** rather than a 0–5 numeric score. Bundle `rating` remains bundle-only, and starring or unstarring files never alters the parent bundle's rating.
2. **Per-file tags (`asset_file_tags`) propagate one way to confirmed parent bundles (`asset_bundle_tags`):**
   Mirroring [ADR-0025](0025-moment-tag-propagation.md), file tags draw from the shared `tags` hierarchy through the same `TagPickerPanel`. Assigning a tag to a file whose parent bundle has `grouping_state == "CONFIRMED"` also ensures the corresponding `asset_bundle_tags` row exists (reviving a tombstone if needed). Removing a tag from a file, or deleting/moving the file, does **not** remove the tag from the old bundle. Moving, transferring, or grouping a file into a confirmed bundle keeps `AssetFile.id`, its `asset_file_stars` row, and its `asset_file_tags` rows on the file and propagates those file tags one way onto the destination confirmed bundle. Tags on files still inside `PROVISIONAL` Unbundled staging bundles do **not** propagate to `asset_bundle_tags` until the files join or become a `CONFIRMED` bundle, keeping staging bundles clean of tag memberships and browse facet counts.
3. **Separate additive authored tables instead of new `asset_files` columns:**
   - `asset_files.note` and `asset_files.source` are already authored scalar fields on `asset_files` in Format-3 catalogs and are already indexed in `catalog_search`.
   - File stars live in `asset_file_stars(file_id PK FK -> asset_files.id ON DELETE CASCADE)`.
   - File tags live in `asset_file_tags(file_id PK FK -> asset_files.id ON DELETE CASCADE, tag_id PK FK -> tags.id ON DELETE CASCADE)` with reverse index `ix_asset_file_tags_tag_id(tag_id)`.
   - In the Format-3 catalog protocol (`INVENTORY`), `asset_file_stars` (`{"authored": "file_id"}`) and `asset_file_tags` (`{"authored": "file_id tag_id"}`) are separate authored membership/presence tables rather than columns on `asset_files`. `CatalogStore.required_guards` guards any single-column primary key with a foreign key (`asset_file_stars/{file_id}/$alive = true` requires `asset_files/{file_id}/$alive`), and cascading deletes (`asset_files` or `tags`) tombstone these rows identically to other authored edges.

## Alternatives considered

- **Add `starred` column directly to `asset_files`:** Rejected. Existing Format-3 catalog objects and `restore_row` validate every `asset_files` entity against `fields("asset_files")`; adding a column to `asset_files` would break opening existing published Format-3 seeds or require a new catalog format version instead of remaining an additive Format-3 capability (`browse_version`, `album_version`, `inspector_version`).
- **0–5 numeric rating per file (`rating` on `asset_files`):** Rejected. Competes conceptually with bundle-level 0–5 ratings, complicates card/row scannability, and creates ambiguity over whether bundle ratings should be independent or aggregated. A binary Star gives fast culling and keeps bundle ratings clean.
- **Computed union for bundle tags (reading bundle own-tags ∪ file tags everywhere):** Rejected for the same reasons as [ADR-0025](0025-moment-tag-propagation.md): every browse query, tag count, filter compiler, Smart Collection preview, and staging cleanup check would have to merge a second table, and removing a propagated tag from a bundle would be impossible while the file carried it. One-way propagation preserves one indexed source of truth (`asset_bundle_tags`) for bundle-level browsing.

## Consequences

Easier:

- Published Format-3 catalogs open unchanged: entities with no `asset_file_stars` or `asset_file_tags` units simply read as unstarred and untagged, and concurrent replicas combining additions on the same file/tag or file star converge automatically.
- Legacy SQLite libraries created before `asset_file_stars` and `asset_file_tags` existed open safely via `_ADDITIVE_CONTENT_TABLES` and convert cleanly via `legacy_conversion` whether or not those tables are present in the source database.
- Smart Collections reuse a single indexed `EXISTS` predicate (`has_starred_files`), and in-bundle filtering (`starred_only`, `tag_ids` with `include_descendants`) runs server-side over all visible files in the bundle (including files under collapsed directory members).

Harder, and accepted:

- As with [ADR-0025](0025-moment-tag-propagation.md), a confirmed bundle retains tags propagated from its files (or files moved out of it) until removed from the bundle explicitly.
- Transferring or grouping files into a confirmed bundle (`Preview.transfer`, `Preview.bundle_files`, and discovery grouping commit) must carry any missing `asset_bundle_tags` additions in the same commit receipt and fail cleanly if a target `asset_bundle_tags` edge is held for conflict resolution.

## References

- [ADR-0002](0002-core-schema-identity-and-hierarchy.md) — core schema and tag hierarchy
- [ADR-0025](0025-moment-tag-propagation.md) — one-way moment-to-bundle tag propagation
- [ADR-0035](0035-portable-library-format.md) — portable Format-3 replica catalog protocol
- [`docs/data-model.md`](../data-model.md), [`docs/replica-catalog.md`](../replica-catalog.md), [`docs/filter-language.md`](../filter-language.md)
