# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Added

- **Optional per-library owner passphrase lock (ADR-0010).** Each library can
  independently require an owner passphrase — a lightweight private-LAN/Tailscale
  guardrail, **not** public-internet hardening and **not** multi-user auth. Only a
  PBKDF2-HMAC-SHA256 hash is stored, in the library's portable `manifest.json`
  (`auth` block), set/cleared with `python -m cairndex.devtools.set_passphrase`
  (never through a content API, never logged). Unlocking is a server-side session
  bound to an opaque HTTP-only `SameSite=Lax` cookie whose record maps to a set of
  unlocked library ids, each with its own expiry — so unlocking library A never
  unlocks library B, and each protected library is unlocked on its own. New routes
  `GET/POST /libraries/{id}/auth/status|unlock|lock` stay reachable while locked;
  the content gate lives in the one `get_library_session` dependency every
  library-scoped route already uses, returning 401 for a protected library with no
  valid unlock. Wrong passphrases return a generic 401. The registry library list,
  health, static assets, and the auth endpoints remain accessible while locked. In
  the UI, a protected+locked active library shows a passphrase screen (with a
  library switcher) before any content query runs; the sidebar gains a Lock action;
  switching to a different protected library shows its own lock screen. Covered by
  `test_auth.py` (hashing, session scoping/expiry, manifest config, and the full
  API gate incl. A-doesn't-unlock-B, unprotected-C, wrong-passphrase, manual lock)
  and an `e2e/library.spec.ts` unlock flow. OpenAPI + frontend types regenerated;
  `.env.example` and `docs/deployment.md` updated. Sessions are in-memory
  (single-owner, single-process), so a restart re-locks.

- **Whole-library indexed metadata search (SQLite FTS5).** The toolbar search box
  now searches the entire active library — bundle title/note, each file's display
  title, original filename, relative path, source URL and media kind, plus tag
  and collection names — instead of filtering only the loaded/paginated rows. Each
  library DB carries a per-library `bundle_search` FTS5 table kept fresh by SQLite
  triggers over the underlying tables, so every write path (interactive edits,
  scan, moved-file repair, grouping apply, deletion, tag/collection rename) updates
  the index automatically; a `python -m cairndex.devtools.reindex_search` command
  rebuilds it for one library (initial fill / drift recovery). Browse gained a `q`
  parameter (GET and POST `/bundles/browse`) that composes as a non-correlated FTS
  semijoin, so search stacks with the active system view, collection, Smart
  Collection/filter, sort, and pagination. User input is tokenized into safe quoted
  prefix terms, so FTS operators can't cause a syntax error. The frontend debounces
  the search box (250 ms) into the backend query, shows Searching/No-matches states,
  and no longer does client-side window filtering. Covered by `test_search.py`
  (coverage, freshness on edit/delete/tag-rename, filter composition, escaping,
  rebuild, API) and an `e2e/library.spec.ts` flow proving search finds a bundle not
  in the first loaded page. OpenAPI + frontend types regenerated.

- **Job progress & observability.** Background jobs (scan/probe/thumbnail) now
  report a coarse **phase** (`discovering` → `reconciling` → `grouping` →
  `finalizing` for a scan; `probing`/`thumbnailing` for the others) and an
  optional human **message** alongside the existing processed/total counts and
  terminal `result`/`error`. The registry `job_queue` gained nullable `phase`
  and `message` columns (added additively to existing registry DBs — no manual
  migration); `JobRead` exposes both and OpenAPI/frontend types were
  regenerated. The worker's `JobContext` gained `set_phase(...)` (phase changes
  flush immediately) and throttles the hot `checkpoint(...)` registry write to
  at most one commit per 0.5s — so a multi-terabyte scan no longer commits the
  registry once per batch — while still checking cancellation every call and
  always flushing 100%. Handler errors are sanitized before storage
  (`jobs/errors.py`): the exception type is kept but the library root and any
  absolute paths are redacted, so a failed job never leaks private filenames.
  The sidebar renders a live progress bar under **Update** — determinate when a
  total is known, indeterminate otherwise — with the current phase/count, and a
  redacted error line if a maintenance job fails. Covered by backend
  `test_jobs.py` (phase/message, terminal phase clear, path redaction, API
  exposure) and an `e2e/library.spec.ts` flow asserting the bar appears with
  phase and counts during Update.

- **Large-library performance baselines + targeted indexes.** Two devtools under
  `cairndex.devtools`: `synthetic_library` generates a real on-disk library and
  bulk-populates it (batched core inserts; 100k bundles / ~300k files in ~6s, no
  real media touched), and `benchmark_queries` times the hot browse/count/filter
  paths over `--iterations` runs with an optional `--explain` that dumps the
  actual SQLite `EXPLAIN QUERY PLAN`. Profiling a synthetic library showed the
  browse/count/filter paths doing a full `asset_files` scan per bundle (SQLite
  does not auto-index a foreign key) and the sidebar count group-bys falling back
  to a temp B-tree. Three measured indexes were added — `asset_files.bundle_id`
  (the dominant fix), and reverse indexes on `asset_bundle_collections.collection_id`
  and `asset_bundle_tags.tag_id` for the count group-bys — taking browse from
  ~5.4 s to ~12 ms and view-counts from ~12 s to ~14 ms on a 5k-bundle library
  (see `docs/performance.md`). Indexes are defined on the models (new libraries
  get them via `create_all`) and backfilled idempotently into existing library
  DBs on open via `persistence.engine.ensure_content_indexes`, since library DBs
  have no migration chain.

