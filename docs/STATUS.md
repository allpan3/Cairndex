# Project status

## Current branch / latest commit

Branch: `feat/grouping-phase2-suggester`. Latest commit: see `git log -1`.

ADR-0008 is complete and merged. Work is on **ADR-0009** (suggestion-based
bundle grouping, Option A+). Phase 1 (grouping review state) merged (#29). This
branch lands **phase 2 — the read-only grouping suggester**: a pure heuristic
(`cairndex.grouping`) that turns observed files into a `GroupingPlan` of
BUNDLE/CONTAINER proposals with roles, confidence, and reasons, plus a read-only
DB adapter. No persistence or API yet — that is phase 3.

## Current milestone

**Suggestion-based bundle grouping (ADR-0009, Option A+).** Scanning a realistic
library over-fragments (one bundle per file). ADR-0009 keeps `AssetBundle` and
`Collection` as separate tables but adds a provisional-grouping + durable
grouping-plan workflow: scan discovers files into provisional bundles, a
suggester proposes BUNDLE/CONTAINER groupings with roles/confidence/reasons, and
the user reviews and applies the plan (apply is the only step that confirms
groupings, assigns roles, creates logical collections, and links subtitles).
Confirmed user decisions are durable and win over heuristics on re-scan. The
full rollout is in ADR-0009.

This is being landed incrementally across several PRs; do not implement all
phases at once.

## Completed in this milestone (ADR-0009)

- **Phase 2 — read-only grouping suggester (this branch).** New
  `cairndex.grouping` package: a pure `suggest_grouping(files)` that produces a
  `GroupingPlan` of BUNDLE/CONTAINER proposals (per-file roles + sequence,
  confidence, reason) using content-first heuristics — one-video-plus-sidecars
  and multipart folders become bundles; unrelated-item and sub-bundle-holding
  folders become containers; nested folders recurse. Confirmed bundles are
  excluded. A read-only `grouping.service` adapter snapshots a library session
  into observations. Tests in `tests/test_grouping_suggester.py` (movie/photo/
  nested/multipart/cover/subtitle/confirmed-exclusion + over a real scan). No
  persistence, API, or UI yet.

- **Phase 1 — bundle grouping review state (merged, #29).** Added
  `grouping_state` (`provisional` | `confirmed`), `grouping_source` (`legacy` |
  `scan_suggestion` | `manual` | `fast_add` | `import`), `grouping_rule_version`,
  and `confirmed_at` to `asset_bundles`. The scanner now stages discovered files
  into `provisional` / `scan_suggestion` bundles; fast-add and manual creation
  produce `confirmed` bundles; pre-existing rows backfill as `confirmed` /
  `legacy` via server defaults. `BundleRead` exposes the state. Schema-and-state
  only — browse behaviour, suggester, apply, and review UI are unchanged/later.
  Tests in `tests/test_grouping_state.py`. (#29)

## Completed in the prior milestone (ADR-0008)

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

- backend: `ruff check`, `ruff format --check`, `mypy src` (no issues),
  `pytest` (186 passed).

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

- **Bundle grouping redesign (ADR-0009, accepted Option A+ plan).** Phases 1
  (grouping state) and 2 (read-only suggester) are done. Remaining phases, each a
  separate PR: (3) apply-plan service + API — durable plan/proposal tables and an
  idempotent, conflict-aware apply that confirms bundles/collections, merges/
  splits provisional bundles preserving `AssetFile.id`, assigns roles, and links
  subtitles; (4) review UI; (5) re-scan additions as suggestions; (6) external
  subtitle auto-link folded into role assignment.
- Job progress UI: surface running scan/probe/thumbnail progress (the registry
  `job_queue` tracks `processed`/`total`; the UI currently fire-and-forgets).
- Future: direct-open / native desktop modes + active-owner lease (phases 10–11).

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is wired up.
- Direct-open desktop mode and its active-owner lease (ADR-0008 phases 10–11)
  are documented but intentionally unimplemented until that client is built.
