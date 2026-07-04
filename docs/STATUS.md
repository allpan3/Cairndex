# Project status

## Latest session: client platform & media experience plans (docs only)

Branch `docs/client-platform-plans` (repo renamed VaultLeaf → Cairndex; this is
the first work in the new repo). Owner-requested detailed technical plans for
three post-first-release initiatives, plus the cross-cutting server foundations
they share:

- `docs/plans/README.md` — strategy overview, reuse map, repo strategy
  (desktop shell in this monorepo at a future `apps/desktop`; Android TV in a
  future separate `cairndex-android` repo), shared server foundations, and the
  recommended phase order (server foundations → web player/viewer → HLS →
  desktop shell → TV → multi-video wall).
- `docs/plans/01-web-media-player-and-viewer.md` — unified media viewer,
  custom headless player (probe enrichment, embedded-subtitle extraction,
  storyboards/trickplay, watch progress, image preview derivatives, playback
  decision endpoint, bounded HLS remux/transcode sessions, hls.js
  integration, zoom/pan image stage), 9 milestone slices.
- `docs/plans/02-android-tv-client.md` — technology study (native
  Kotlin/Compose for TV + Media3 chosen over web/RN/Flutter), repo/module
  layout, device pairing/bearer tokens, 10-foot browse UX, player, and the
  priority **video wall** (1×2/2×2) with decoder-budget policy, 8 milestones.
- `docs/plans/03-macos-desktop-app.md` — Tauri 2 shell hosting `apps/web`,
  platform abstraction seam, manifest-UUID-validated library path mappings,
  reveal/open-with (ADR-0007), drag-out/drag-in, native menus, 5 milestones.
- `docs/adr/0012-client-platform-strategy.md` — **accepted (owner-ratified
  2026-07-04)** after a decision-by-decision review: Tauri 2/WKWebView
  confirmed for macOS (Electron is the recorded fallback), custom headless
  player confirmed with the UX bar set to desktop-native players
  (**Movist/Elmedia/IINA** — Eagle's own player is explicitly *not* the
  playback reference), and a separate `cairndex-android` repo confirmed for
  the TV client. Plan 1 gained the Movist/Elmedia-inspired features (dual
  simultaneous subtitles, subtitle styling, A-B loop, snapshot capture,
  video adjustments, configurable seek step) and a new M9 polish slice.
  Also fixed the stale ADR index (0011 was missing).

Post-ratification owner additions (same day): confirmed seek-bar hover
trickplay is covered (plan 1 §4.2/M4), and requested two non-priority export
features now specced as plan 1 §10 + milestone M11 — **GIF-from-snippet** and
**contact-sheet generation** (metadata header + timestamped frame grid),
server-generated via bounded interactive export tasks, download-only (never
written into the library root), desktop-first with native save/notification
hooks in plan 3 D5, web included, TV excluded.

Owner then prioritized **library write mode** as the next major initiative
after the core player (ahead of desktop/TV), so it is now planned in full:
`docs/plans/04-library-write-mode.md` + **ADR-0013 (accepted — owner-ratified
2026-07-04)**. Design pillars: per-library opt-in gate stored in the
registry (never the portable manifest) + deployment master switch;
trash-first deletion into `.cairndex/trash/` with a `trashed` availability
state so restores are lossless; a `file_operations` journal in `library.db`
(intent-before-action, reconciler on open, Undo); in-app move/rename updates
`relative_path` preserving `AssetFile.id` (no repair needed by construction);
no in-place overwrites — path collisions surface an Eagle/Finder-style
**Replace / Skip / Keep both** prompt (owner requirement) where Replace is
journaled trash-then-write, recoverable until Empty Trash; bulk ops as jobs
on the existing single-worker queue.
Slices W0–W6; W2 closes the exports-into-library open item (save contact
sheet/GIF, link to bundle, set as cover); W5 enables the desktop drag-in
copy. Note: W0 must amend the AGENTS.md/CLAUDE.md "never rename/move/delete"
safety wording to carve out journaled write-mode operations (recorded in
ADR-0013 consequences).