- **Dedicated product brief.** Product mission, fixed decisions, canonical domain
  model, File View direction, grouping behavior, UI direction, future
  compatibility notes, and first-release anti-goals now live in
  `docs/product-brief.md` instead of being embedded in `AGENTS.md`.

- **Right-click context menus + bundle/collection deletion.** Bundle cards and
  list rows now have a right-click menu with **Open**, **Remove from this
  collection** (when browsing inside a collection), and **Delete Bundle**; the
  collection tree and Smart Collection rows have menus for **Delete collection**
  and **Edit/Delete**. Deletion is metadata-only and wired to the existing
  `DELETE /bundles/{id}` and `DELETE /collections/{id}` endpoints — no file on
  disk is ever touched, and every destructive action confirms in a styled dialog
  first. Deleting bundles opens `DeleteBundlesDialog` (acting on the whole
  selection when a multi-selected card is right-clicked) with an **Also delete
  contained files** checkbox; it defaults off and is a forward-looking
  placeholder — filesystem deletion is not enabled in the metadata-only
  milestone, so files are always kept for now. Deleting a collection that has
  subcollections opens `RemoveCollectionDialog` with an **Also delete
  subcollections** checkbox, checked by default; unchecking it floats the
  subcollections to the top level instead. The subcollection choice is backed by
  a new `cascade` query parameter on `DELETE /collections/{id}` (default
  `false`) whose service bulk-deletes the descendant subtree while keeping
  bundles/files. A new reusable `ContextMenu` component (`useContextMenu`)
  renders a cursor-anchored, viewport-clamped menu in a portal that closes on
  outside click / Escape / scroll, and `useDeleteBundles` / `useDeleteCollection`
  refresh the affected browse, count, and tree queries (clearing the view when
  the in-view collection is deleted).

- **External subtitle auto-link across grouping flows (ADR-0009, phase 6).**
  Grouping a video with its sidecar `.srt`/`.vtt` now links them everywhere a
  bundle is formed, not only via the grouping-plan apply: **fast-add** with
  single-bundle grouping runs `auto_link_external_subtitles` and reports
  `subtitles_linked`, so the ADR-0003 data-model claim ("external subtitles
  auto-link to a same-directory video by basename, language/forced parsed from
  the suffix") holds for the scan/grouping and manual-grouping flows alike.

- **Re-scan additions into confirmed bundles (ADR-0009, phase 5).** When a file
  is discovered in a directory already owned by a *confirmed* bundle, the
  suggester now proposes folding it into that bundle (an **addition** proposal,
  `target_bundle_id` set) rather than spawning a fresh one — so a re-scan that
  drops `cosmos.fr.srt` next to a confirmed *Cosmos* bundle suggests "add to
  Cosmos", never disturbing the confirmed grouping. Applying an addition moves
  the file in, assigns a role, links subtitles, removes the emptied provisional
  bundle, and is idempotent + conflict-aware (a file the user moved into a
  different confirmed bundle is left alone). The apply result reports
  `files_added_to_bundles`; the review UI shows additions as "Add to …".

- **Grouping review UI (ADR-0009, phase 4).** A new sidebar **⧉ Group** action
  opens a review modal that suggests a grouping for the active library and shows
  the plan — proposed bundles and the logical containers that would hold them,
  with each file's role, a confidence badge, and a reason — then applies it on
  confirmation (confirming bundles, creating collections, and linking subtitles;
  nothing on disk changes). The apply result reports how many bundles/collections/
  subtitle links were made and surfaces any conflicts (files that moved, vanished,
  or were already grouped by hand). `useGroupingPlans` / `useGroupingPlan` /
  `useGenerateGroupingPlan` / `useApplyGroupingPlan` wrap the ADR-0009 phase-3
  routes; applying invalidates the browse/collection views. (Interactive
  edit-before-apply — merge/split/reclassify/rename — is a follow-up; this lands
  the review + accept-all + apply slice.)

- **Grouping plan apply service + API (ADR-0009, phase 3).** Durable
  `grouping_plans` / `grouping_proposals` / `grouping_proposal_files` tables store
  a reviewable snapshot of the suggester's output (parent links by
  `parent_proposal_id`; proposal files reference `asset_file_id` as a snapshot id,
  not an FK, so a vanished file surfaces as a conflict rather than cascading). New
  library-scoped routes: `POST /grouping/plans` (suggest + persist, superseding
  the prior open plan), `GET /grouping/plans`, `GET /grouping/plans/{id}`, and
  `POST /grouping/plans/{id}/apply`. Apply is the only step that confirms
  groupings: it merges/splits provisional bundles **preserving `AssetFile.id`**
  (so moved-file repair, subtitles, thumbnails, and notes stay stable), assigns
  roles, selects cover/primary, links external subtitles, and creates the logical
  collections a CONTAINER suggests — never touching the filesystem. It is
  idempotent (re-applying a settled plan is a clean no-op) and conflict-aware (a
  proposal whose files vanished or were manually regrouped is reported as a
  localized conflict and skipped, never overriding a confirmed user decision).

