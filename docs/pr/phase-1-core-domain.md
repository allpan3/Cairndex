# PR: Phase 1 — Core domain and storage roots

- Branch: `feature/core-domain-model` → `chore/project-foundation` (stacked on
  the still-open Phase 0 PR #1; rebases onto `main` once #1 merges)
- Status: ready for review

## Problem and scope

Establish the bundle-centric domain model, storage-root safety, and the
metadata CRUD surface — the foundation every later milestone builds on. In
scope: schema + migration, path safety, and domain services + `/api/v1` CRUD
for storage roots, bundles/files, tags, tag groups, and folders. Out of
scope: scanning/ffprobe (Phase 2), the filter compiler (Phase 5), and the
browsing UI (Phase 3).

## Design summary

- **Schema (ADR-0002)**: SQLAlchemy 2.0 typed models + one Alembic migration
  for all 10 core tables. ULID string PKs (sortable → pagination tie-breaker),
  tz-aware UTC timestamps via a `UtcDateTime` type decorator, adjacency-list
  hierarchy for tags/folders, SQLite WAL + `foreign_keys` pragmas. Migrations
  render custom types as stock SQLAlchemy so they stay app-independent.
- **Path safety (`core/paths`)**: the single choke point that normalizes
  client relative paths and rejects absolute/UNC/traversal/symlink-escape.
  All file linking routes through it; locations are stored as
  `storage_root_id + relative_path`, never a client absolute path.
- **Service / API layering**: HTTP-agnostic services raise domain errors
  (`core/errors`) that an exception handler maps to 404/409/422; routes are
  thin. Reusable keyset pagination over the ULID id. Descendant queries use a
  shared recursive-CTE helper.
- **Metadata-only & non-destructive**: linking/unlinking files and deleting
  bundles only ever touch rows; a test proves the physical files survive.
- **Tooling**: synthetic library generator + seed CLI; frontend API types
  generated from the OpenAPI schema and wired into the client.

## API surface (`/api/v1`)

`storage-roots`, `bundles` (+ `/files`, `/tags`, `/folders`), `tags`,
`tag-groups` (+ `/tags`), `folders` — full CRUD with pagination.

## Acceptance criteria (Phase 1)

- ✅ Create a storage root; create a bundle; link multiple files from that
  root to one bundle without copying; assign shared metadata.
- ✅ Hierarchical tags + multiple tag-group membership (independent of
  hierarchy); multiple hierarchical folders per bundle.
- ✅ Path-traversal / out-of-root / symlink-escape rejected (26 path tests).
- ✅ No API modifies original files — proven by the acceptance test
  (unlink file + delete bundle leave all files on disk).

## Tests run (macOS)

- Backend: `ruff format --check`, `ruff check`, `mypy src` — clean;
  `pytest` — **64 passed**; Alembic upgrade/downgrade/upgrade round-trip and
  `alembic check` — clean.
- Frontend: `lint`, `format:check`, `typecheck`, `test` (3) — clean (verifies
  the generated `schema.d.ts` compiles and the client uses it).

## Notable decisions / call-outs

- **Synchronous** SQLAlchemy (ADR-0002) — SQLite serializes writes; async adds
  complexity for no benefit at this scale.
- Tag/folder parent delete uses DB `SET NULL` (children float to root); a
  richer reparent/cascade policy is deferred to the service layer.
- `openapi-typescript` is run via `npx` (not a pinned devDep) because its
  TypeScript peer range doesn't yet include TS 6.

## Migration notes

One new migration (`core schema`). Fresh database: `alembic upgrade head`.

## Follow-ups / next

- **Phase 2 — Scanner, indexing, media metadata** (`feature/library-scanner`):
  needs `ffmpeg`/`ffprobe` (`brew install ffmpeg`).
- Smart Folder filter compiler is Phase 5; `smart_folders` table exists but is
  not yet wired to a query.