No code changes; no gates run (docs-only). Next recommended task for this
track: plan 1 M1 (probe enrichment). The pre-existing next tasks below still
stand for the core web app.

## Latest merged: collection & bundle ordering UX (#47)

Merged as **#47** (`feat/collection-bundle-ordering`). Six reviewable slices plus
five rounds of review-feedback follow-ups (summarized below):

- **Slice 0 — data model.** New `asset_bundle_collections.sort_order`
  (per-collection bundle order) and `asset_bundles.manual_order` (global bundle
  order), both `server_default 0`, patched into existing library DBs via the
  additive `ensure_content_indexes` bootstrap (no migration chain).
- **Slice 1 — collection ordering.** Collections order by `sort_order` (name
  tie-break) in both the sidebar tree and the main-browser folder cards; native
  drag-reorder in either surface updates both (`PUT …/collections/reorder`).
  `create_collection` appends after siblings. "Clean up by… Title" A–Z/Z–A
  (`POST …/collections/cleanup-order`). Shared `moveBefore()` + `CleanupOrderDialog`.
- **Slice 2 — bundle manual order.** `BundleSort.MANUAL` (membership order inside
  one collection, global `manual_order` elsewhere); Toolbar **Manual** sort +
  drag-reorder in `Browser`; "Clean up by…" over the five toolbar sorts × asc/desc
  (`PUT …/bundles/reorder`, `POST …/bundles/cleanup-order`). Drag is best-effort
  over the loaded window; cleanup is the deterministic full-scope rewrite.
- **Slice 3 — flatten subcollections.** "Show subcollection contents" now also
  flattens every descendant collection into the Subcollections section
  (depth-first, manual order).
- **Slice 4 — folder-card context menu.** Right-click folder cards → Delete
  Collection / Delete N Collections (multi-select); generalized
  `RemoveCollectionDialog` for multi-delete.
- **Slice 5 — decoupled sizing.** Folder cards follow their own smaller curve off
  the shared zoom slider (`collectionCardWidth`, max ~180px by mid-slider); slider
  floor dropped to 80px.
- **Slice 6 — Shift-range select** for bundle cards and folder cards.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` **288
passed** (new: engine ensure-columns in `test_models`, collection reorder/cleanup/
append in `test_taxonomy`, bundle MANUAL ordering + reorder/cleanup in
`test_browse`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build` clean;
Playwright **37 passed** (new `e2e/ordering.spec.ts`). Manually verified against
the local Synthetic Library via the browser preview (decoupled sizing, Manual sort
+ Clean up button, flatten → 165 descendants, folder Delete-Collection menu,
Shift-range select) plus a reversible live `collections/reorder` round-trip
(swapped then restored the root order). OpenAPI + `schema.d.ts` regenerated.

Out of scope / known limitation: bundle drag-reorder only rewrites the loaded
window (use "Clean up by…" for a full deterministic order); reparenting collections
by drag is not a gesture here (drag reorders within a sibling group only).

