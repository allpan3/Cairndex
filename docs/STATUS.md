# Project status

## Current branch / latest commit

Branch: `feature/core-domain-model` (Phase 1), based on `main`. Latest
commit: see `git log -1`.

## Current milestone

**Phase 1 — Core domain and storage roots** (`feature/core-domain-model`).
Implemented: SQLAlchemy schema + Alembic migration; path-safety module;
domain services + `/api/v1` CRUD for storage roots, bundles (metadata-only
file linking, cover/primary, tag/folder assignment), tags, tag groups, and
folders; keyset pagination; structured errors; recursive-CTE descendant
queries; synthetic seeder; generated frontend API types. Backend: 64 tests
passing, ruff + mypy clean, migration round-trip + `alembic check` clean.
The GitHub PR (#2) description has the full summary. **Phase 0** is
merged to `main` (PR #3).

## Completed in this milestone

- SQLAlchemy 2.0 schema + first Alembic migration for all 10 core tables
  (ADR-0002: ULID PKs, tz-aware UTC timestamps, adjacency-list hierarchy,
  SQLite WAL/foreign-keys pragmas).
- Path-safety module (`core/paths`): normalizes client relative paths and
  rejects absolute/traversal/symlink-escape — the single choke point for
  storage-root path resolution.
- Domain services + `/api/v1` CRUD for storage roots, bundles (metadata-only
  file linking/unlinking, cover/primary selection, tag/folder assignment),
  tags, tag groups (multi-membership), and folders; keyset pagination;
  structured errors; recursive-CTE descendant queries.
- Synthetic library generator + seed CLI (`python -m cairndex.devtools.seed`).
- Frontend API types generated from the OpenAPI schema and wired into the
  client (`npm run gen:api`).

## Tests run (this session, on macOS)

All passing:

- Backend (`apps/server`): `ruff format --check`, `ruff check`, `mypy src`,
  and `pytest` (**64 passed**); Alembic upgrade/downgrade/upgrade round-trip
  and `alembic check` — clean.
- Frontend (`apps/web`): `lint`, `format:check`, `typecheck`, `test` (3) —
  verifies the generated `schema.d.ts` compiles and the client consumes it.
- CI green on PR #2 (backend, frontend, Docker build).

## Known issues / environment gaps

- `ffmpeg`/`ffprobe` are not installed on the dev machine. Required from
  Phase 2 (scanner/media metadata) — install with `brew install ffmpeg`.
- No scanner or browsing UI yet (Phases 2 and 3); Smart Folders have a table
  but no filter compiler yet (Phase 5).

## Next recommended task

**Phase 2 — Scanner, indexing, and media metadata**
(`feature/library-scanner`): manual incremental storage-root scan as a
resumable background job, quick fingerprint + lazy full hash, ffprobe
metadata extraction, thumbnail extraction/cache, and missing-file state.
Requires `ffmpeg`/`ffprobe` installed (`brew install ffmpeg`). See the
product brief's "Phase 2" section for acceptance criteria.

Smart Folders have a table but no filter compiler yet — that is Phase 5
(`docs/filter-language.md`).

## Unresolved decisions

- None blocking. Open design questions for later phases are tracked inline
  in `docs/data-model.md` ("What Phase 1 must decide") and
  `docs/filter-language.md` ("Open questions for Phase 5").
