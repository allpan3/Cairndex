# Project status

## Current branch / latest commit

Branch: `feat/per-library-content`. Latest commit: see `git log -1`.

ADR-0008 is landing incrementally: PR 1 (registry skeleton, #20) and PR 2
(per-library engine + first scoped route, #21) have merged to `main`. This
branch is the **create → scan → browse** working slice (phases 3–5/7).

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

- **PR 2 — per-library engine + first scoped route (merged, PR #21).**
  - Per-library content engine/session cache (`registry/library_engine.py`) and
    a `LibrarySession` dependency; first scoped route `/libraries/{id}/collections`
    with two-library isolation tests.

- **PR 3 — create → scan → browse working slice (this branch; phases 3–5/7).**
  - **Schema collapse:** removed `StorageRoot` and `asset_files.storage_root_id`;
    `relative_path` is library-root-relative with `UNIQUE(relative_path)`. Moved
    the `jobs` table to the registry `job_queue`. Library DBs use `create_all`
    (Alembic chain + `test_migrations` removed for the clean break).
  - **Route migration:** all content APIs now live under
    `/api/v1/libraries/{library_id}/…`; the global content + storage-root routers
    are gone. Path resolution derives the library root from the content session
    (`library_root_for_session`).
  - **Per-library worker:** the worker drains the registry `job_queue`, opens the
    target library DB, and runs scan/probe/thumbnail against the library root.
  - **Frontend:** active-library bootstrap (one per tab), library selector +
    Scan action, create/register library manager; storage-root + Eagle UI removed.
  - **Eagle import** temporarily removed (reader/planner kept) pending a
    per-library re-implementation.

## Tests and validation

Run and passing locally for this PR:

- backend: `ruff check`, `ruff format --check`, `mypy src`, `pytest` (171 passed);
- frontend: `lint`, `typecheck`, `vitest` (3), `build`, Playwright e2e (10);
- `demo/run_libraries.sh` exercises create → scan → browse end to end.

## Known issues / environment gaps

- Eagle import is unavailable until re-implemented for the per-library model.
- The registry uses `create_all` bootstrap rather than a versioned migration
  chain; if its schema needs to evolve it will get its own chain.
- Clean break from pre-release dev data: no global-DB → per-library migration
  (ADR-0008 decision 10). Existing dev data is discarded; create/scan a library.
- No authentication yet (`AGENTS.md` §12); single SQLite writer / single uvicorn
  worker by design (ADR-0001).

## Next recommended tasks

Following the ADR-0008 phase/PR sequence:

- Re-implement **Eagle import** as a library-scoped operation (link into the
  active library; paths relative to the library root).
- PR 8 — `.cairndex/cache` relocation (thumbnails/subtitles under the library)
  and docs polish.
- PR 9 — optimistic-concurrency versions + operation-based tag/collection edits.
- Per-library probe/thumbnail UI actions (jobs already exist server-side).

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is wired up.
- Direct-open desktop mode and its active-owner lease (ADR-0008 phases 10–11)
  are documented but intentionally unimplemented until that client is built.
