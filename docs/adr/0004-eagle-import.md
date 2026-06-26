# ADR-0004: Eagle library import (one-way, read-only, idempotent)

- Status: accepted
- Date: 2026-06-26
- Branch/PR: `feature/eagle-import`

## Context

Phase 7 imports an existing Eagle library into Cairndex (`AGENTS.md` §7). The
hard rules: **never write into the Eagle library**, always offer a **dry-run +
reviewable report**, map each Eagle item to **one Asset Bundle**, preserve
tags/tag-groups/folders/titles/notes/links/ratings/file references, and make
imports **idempotent** (record source IDs so a re-run never duplicates).

Eagle exposes a local HTTP API only while the app runs; the durable, offline
source of truth is the on-disk `.library` directory. We read that directly in
read-only mode (§7 — "if API coverage is insufficient, inspect library files
in read-only mode"), so import works without Eagle running.

## Eagle on-disk format we read

- `<name>.library/metadata.json` — `folders` (hierarchical via `children`),
  `tagsGroups` (`{name, tags: [...]}`), and app version.
- `<name>.library/images/<ITEMID>.info/metadata.json` — per item: `id`,
  `name`, `ext`, `tags` (names), `folders` (folder ids), `annotation` (→ note),
  `url` (→ file source), `star` (0–5 rating), `isDeleted`, dimensions, times.
- The asset itself lives beside it as `images/<ITEMID>.info/<name>.<ext>`.

All reads are read-only; we never open the library for writing.

## Decisions

### 1. The library `images/` directory becomes a storage root

Imported files are **linked, not copied** (metadata-only, `AGENTS.md` §3/§5.1).
We ensure a `StorageRoot` at the library's `images/` directory and link each
item's file by its relative path `"<ITEMID>.info/<name>.<ext>"`, so every path
is validated against a root by the existing `core.paths` choke point. The
Eagle library is otherwise untouched.

### 2. Mapping

- Eagle **folder** → `Folder` (hierarchy from `children`); Eagle folder id →
  our folder id is remembered for the run so item membership resolves.
- Eagle **tagsGroups** → `TagGroup`; member tag names → `Tag` (flat, created
  on demand) added to that group. Item tags not in any group become ungrouped
  tags. Eagle tags are flat strings, so imported tags are flat (no hierarchy).
- Eagle **item** → `AssetBundle` (`title=name`, `note=annotation`,
  `rating=star or null`), with its tags + folders attached, and **one**
  `AssetFile` (`source=url`, role/kind by extension). `isDeleted` items are
  skipped.

### 3. Idempotency via an `import_records` table

A generic mapping table `import_records(provider, external_id, bundle_id,
imported_at)` with `UNIQUE(provider, external_id)`. On import we skip any Eagle
item whose `("eagle", item.id)` already has a record, so re-running is safe and
incremental. Generic columns keep the table reusable for future importers
without coupling core ids to Eagle.

### 4. Dry run first, always

`plan_import()` reads the library and produces an `ImportPlan` (bundles/tags/
groups/folders to create, items skipped, merge **suggestions**) with **no DB
writes**. The API/UI show this report; only an explicit commit applies it.
Merge suggestions are advisory and never auto-applied destructively (§7); the
MVP maps one item → one bundle and surfaces likely video/cover/subtitle/part
groupings (same folder + basename) for later manual merging.

## Consequences

- Adding `import_records` is a small additive migration (SQLite batch +
  app-independent `render_item`, `ruff-format`ed).
- The reader is pure/read-only and unit-tested against **synthetic** Eagle
  fixtures (no private media, `AGENTS.md` §15).
- Importing the same library twice creates nothing new (covered by a test).

## References

- `AGENTS.md` §7 (Eagle migration), §5.1 (link, don't copy), §15 (tests)
- ADR-0002 (schema conventions), ADR-0003 (recent additive-table precedent)
