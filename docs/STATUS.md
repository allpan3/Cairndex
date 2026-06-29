# Project status

## Current branch / latest commit

Branch: `feat/concurrency-ui-and-jobs`. Latest commit: see `git log -1`.

ADR-0008 landed incrementally: registry skeleton (#20), per-library engine +
first scoped route (#21), create → scan → browse working slice (#22, phases 3–7),
Eagle-import removal (#23), cache relocation (#24, phase 8), and optimistic
concurrency (#25, phase 9) have merged to `main`. This branch adds the
**frontend** for optimistic concurrency (sending `If-Match` + a conflict notice)
and **per-library maintenance UI actions** (Probe / Thumbnails alongside Scan).
The ADR-0008 server-managed phases are complete; only the future direct-open /
native modes (phases 10–11) remain.

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
  - **Eagle import** removed entirely (reader/planner package, `services.eagle`,
    and the `import_records` table); ADR-0004 retained as superseded. Eagle
    remains a UI-design *inspiration* only.

- **Phase 8 — cache relocation (merged, #24).** Thumbnails and converted WebVTT
  subtitles are now written into each library's portable
  `.cairndex/cache/{thumbnails,subtitles}/` (derived from the library root via
  `registry.library_package.cache_dir`), never into the server data dir and never
  beside source media. Removed the now-unused `Settings.cache_dir`. A future
  `cache_mode` (`inside_library` | `server_local`) is documented for large
  transcodes.

- **Phase 9 — optimistic concurrency (this branch).** The frequently edited
  entities carry a `version` integer (`persistence.base.Version`); single-entity
  `PATCH` routes accept an optional `If-Match: <version>` header and reject a
  stale edit with 409 (`version_conflict`) before mutating, via
  `persistence.concurrency.guard_and_bump_version`. `version` is exposed on the
  read models. Without `If-Match`, edits stay last-write-wins (back-compatible).
  Frontend wiring (surfacing 409 + reload) is a follow-up.

## Tests and validation

Run and passing locally for this PR:

- backend: `ruff check`, `ruff format --check`, `mypy src`, `pytest` (172 passed);
- frontend: `lint`, `format:check`, `typecheck`, `build` (OpenAPI + types
  regenerated for the new `version` field and `If-Match` header).

## Known issues / environment gaps

- Eagle import has been removed (out of scope under the per-library model);
  libraries are populated by scanning, not by migrating from another app.
- The registry uses `create_all` bootstrap rather than a versioned migration
  chain; if its schema needs to evolve it will get its own chain.
- Clean break from pre-release dev data: no global-DB → per-library migration
  (ADR-0008 decision 10). Existing dev data is discarded; create/scan a library.
- No authentication yet (`AGENTS.md` §12); single SQLite writer / single uvicorn
  worker by design (ADR-0001).

## Next recommended tasks

The server-managed ADR-0008 phases (1–9), their frontend wiring, and the
per-library maintenance UI actions are all complete. Remaining / follow-up:

- **Bundle grouping redesign (ADR-0009, accepted Option A+ plan).** Keep
  `AssetBundle` and `Collection` separate, add provisional bundle grouping state
  plus durable grouping plans, then implement the propose→review→apply workflow
  in phased PRs: schema state, read-only suggester, apply-plan API, review UI,
  re-scan additions, and external subtitle auto-link.
- Job progress UI: surface running scan/probe/thumbnail progress (the registry
  `job_queue` tracks `processed`/`total`; the UI currently fire-and-forgets).
- Future: direct-open / native desktop modes + active-owner lease (phases 10–11).

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is wired up.
- Direct-open desktop mode and its active-owner lease (ADR-0008 phases 10–11)
  are documented but intentionally unimplemented until that client is built.
