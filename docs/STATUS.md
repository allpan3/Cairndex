# Project status

## Latest merged milestones

Maintenance-readiness sequence, merged as four independent PRs (#38–#41):

- **#38 — Job progress & observability (`feat/job-progress-observability`).**
  Scan/probe/thumbnail jobs report a coarse `phase` + `message` with throttled
  registry progress writes and path-redacted terminal errors; the sidebar shows
  a live determinate/indeterminate progress bar under Update.
- **#39 — Large-library perf baselines + indexing (`perf/large-library-baselines`).**
  `cairndex.devtools.synthetic_library` + `benchmark_queries` devtools; measured
  SQLite indexes (`asset_files.bundle_id` + association-table reverse indexes,
  backfilled by `ensure_content_indexes` on library open) and a non-correlated
  membership **semijoin** in the filter compiler and browse. Browse went from
  ~5.4 s to ~12 ms and view-counts ~12 s to ~14 ms at 5k bundles; all paths stay
  interactive at 100k. Baselines in `docs/performance.md`.
- **#40 — Whole-library indexed search (`feat/indexed-metadata-search`).**
  Per-library `bundle_search` FTS5 index (title/note, file
  title/filename/path/source/media-kind, tag + collection names) kept fresh by
  SQLite triggers; browse gained a `q` param composed as an FTS semijoin;
  `cairndex.devtools.reindex_search` rebuilds it. The toolbar search now covers
  the whole library, not the loaded window.
- **#41 — Per-library passphrase lock (`feat/per-library-passphrase-lock`, ADR-0010).**
  Optional owner passphrase per library (PBKDF2 hash in the manifest), unlocked
  via a library-scoped in-memory server session (opaque HTTP-only cookie), gated
  in `get_library_session`; `set_passphrase` CLI + frontend LockScreen. A private
  LAN/Tailscale guardrail, not public-internet hardening or multi-user auth.

Before this sequence, PR #37 (`feat/remove-and-context-menu`) added web-UI
removal of bundles/collections and right-click context menus (metadata-only,
`cascade` param on `DELETE /collections/{id}`).

## Earlier branches

ADR-0008 / ADR-0009 work landed on `feat/scan-grouping-review`.

ADR-0008 is implemented: Cairndex now uses portable per-library metadata
packages (`<root>/.cairndex/{manifest.json,library.db,cache/}`) plus a separate
server-local registry DB for registered libraries and the runtime job queue. The
old global storage-root content model and Eagle importer are removed from the
current product path.

ADR-0009 (suggestion-based bundle grouping, Option A+) is functionally rolled
out. The scanner still performs conservative discovery/repair first and stages
new files as provisional bundles. Scan jobs now also persist a durable grouping
plan without applying it, so grouping remains a user-reviewed decision.

PR 36 was the UI/workflow follow-up before the removal/context-menu milestone:
the sidebar exposes one primary **Update** action, with individual **Scan new
files**, **Collect metadata**, and **Review grouping** actions in the overflow
menu. Update waits for scan/grouping plan generation and ffprobe metadata
collection, invalidates affected queries, and opens grouping review when a scan
produced suggestions.

## Current milestone

**Maintenance-readiness sequence complete (#38–#41).** Job progress, large-library
browse indexing + benchmark tooling, whole-library FTS5 search, and an optional
per-library passphrase lock all landed. The next candidates are richer
edit-before-apply grouping review, File View write-mode planning, and search
relevance ranking (see *Next recommended tasks*).

The grouping/maintenance flow it builds on is unchanged — the normal maintenance
path matches the intended product model:

1. scan the active library root;
2. repair high-confidence moves without changing original files;
3. stage new files in provisional bundles;
4. generate and persist a reviewable grouping plan;
5. collect technical metadata;
6. let the user accept selected grouping proposals.

Applying a grouping plan is the only operation that confirms scan-staged
bundles, creates suggested logical collections, assigns roles, selects
cover/primary files, links external subtitles, or adds newly discovered files to
an existing confirmed bundle. It never moves, renames, deletes, or rewrites
original files.

## Current implementation notes

- **Primary maintenance flow:** **Update** is the main sidebar action. It runs
  scan + grouping-plan generation first, then probe. The overflow menu keeps
  scan-only, probe-only, and review-only actions for exception cases.
- **Grouping review:** The modal shows the persisted plan, explains that
  regeneration reruns the same heuristic against current library state, and
  supports checkboxes, cascading parent toggles, **Select all**, **Deselect all**,
  and **Accept selected**.
- **Selected accept semantics:** `POST /grouping/plans/{id}/apply` accepts an
  optional `proposal_ids` list. When supplied, only those proposals are applied;
  the plan is then marked applied, so unchecked proposals are intentionally left
  unapplied for that plan. Regenerate suggestions after library changes if the
  owner wants a fresh plan.
- **Provisional browse state:** browse summaries expose `grouping_state`, and
  provisional scan-created bundles show a visible “Needs review”/review marker
  until grouping is applied.
- **Hidden/cache exclusions:** scan and grouping ignore dot-directories/files and
  known hidden/cruft names such as `.cairndex`, `.DS_Store`, `__pycache__`,
  `node_modules`, and `Thumbs.db`. Rescan cleans up scan-staged provisional rows
  that were previously created for now-hidden paths. Browse hides hidden-only
  bundles while preserving legitimate empty bundles.
- **Thumbnail UI:** the global sidebar thumbnail button was removed. The backend
  thumbnail job/API and lazy bundle/file thumbnail endpoints remain; cover
  fallback is explicit cover → first image → selected primary video → first video
  → placeholder/no thumbnail.
- **Production deployment:** the library root mount must be writable because the
  per-library package stores `.cairndex/{manifest.json,library.db,cache/}` under
  that root. Normal MVP flows still avoid changing original media files. Backups
  should cover `/data/registry.db` plus each library's `.cairndex/library.db`;
  derived cache files are regenerable.

## Completed in ADR-0009

- **Phase 1 — bundle grouping review state (merged, #29).** Added
  `grouping_state`, `grouping_source`, `grouping_rule_version`, and
  `confirmed_at`; scan creates provisional bundles while fast-add/manual actions
  create confirmed bundles.
- **Phase 2 — read-only grouping suggester (merged, #30).** Added the pure
  heuristic and DB adapter that produce BUNDLE/CONTAINER proposals with roles,
  confidence, reasons, and stable ordering.
- **Phase 3 — apply-plan service + API (merged, #31).** Added durable grouping
  plans/proposals, apply semantics, conflict reporting, role assignment,
  collection creation, subtitle linking, and generated OpenAPI/frontend types.
- **Phase 4 — grouping review UI (merged, #32).** Added the review modal and
  frontend hooks for generating, reading, and applying grouping plans.
- **Phase 5 — re-scan additions (merged, #33).** New files found under a
  directory already owned by a confirmed bundle are proposed as additions instead
  of disturbing the confirmed grouping.
- **Phase 6 — external subtitle auto-link across grouping flows.** Fast-add
  single-bundle grouping now runs the same external-subtitle auto-link behavior as
  grouping-plan apply.
- **Follow-up — scan grouping review workflow (merged, #36).** Scan jobs persist
  open grouping plans; Update is the primary maintenance flow; hidden/cache paths
  are excluded; grouping review supports selected accept; the global thumbnail
  action is removed from the sidebar.

## Completed in ADR-0008

- Registry database and library package skeleton.
- Per-library engine/session cache and library-scoped content route migration.
- Clean-break schema collapse: no content `storage_roots` table and no
  `asset_files.storage_root_id`; each `library.db` is scoped by its library root.
- Registry-owned `job_queue` and in-process worker that opens the target
  library DB for scan/probe/thumbnail handlers.
- Per-library portable cache under `.cairndex/cache/{thumbnails,subtitles}/`.
- Optimistic concurrency for frequent metadata edits via `version` + optional
  `If-Match`.
- Eagle import removal; ADR-0004 remains only as superseded history.

## Tests and validation

For the maintenance-readiness sequence (#38–#41), each branch ran the full gates
locally and on GitHub CI (Backend / Frontend / Docker build) before merge:

- backend: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy src`,
  `uv run pytest` (`235 passed` on `main` after #41);
- frontend: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run test`, `npm run build`, and Playwright `npm run test:e2e` (15 specs).

New coverage added by the sequence: `test_jobs.py` (phase/message, path
redaction), `test_devtools_perf.py` (generator + benchmark), `test_search.py`
(FTS coverage/freshness/escaping/API), `test_auth.py` (hashing, session
scoping/expiry, the full lock gate), and e2e flows for the progress bar,
whole-library search, and the passphrase unlock.

## Known issues / environment gaps

- Optional per-library owner passphrase lock (ADR-0010) is implemented: a library
  can require a passphrase (hash in its manifest; set via
  `cairndex.devtools.set_passphrase`), gated by a library-scoped server session
  (opaque HTTP-only cookie). It is a private LAN/Tailscale guardrail, not
  public-internet hardening and not multi-user auth. Branch
  `feat/per-library-passphrase-lock`. Sessions are in-memory (re-lock on restart);
  no rate limiting/lockout.
- Job progress is now observable: scan/probe/thumbnail jobs report a coarse
  phase + message with throttled progress writes, and the sidebar shows a live
  (determinate/indeterminate) progress bar under Update plus redacted error
  text. Branch `feat/job-progress-observability`. Cancellation is wired but has
  no dedicated UI button yet.
- Grouping review can select/deselect proposals but does not yet provide rich
  edit-before-apply controls for merge/split/reclassify/rename.
- Whole-library indexed metadata search (SQLite FTS5) is implemented: the toolbar
  search box queries a per-library `bundle_search` FTS5 index (kept fresh by
  triggers; rebuildable via `cairndex.devtools.reindex_search`) over
  bundle/file/tag/collection metadata, composing with views/collections/filters.
  Branch `feat/indexed-metadata-search`. Ranking is match-only for now (results
  keep the active sort, not a relevance score).
- Browse-summary queries are profiled with synthetic-library + benchmark
  devtools; targeted indexes (`asset_files.bundle_id` + association-table reverse
  indexes) plus a non-correlated membership semijoin take browse/counts/filters
  from seconds to single-digit/low-tens of ms at 5k and keep all paths
  comfortably interactive (browse ~120 ms, filters <150 ms) at 100k bundles (see
  `docs/performance.md`). Branch `perf/large-library-baselines`.
- Same-volume high-confidence moved-file repair is implemented; cross-filesystem
  repair candidates, duplicate/copy handling, and manual repair are future work.
- File View is read-only. Write mode, reveal/open-with-default-app, and desktop
  helper/Tauri integration are deferred.
- Remux/transcode fallback and embedded subtitle extraction are deferred.

## Next recommended tasks

1. Add richer grouping review editing: merge/split/reclassify/rename before
   apply, while preserving the current safe apply/conflict model.
2. Continue File View planning toward guarded write mode and safe desktop-native
   handoff.
3. Consider relevance ranking for text search (results currently keep the active
   sort).
4. Consider hardening the passphrase lock for wider exposure (rate limiting,
   lockout, persistent sessions) if it ever needs to face more than a trusted LAN.

## Unresolved decisions

- Authentication mechanism: shared owner secret vs. per-user accounts.
- Native/desktop host integration design for `open with default app`, reveal in
  file manager, and future File View write mode.
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