**Follow-up refinements (same branch, review feedback):** bigger folder
thumbnails (cap ~2/3 of the slider — see `collectionCardWidth` in
`apps/web/src/app/layout.ts`); "Clean up…" moved out of an inline button into the
folder-section / empty-grid right-click menus and the sidebar Collections heading;
foldable **Collections**/**Smart Collections** sidebar sections (hover caret +
highlighted label); the **Show subcollection contents** toggle now also appears in
the All view; drag-reorder reworked to **gap insertion** with an accent
insertion-line (replacing the edge highlight) across the bundle grid, folder
cards, and sidebar; **Manual** is now the first/default sort (persisted prefs
remember any later choice); a new **sort-control popover** (`SortControl.tsx`) with
sort field, asc/desc, and a **per-collection** scope checkbox (each
collection/view remembers its own sort); card text no longer highlights during
multi-select; double-click-to-open / single-click-metadata confirmed. New
`cairndex.sidebar.*` + expanded `cairndex.prefs` (sortScope/collectionSorts)
persisted keys; `e2e/ordering.spec.ts` updated (6 specs). All gates green;
Playwright 39 passed.

**Second follow-up round (review feedback):** chevron fold icons (bigger on the
sidebar section headings); the **All tab** now shows top-level collections +
*uncategorized* bundles by default and flattens to everything with the toggle
(there is no global manual order — reorder/"Clean up…" are disabled and greyed
when flattened); **cross-surface drag** to reparent collections (center = into,
edge = reorder) and move bundles into a collection (Alt = add without removing),
in both the sidebar and the main browser (`app/dnd.ts` `DragItem`/`dropZone`,
App-level `dragItem`, `PATCH …/collections/{id}` `parent_id` reparent, batch
add/remove for bundle moves); bundle-album file selection (click/drag/Shift, the
inspector keeps the bundle) + **"Locate in File Browser"**; drag-select on **list
rows** (bundle + file views) and Shift-range file selection. All frontend gates
green; Playwright 39 passed. Verified in the browser against the Synthetic Library
(incl. a reversible live reparent + move round-trip).

**Third follow-up round (review feedback):**

- Fold arrows reverted to a **solid disclosure triangle** (slightly larger, kept
  narrow) — `IconChevron` in `app/icons.tsx`, `.chevron`/`.chevron--lg` sizes.
- **Collection drag-reorder reliability:** the drop zone is recomputed from the
  cursor at drop time (a stale hover slot no longer turns a reorder into a
  reparent); cross-parent edge drops reparent+reorder (`moveCollection` in
  `App.tsx` = `PATCH parent_id` then `collections/reorder`), so a subcollection
  can be dropped out to the **top level**; a `CollectionListEnd` drop zone below
  the last sidebar row catches drags "behind the last collection".
- **Alt/Option bundle drag** fixed on macOS (drag advertises `copyMove` +
  reflects copy/move cursor) so add-to-collection-without-removing works.
- **Stuck "drop into" highlight** fixed by gating folder-card / sidebar-row drop
  feedback on the live `dragItem` (a bundle drag begins in the Browser and never
  fires those surfaces' `onDragEnd`).
- **File Browser directories** now join drag-select + Shift-range select like
  files (bundling targets still filter to files).
- **"Review grouping" → "Suggest grouping" (ADR-0011):** the manual action now
  re-proposes grouping for every **uncategorized** bundle (incl. confirmed ones
  whose collections were removed) + unbundled files; **Update**/scan keeps the
  narrower `new` scope. Suggestion scope added to `grouping/service.py`
  `gather_observations(scope=…)` + `plan_store.generate_plan(scope=…)`; the
  manual `POST …/grouping/plans` selects `uncategorized`. Internal
  provisional/confirmed state kept (apply still protects confirmed bundles); the
  user-facing **"Needs review" badge removed**.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 291 passed** (new
`tests/test_grouping_scope.py`). Frontend `lint`/`format`/`typecheck`/`vitest`/
`build` clean. Browser-verified the triangle icon and the "Suggest grouping"
rename / removed review badge against the Synthetic Library; native DnD and the
File Browser weren't exercisable there (synthetic files aren't on disk), and the
manual suggest pass is too heavy to run live over 33k uncategorized bundles —
covered by unit/service tests instead.

**Fourth follow-up round (review feedback):**

- Fold caret made **much narrower** (`.chevron` 9×13, `--lg` 11×15;
  `.collection-row__toggle` 12px) so it barely widens a row.
- **All tab reverted** to "every top-level collection + every bundle flattened";
  the "Show subcollection contents" toggle is gone from the All view (kept inside
  a collection), and bundle reorder / Clean Up are disabled there (`isAllView`
  gating in `App.tsx`; `browseView` no longer special-cases `uncategorized`).
