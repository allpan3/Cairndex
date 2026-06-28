# Project status

## Current branch / latest commit

Branch: `feat/per-library-engine`. Latest commit: see `git log -1`.

The Collections + read-only File View refactor and the shared library
selector / File View preview have merged to `main` (PRs #18, #19), along with
the parallel in-bundle album/viewer work. ADR-0008 PR 1 (registry skeleton) has
merged to `main` (PR #20).

## Current milestone

**Per-library metadata + server/registry architecture (ADR-0008).** Moving from
one global content database to portable, Eagle-like libraries — each a directory
with a `.cairndex/` marker holding `manifest.json`, `library.db`, and `cache/`
— while keeping the Jellyfin-like server/client split. The library DB travels
with the folder; the server is normally the only metadata writer and routes
content by `library_id`. The full phase plan is in ADR-0008.

This is being landed incrementally across several PRs; do not implement all
phases at once.

## Completed in this milestone

- **PR 1 — ADR + registry skeleton (merged, PR #20).**
  - ADR-0008 documenting the per-library + registry architecture, explicitly
    distinguishing metadata writes vs. physical file writes vs. native opening.
  - Registry database (`{CAIRNDEX_DATA_DIR}/registry.db`, package
    `cairndex.registry`): `registered_libraries` and `job_queue` models, a
    separate engine/sessionmaker, and a `RegistryDbSession` dependency.
  - On-disk library package handler (`registry/library_package.py`): manifest
    format, create, and detect.
  - Services + endpoints: `GET /api/v1/libraries`,
    `POST /api/v1/libraries/create`, `POST /api/v1/libraries/register`,
    `GET /api/v1/libraries/{id}`. Backend tests in `tests/test_libraries.py`.

- **PR 2 — per-library engine + route scoping (this branch).**
  - Per-library content engine/session cache (`registry/library_engine.py`),
    keyed by `library_id` and resolved DB path (a moved library re-opens
    transparently); `dispose`/`refresh`/`dispose_all` helpers.
  - `LibrarySession` dependency (`api/deps.py`): resolves `{library_id}` in the
    registry, 404s an unavailable library, yields a session on its `library.db`.
  - First library-scoped content route:
    `/api/v1/libraries/{library_id}/collections` (create/list/get/update/delete),
    alongside the existing global `/collections`.
  - `tests/test_library_scoped.py` proves two-library isolation; OpenAPI +
    frontend types regenerated.

## Tests and validation

Run and passing locally for this PR:

- backend: `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run mypy src`, `uv run pytest` (198 passed);
- frontend: `npm run lint`, `npm run typecheck`, `npm run build` (types
  regenerated; no frontend integration yet — that is ADR-0008 phase 6).

## Known issues / environment gaps

- Most content APIs are still global / storage-root-scoped; only collections
  have a library-scoped route so far. Migrating the rest under `/libraries/{id}`
  (phase 4) and the `storage_roots` schema collapse (phase 5) are upcoming PRs.
- The global `/collections` router and the per-library
  `/libraries/{id}/collections` router coexist during the transition; the global
  one is removed when the migration completes.
- The registry uses `create_all` bootstrap rather than a versioned migration
  chain; if its schema needs to evolve it will get its own chain.
- `job_queue` is defined but not yet consumed — the current in-process worker
  still uses the content-DB `jobs` table (per-library worker is phase 7).
- Clean break from pre-release dev data: no global-DB → per-library migration is
  planned (ADR-0008 decision 10).
- No authentication yet (`AGENTS.md` §12); single SQLite writer / single uvicorn
  worker by design (ADR-0001).

## Next recommended tasks

Following the ADR-0008 phase/PR sequence:

- PR 3 — migrate the remaining content APIs (bundles, tags, tag groups, smart
  collections, file view, playback) under `/libraries/{id}`; regenerate
  OpenAPI/frontend types; update the API client.
- PR 4 — library DB schema collapse (drop `storage_roots`/`storage_root_id`;
  paths become library-relative).
- PR 5 — registry job queue + per-library worker.
- PR 6 — frontend library selector replacing the storage-root selector.
- PR 7 — optimistic-concurrency versions + operation-based tag/collection edits.
- PR 8 — `.cairndex/cache` relocation + docs polish.

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is wired up.
- Direct-open desktop mode and its active-owner lease (ADR-0008 phases 10–11)
  are documented but intentionally unimplemented until that client is built.
