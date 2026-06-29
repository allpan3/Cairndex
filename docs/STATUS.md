# Project status

## Current branch / latest commit

Branch: `feat/remove-and-context-menu`. Latest commit: see `git log -1`.

This branch adds web-UI removal of bundles and collections plus right-click
context menus. The backend already exposed metadata-only `DELETE /bundles/{id}`
and `DELETE /collections/{id}`; the frontend now wires them through a reusable
`ContextMenu` (`apps/web/src/app/ContextMenu.tsx` + `useContextMenu.ts`).
Right-clicking a bundle card/row offers Open, Remove-from-collection (in a
collection view), and Delete (acting on the whole selection when multi-selected);
the collection tree and Smart Collection rows offer Delete / Edit. All deletes
confirm first and never touch files on disk. Covered by `ContextMenu.test.tsx`
(vitest) and a real-browser delete flow in `e2e/library.spec.ts`.

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

PR 36 is the current UI/workflow follow-up: the sidebar exposes one primary
**Update** action, with individual **Scan new files**, **Collect metadata**, and
**Review grouping** actions in the overflow menu. Update waits for scan/grouping
plan generation and ffprobe metadata collection, invalidates affected queries,
and opens grouping review when a scan produced suggestions.

## Current milestone

**Library maintenance and grouping review polish.** The current branch makes the
normal maintenance path match the intended product model:

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
- **Current follow-up — scan grouping review workflow (PR 36).** Scan jobs persist
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

Reported in the PR before this documentation/ops refresh:

- backend: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy src`,
  `uv run pytest` (`210 passed`);
- frontend: `npm run typecheck`, `npm run lint`, `npm run test`,
  `npm run build`.

This refresh updated docs, agent instructions, deployment comments/config, and
the backup helper default/comments. No local test run was performed in this
session; GitHub CI should validate the updated branch.

## Known issues / environment gaps

- No authentication yet; the app is still intended for single-owner/local use.
- Job status is polled and terminal states are surfaced, but long-running scan,
  probe, and thumbnail jobs still need detailed progress bars in the UI.
- Grouping review can select/deselect proposals but does not yet provide rich
  edit-before-apply controls for merge/split/reclassify/rename.
- Server-side text search / SQLite FTS5 is not implemented; toolbar text search
  still filters the loaded client-side window.
- Browse-summary queries need profiling and indexing before assuming large-scale
  performance.
- Same-volume high-confidence moved-file repair is implemented; cross-filesystem
  repair candidates, duplicate/copy handling, and manual repair are future work.
- File View is read-only. Write mode, reveal/open-with-default-app, and desktop
  helper/Tauri integration are deferred.
- Remux/transcode fallback and embedded subtitle extraction are deferred.

## Next recommended tasks

1. Add richer grouping review editing: merge/split/reclassify/rename before
   apply, while preserving the current safe apply/conflict model.
2. Surface detailed job progress for Update/scan/probe/thumbnail jobs.
3. Add server-side text search/FTS and review browse-summary indexes on realistic
   synthetic libraries.
4. Continue File View planning toward guarded write mode and safe desktop-native
   handoff.
5. Decide the first single-owner authentication mechanism before relying on
   remote access.

## Unresolved decisions

- Authentication mechanism: shared owner secret vs. per-user accounts.
- Native/desktop host integration design for `open with default app`, reveal in
  file manager, and future File View write mode.
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