- **Reorder past the content edge** now lands at the beginning/end via
  container-level drop handlers (`Browser` root, `CollectionHeader` `.collhead`),
  plus the existing sidebar `CollectionListEnd`.
- **Drag hint** pinned lower-left (`.drag-hint`, driven by App `dragItem`): plain
  = move, ⌥ Option = copy (bundles).
- **File Browser list drag-select** no longer draws a rubber-band box (row
  highlight only in list; box kept in grid) — `Browser`/`FileView` gate the
  `.marquee` on non-list / grid layout.
- **File Browser "Date Added"** column + sort: `created_at` added to
  `services/file_view.FileViewEntry` (+ schema, OpenAPI/client regenerated) from
  `st_birthtime`/`st_ctime`; FileView shows a column and a sort option. New
  `test_file_view` assertion.
- **Sidebar order:** Unbundled moved above Missing Files (`SYSTEM_VIEWS`); All
  Tags moved to the bottom of the system section.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 292 passed**; frontend
gates clean, **Playwright 39 passed** (updated the empty-space Clean Up spec to
enter a collection first). Browser-verified the narrow caret, the All-tab counts
(313 top-level collections + 100k bundles, no toggle), the sidebar order, the
lower-left drag hint, and the File Browser "Date Added" sort option against the
Synthetic Library. The reorder-past-edge and list drag-select (real files) rest
on the gates + code review (native DnD / on-disk files aren't exercisable in the
Synthetic Library).

**Fifth follow-up round (review feedback):**

- **Sidebar collection tree redesign:** compact rows (`.collection-row` gap 3 /
  4px inset), and hierarchy guide rails via a rebuilt shared `PickGuides`
  (ancestor `trail: boolean[]` + `isLast` → per-level vertical rule + elbow that
  bends into the last child). Threaded `trail`/`isLast` through `CollectionBranch`.
  `.pick-guide` CSS now centres the line and draws the elbow; `--guide-bleed`
  joins rails across rows. Same guides shared by the tag/collection pickers.
- Distinct icons (`icons.tsx`): `IconFolderQuestion` (Uncategorized),
  `IconTagQuestion` (Untagged); All Tags keeps the plain tag.
- File inspector: **Date Added** + **Date Modified** (renamed) with time
  (`formatDateTime`). Removed the **"openable"** list badge (updated two e2e
  specs to assert its absence). Restored the list-view marquee box (the prior
  removal was wrong). Terser drag hint.
- **Edge-drop:** the sidebar end-of-list drop zone expands to 72px min-height
  while a collection drag is live.

Verified: frontend `lint`/`format`/`typecheck`/`vitest`/`build` clean,
**Playwright 39 passed**. Browser-verified the compact tree + guide rails
(elbow/last-bend via classes; line aligns to the parent caret, matching Eagle),
the distinct Uncategorized/Untagged/All-Tags icons, and the drag hint text
against the Synthetic Library. No backend changes this round.

## Previously merged: ad-hoc filters + tag management (#46)

