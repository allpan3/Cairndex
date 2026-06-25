# Data model

> Status: skeleton (Phase 0). No migrations exist yet — this document is a
> placeholder that points to the canonical source and will be filled in
> during `feature/core-domain-model` (Phase 1) alongside the first Alembic
> migration and a dedicated ADR for any schema detail not already settled.

## Canonical source

`AGENTS.md` §4 ("Canonical domain model") is the authoritative description
of entities and relationships until Phase 1 migrations land. Do not treat
this file as authoritative until it has real tables and an ADR reference.

## Planned entities (tracking `AGENTS.md` §4 / the product brief's §"Initial data model to refine")

- `storage_roots`
- `asset_bundles`
- `asset_files`
- `tags`
- `tag_groups`
- `tag_group_memberships`
- `asset_bundle_tags`
- `folders`
- `asset_bundle_folders`
- `smart_folders`
- subtitle/media track table(s) — exact shape is an open design question,
  see `AGENTS.md` §4.9
- `jobs`

## What Phase 1 must decide and document here

- Final column lists and types for each table above (ER diagram or table-by-
  table reference).
- Tag hierarchy implementation: adjacency list with recursive CTE vs.
  closure table (`AGENTS.md` §4.5 requires this choice to be recorded in an
  ADR with descendant-query tests).
- Identity/fingerprint columns on `asset_files` (size, mtime, quick hash,
  optional full hash) and how they interact with rescan/dedup logic
  (`AGENTS.md` §5.1).
- Subtitle/media-track table shape (`AGENTS.md` §4.9) — external file
  reference vs. embedded stream index, in one table or two.
- Index plan, justified by the query patterns introduced in Phase 1/2/5
  (`AGENTS.md` §11 — "database indexes justified by real queries").
- Migration/rollback approach for SQLite (`Alembic` batch mode where
  `ALTER TABLE` support is limited).

## Cross-references

- `docs/filter-language.md` — the filter AST that queries this schema.
- `docs/adr/` — schema-shaping decisions get their own ADR, linked from here
  once they exist.