- **Read-only grouping suggester (ADR-0009, phase 2).** A pure heuristic
  (`cairndex.grouping`) turns the files observed in a library into a
  `GroupingPlan` of BUNDLE / CONTAINER proposals with per-file roles, ordering,
  a confidence, and a human-readable reason — leading with content signals and
  using names only as a hint. A folder with one video plus sidecars (or a
  multipart video) reads as a **bundle**; a folder of unrelated items or one
  holding sub-bundles reads as a **container** (a logical-collection suggestion,
  never a filesystem move); nested folders recurse. Roles are derived as ADR-0003
  prescribes (primary video, cover = `cover`/`poster`/`thumb…` image else first
  image, external subtitles, sequence by natural order). Files already in a
  *confirmed* bundle are excluded, so confirmed decisions win over heuristics.
  This phase is read-only: a thin DB adapter (`grouping.service`) snapshots the
  current library and returns a plan; persisting and applying it is phase 3.

- **Bundle grouping review state (ADR-0009, phase 1).** `asset_bundles` now
  carries `grouping_state` (`provisional` | `confirmed`), `grouping_source`
  (`legacy` | `scan_suggestion` | `manual` | `fast_add` | `import`),
  `grouping_rule_version`, and `confirmed_at`. The scanner stages newly
  discovered files into `provisional` / `scan_suggestion` bundles awaiting
  review; fast-add and manual creation produce `confirmed` bundles (the user
  already chose the grouping). Bundles created before this change backfill as
  `confirmed` / `legacy` via server defaults. `grouping_state` /
  `grouping_source` are exposed on `BundleRead`. This is schema-and-state only:
  the suggester, apply-plan service, and review UI land in later ADR-0009
  phases, and browse behaviour is unchanged for now.

- **Frontend wiring for optimistic concurrency + per-library maintenance jobs.**
  The bundle inspector and Smart Collection editor now send the entity `version`
  as `If-Match` on edits; a 409 conflict surfaces an inline notice ("changed
  elsewhere — save again to apply over the latest") and the view refetches
  current server state instead of silently overwriting another client's change.
  The sidebar gained a **Library maintenance** row with **Scan** and **Probe**
  (ffprobe technical metadata) actions; each disables while running and refetches
  affected views.

- **Optimistic concurrency for metadata edits (ADR-0008, phase 9).** The
  frequently edited entities (`asset_bundles`, `asset_files`, `tags`,
  `collections`, `smart_folders`, `subtitle_tracks`) now carry a `version`
  integer (starts at 1, bumped on each edit). Single-entity `PATCH` routes —
  bundles, files, tags, collections, and smart collections — accept an optional
  `If-Match: <version>` header: a stale value is rejected with **409**
  (`version_conflict`) before anything is mutated, while omitting the header
  keeps the previous last-write-wins behaviour (back-compatible). `version` is
  exposed on the read models; OpenAPI and frontend types were regenerated.
  Increment is explicit in the service layer (`persistence/concurrency.py`) so
  internal scan/repair writes never risk `StaleDataError` under the single-writer
  model.

### Changed

- **Membership filters use a non-correlated semijoin.** Tag/collection filters
  (and their "include descendants" variants) now compile to
  `AssetBundle.id IN (SELECT bundle_id FROM assoc WHERE member_id IN (…))` — the
  match set computed once via the association-table index — instead of a
  per-bundle correlated `EXISTS`. Applied in both `filters.compiler` (Smart
  Collections / toolbar filters) and `services.browse` (collection browsing);
  semantically identical. Measured (perf/M2): tag-descendant filter ~7.2 s →
  ~0.13 s and collection-descendant ~2.6 s → ~0.07 s at 100k bundles.

- **Agent documentation cleanup.** `AGENTS.md` is now focused on agent execution
  rules: required reading, source-of-truth order, safety constraints, stack and
  dependency rules, API/data-safety rules, performance requirements, gates,
  testing expectations, Git workflow, documentation discipline, and definition of
  done. `CLAUDE.md` now points Claude-based agents to the same source split.

- **Documentation refresh for the current development state.** README,
  `docs/STATUS.md`, architecture, data-model, development, deployment,
  `AGENTS.md`, and `CLAUDE.md` were refreshed to reflect the implemented
  per-library package + registry model, current Update/grouping-review workflow,
  selected-accept semantics, hidden/cache exclusions, removed Eagle importer,
  and absence of global storage-root content APIs.