Eagle-like ad-hoc filtering + tag management, merged as **#46**
(`feat/adhoc-filters-tag-mgmt`), in three reviewable slices on top of `main`
(which already included the collection-view GUI rework, #45).

- **Slice 1 — ad-hoc Tags filter.** A funnel button in the bundle toolbar reveals
  a filter row with a **Tags** chip. Its popover has an Any/All/Equal rule + a
  subtags toggle, tag-group tabs (display-only scoping), search, and a tag tree:
  left-click includes, right-click excludes (mutually exclusive; browser context
  menu suppressed). Counts are **faceted** — a new
  `POST /filters/facets` endpoint returns tag/rating counts scoped to the current
  browse context and the *other* active categories (never global static counts),
  with parent-tag counts rolled up as distinct-bundle counts in Any/All or direct
  in Equal. `apply_scope()` was extracted in `services/browse.py` so the grid,
  its counts, and facets scope identically. Tag Equal/direct needs no new AST —
  it maps to `contains_any` with `include_descendants=false`.
- **Slice 2 — Rating filter.** A rating-specific `is_null` compiler operator
  (Unrated). Toolbar Rating chip = star row + `=`/`≥`/`≤` + an Unrated row; the
  Smart Collection editor's rating row uses the same star picker and an "is
  unrated" operator, so saved collections round-trip it.
- **Slice 3 — All Tags page.** A sidebar entry (below Untagged) opens a
  management surface (`mode='tags'`): left panel (All / Uncategorized / groups,
  each with a tag count) + an Eagle-style, pinyin-segmented, multi-column
  **accordion grid** of top-level tags that expand in place to reveal children
  (folded = rolled-up subtree count, expanded = direct). **Drag reparents** a tag
  (onto another = nest; onto empty space = top level); the tree is name/pinyin
  ordered, so manual sibling ordering was dropped (the `PUT /tags/reorder` and
  `PUT /tag-groups/{id}/tags/order` endpoints were removed). Backend safe tag
  delete blocks a
  parent with children. Double-clicking a tag applies a global Equal/direct
  filter. (Initial cut was a single-column drag-reorder tree; reworked per review
  into the accordion grid with reparent-by-drag.)

Both toolbar filters and Smart Collections compile to the one canonical
FilterExpression AST and stack under AND with the view/collection and text search.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` green
(new `test_facets.py`; rating/tag/reorder cases in `test_filters.py`/
`test_taxonomy.py`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build`
clean; Playwright green (new `e2e/filters.spec.ts`, `e2e/all-tags.spec.ts`, plus
the Smart Collection unrated round-trip). Manually exercised against the local
Demo Vault (Tags include/exclude, Rating stars + Unrated=22, All Tags page,
double-click→global Equal filter) — all metadata-only, no demo data mutated.

Out of scope (explicit follow-ups): Types filter, Collections toolbar filter,
Starred tags, exact tag-set equality, URL/localStorage persistence of ad-hoc
filters.

## Earlier: `feat/collection-view` (merged, #45)

GUI-only work. Treat this section as the collection/browse UI history; the rest
of this doc is backend/maintenance history.

Latest session's changes (frontend-only, no backend files touched):

- **Subcollection cards get the same left-click marquee drag-select as the
  bundle grid** (`useMarqueeSelect`, scoped to `.collcard__grid`/`.collhead`
  so a drag there can't also pick up bundle cards), plus click-on-empty-space
  deselects. Subcollection selection (`selectedCollectionIds: Set<string>`)
  and bundle selection (`selectedIds`) are mutually exclusive — selecting one
  clears the other.
- **The "All" view now shows root-level collections as cards** above the
  bundle grid, via the same `CollectionHeader` component used inside a
  collection (generalized with a `sectionLabel` prop: "Collections" at the
  root, "Subcollections" inside a collection).
- Folder cards got a **stacked-sheet visual** (offset box-shadow "sheets")
  and their footer shows **both** the direct bundle count and the
  subcollection count.
- **Collection and bundle titles commit on Enter**, not just blur.
- Fixed: bundle cards showed a duration badge on image bundles when the
  primary file's metadata had a stray `duration` — now gated on `media_kind
  === 'video'`.
- **Removed the top "batch bar"** (`BatchBar.tsx`, deleted) for 2+ selected
  bundles. Replaced with a right-panel `MultiBundleInspector`: title
  overwrites all, rating shows the common value (or unset) and overwrites all,
  tags/collections common to every selected bundle show as assigned and
  toggling adds/removes across the whole selection (via the existing
  `POST /bundles/batch` endpoint — no backend change needed), size/files are
  summed. No note field (bulk-overwriting prose doesn't make sense). New
  hooks: `useCommonBundleTags`, `useCommonBundleCollections`,
  `useBulkUpdateBundles` (parallel PATCH per id, no `If-Match` — a bulk
  overwrite is an explicit one-shot action and per-row versions aren't loaded
  in the browse grid).
- Right-click context menu items are now consistently Title Case.

Verified: frontend `lint`/`format:check`/`typecheck`/`vitest` (9)/`build`
clean; Playwright **24/24** passed (added a subcollection-marquee test and
rewrote the multi-select test for the new right-panel editor). Manually
exercised in the browser preview (marquee + deselect on both bundles and
subcollections, Enter-commit on both title fields, bulk rename/rating/
tag-picker/collection-picker on a real 2-bundle selection against the local
demo library, then reverted those demo-data edits via direct API calls so the
demo library is unchanged for review).

**Follow-up fixes session (same day):**

- **Fixed a marquee-drag runaway-scroll bug.** The drag-selection overlay was
  sized from raw, unclamped mouse coordinates; dragging past the loaded
  content inflated the container's scrollable area (since the overlay is an
  absolutely-positioned child of an `overflow: auto` container), and because
  that gave auto-scroll more room to advance — which let the overlay grow
  further — the two fed each other every animation frame. A ~400px drag
  paused near the bottom edge for ~1s inflated one container's scrollable
  height from 232px to 14,198px, confirmed via direct DOM measurement before
  and after the fix. Fixed in `useMarqueeSelect.ts` by clamping every
  content-space point to the wrapper's true `scrollWidth`/`scrollHeight`,
  measured once at drag start (before the overlay exists) — applies to both
  the bundle grid and the collection cards (shared hook). No dedicated
  automated test added (hard to assert scrollHeight growth reliably in
  Playwright); verified via direct `scrollHeight` measurement in the browser
  preview before/after, with mouseup/mousemove sequences reproducing the
  original bug.
- **"Create '<search>'" in the tag/collection pickers.** Typing a search (in
  the single-bundle TagEditor/CollectionPicker, and the multi-bundle bulk
  editor's pickers) shows a "+ Create "…"" row whenever the search doesn't
  already name an existing tag/collection *exactly* — including when it's a
  substring of one (searching "Act" while "Action" exists still offers to
  create "Act", alongside the "Action" partial match; first cut only showed
  it when there were zero matches at all, corrected same-day per feedback).
  Clicking it creates a top-level tag/collection and assigns it immediately.
  New `POST /tags` client call + `useCreateTag` hook (the endpoint already
  existed; only the frontend was missing). e2e-covered (both single-bundle
  pickers, incl. the partial-match case); the multi-bundle picker's create
  path shares the same `BulkPicker` component and is exercised the same way
  manually.
- Empty-inspector placeholder now says "Select a bundle or collection…".
- Confirmed (not a bug): a collection with only subcollections and no direct
  bundles already resolves its cover correctly from anywhere in its subtree
  (`resolve_cover_bundle_id` walks the full recursive descendant set, not
  just direct children) — covered by
  `test_collection_cover_prefers_chosen_bundle_then_auto_picks`.

Verified: frontend gate green again (lint/format/typecheck/vitest 9/build);
Playwright **27/27** (3 create-tag/create-collection tests, incl. the
partial-match case). Manually verified the runaway-scroll fix and all create
flows (incl. partial-match) in the browser preview against the real demo
library, then reverted the demo-data mutations (2 created tags + 1 created
collection, across both rounds) via direct API `DELETE` calls.

Not yet a PR — branch also carries the prior collection-view slices (picker
redesign, empty-collection sidebar fix, collection inspector, cover cards)
from earlier sessions.

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

**Unbundled staging + manual bundling assistant (branch
`feat/manual-bundling`).** Scan-staged provisional bundles are now surfaced only
in a dedicated **Unbundled** view (hidden from All/Recent/Collections), and a new
`cairndex.manual_bundling` service + `/manual-bundling/*` API + web dialogs let
the owner turn unbundled files into confirmed bundles by hand with automatic,
never-auto-applied suggestions. All metadata-only; see the notes below and
`CHANGELOG.md`. Two follow-up fixes on top: removing a file from a bundle (the
inspector ×) now re-stages it back into **Unbundled** instead of unlinking it
(shared `_restage_file` helper with `delete_bundle`), and a changed cover now
shows without a manual refresh via a `cover_key` cache-buster on browse summaries
and the inspector thumbnail URL. Backend `uv run ruff check/format --check/mypy`
clean, `pytest` 265 passed; frontend typecheck/lint/format/test/build clean and
Playwright 17 specs pass (incl. `e2e/manual-bundling.spec.ts`). Not yet merged.

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
- **Unbundled staging (file-first):** scan-created provisional bundles
  (`grouping_state = provisional`, `grouping_source = scan_suggestion`) are treated
  as *unbundled files* and hidden from All/Recent/Uncategorized/Untagged/Missing
  and every collection (browse keeps a `view=unbundled` + count for the hiding
  logic). The two top-left tabs are **Bundles** (renamed from Collections) and
  **Files**; the sidebar **Unbundled** view opens the **Files** surface as a flat,
  cross-library list of not-yet-bundled files (`GET /manual-bundling/unbundled-files`)
  with the file inspector. File View entries carry a derived `unbundled` flag and
  badge each path `unlinked` / `unbundled` / (openable).
- **Manual bundling assistant:** `cairndex.manual_bundling` confirms unbundled
  files by hand — add to an existing confirmed bundle, create a bundle from
  selected files, create an empty bundle, or add suggested files from a bundle’s
  inspector — reachable by right-clicking files in either Files surface.
  Suggestions (target bundles / unbundled files / a bundle draft) are automatic on
  dialog open, ranked with a confidence + reason, and computed only from the DB +
  FTS index; applying is always explicit and metadata-only (files re-parented,
  emptied provisional bundles reaped, subtitles auto-linked). Apply/suggest accept
  `relative_paths` as well as `file_ids`; an unlinked File-View path is staged as
  provisional at apply, and a path in a confirmed bundle is rejected. Shared
  membership logic lives in `grouping/membership.py`.
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

For `feat/manual-bundling` (not yet merged): backend `pytest` is `253 passed`
locally with all static gates clean; frontend gates clean and Playwright is 17
specs. New coverage: `test_browse.py` (Unbundled view/counts + hiding from normal
views/collections), `test_manual_bundling.py` (all mutations, role/cover/primary
assignment, subtitle auto-link after add, confirmed bundles undisturbed, unbundled
source guard, metadata-only invariance, suggestion ranking),
`test_manual_bundling_api.py` (end-to-end over a real scan through the API), and
`e2e/manual-bundling.spec.ts` (Unbundled view + create-from-files + add-to-bundle
dialogs).

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
   handoff. *(Planning now done: `docs/plans/04-library-write-mode.md` +
   proposed ADR-0013; desktop handoff in `docs/plans/03-macos-desktop-app.md`.)*
3. Consider relevance ranking for text search (results currently keep the active
   sort).
4. Consider hardening the passphrase lock for wider exposure (rate limiting,
   lockout, persistent sessions) if it ever needs to face more than a trusted LAN.
5. File View toolbar/search follow-ups (the toolbar now mirrors the bundle
   browser — breadcrumb + count + search + sort + layout + zoom; single-click
   selects and drives the inspector, double-click navigates/opens):
   - File search is currently a **client-side name filter of the loaded
     listing**. Add whole-library/recursive file search (file titles are
     already in the `bundle_search` FTS index, but that returns bundles, not
     File-View entries — needs a file-entry-shaped search path).
   - Enrich File-View metadata in the inspector: for a **directory**, show its
     child count (needs the backend `list_entries`/entry schema to carry a
     `child_count`). (A collection's note is already editable — see the
     collection inspector, `feat/collection-view`.)

## Unresolved decisions

- Authentication mechanism: shared owner secret vs. per-user accounts.
- Native/desktop host integration design for `open with default app`, reveal in
  file manager, and future File View write mode.
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
