# ADR-0009: Suggestion-based bundle grouping (Option A+)

- Status: **accepted**, amended 2026-08-09; primary-file selection provisions
  superseded by ADR-0016
- Date: 2026-06-29
- Branch/PR: `docs/adr-0009-bundle-grouping`

> ADR-0016 replaces this ADR's selected-primary-file behavior with ordered media
> plus one bundle cursor. The grouping/suggestion decision remains accepted.

## Context

Today the scanner creates **one bundle per file**, by design — it has no
grouping step (the heuristics sketched in `AGENTS.md` §7 were never
implemented; `scanning/fast_add.py` only offers "per file" or "all selected
files into one bundle"). Scanning a realistic library therefore over-fragments:
a movie folder of `cosmos.mp4` + `poster.jpg` + `cosmos.en.srt` becomes **three**
bundles instead of one, and the external subtitle never attaches to its video.

The owner's intent (the discussion that produced this ADR):

1. **Grouping is a *suggestion*, not an automatic decision.** Scan proposes how
   to bundle; the user reviews and ultimately decides. Nothing is silently
   merged or split.
2. **"Is this folder a bundle?" is itself a guess** — from the folder/stem name
   *and* its contents. `Cosmos/` (with its subfolders) → likely a bundle;
   `Photos/` → likely *not* (it is a container of separate items). Both
   guessable, both overridable.
3. **Conceptually, a bundle ≈ a hidden "sub-collection"**: a leaf grouping that
   carries cover/rating/note metadata and does not appear in the collections
   tree.

Current model (ADR-0002, ADR-0008): `AssetFile.bundle_id` ties each file to
exactly one `AssetBundle`; `AssetBundle` carries `title`, `rating`, `note`,
`cover_file_id`, `primary_file_id`; `Collection` is a hierarchical grouping of
**bundles** (M:N), independent of the physical File Browser. Bundles are already
hidden leaves — they never appear in the collection tree. So insight (3) partly
describes today's behavior; what is new is unifying the *mental model* without
unifying the schema yet.

`AGENTS.md` constraints that apply: metadata-only / non-destructive (§2/§3 — no
file moves); one source of truth (§2.7); Eagle-inspired, reviewable, never
auto-merge destructively (the old §7 spirit); scale by design (§2.10 — no full
scans/hashes on the request path, ADR-0006); collections are the product term and
contain bundles, not loose files (§3); bundles remain flexible logical objects
and do not require a canonical physical folder (§3).

## Decision

Adopt **Option A+**:

1. Keep `AssetBundle` and `Collection` as separate tables.
2. Treat "bundle is a hidden sub-collection" as a **UX and mental model**, not a
   schema unification.
3. Add an explicit **provisional grouping + durable grouping-plan** workflow so
   scanning can discover files and propose grouping without silently making final
   user-owned decisions.

This means `AssetFile.bundle_id` remains non-null. Under Option A+, "scan stays
discovery-only" means scan does not create **confirmed** grouping decisions; it
may still create/update `AssetFile` rows and provisional `AssetBundle` rows as
metadata carriers for playback, probing, File Browser linkage, and moved-file
repair.

Concretely:

1. **Scan stays non-destructive and repair-first.** A scan links/repairs files,
   tracks availability, and preserves existing confirmed bundle membership
   exactly as today (ADR-0006). It never moves, renames, deletes, or rewrites
   source files.
2. **New scan-created grouping is provisional.** Newly discovered files are
   represented by `AssetFile` rows inside provisional `AssetBundle` rows until
   the user confirms or edits the grouping plan. A provisional single-file bundle
   is a staging object, not a final product decision.
3. **A grouping suggester produces a durable plan**, separate from scan and
   separate from apply. For each relevant directory/subtree it proposes either
   **BUNDLE** or **CONTAINER**, plus file roles, ordering, confidence, and a
   human-readable reason.
4. **The user reviews and applies the plan.** A review surface shows proposed
   bundles/containers with bundle selection, merge, split, reclassify
   (bundle ↔ container), rename, and explicit collection placement. Collection
   rows are structural paths and tri-state bulk selectors, not independently
   accepted work. A placement picker offers only the library's currently
   persisted collections; speculative collection proposals remain rearrangeable
   by drag-and-drop but are not presented as settled destinations. Applying the
   plan is the only step that creates confirmed grouping decisions: confirming
   bundles, assigning roles, creating logical collections/memberships, and
   linking subtitles.
5. **User decisions are durable and win over heuristics on re-scan.** A confirmed
   bundle is never silently re-split or merged. Existing confirmed membership
   remains the source of truth; new files appearing later are suggested into
   existing bundles/containers and not auto-applied. As amended on 2026-07-14,
   the owner may convert that addition proposal in place into a separate new
   bundle, then switch back while the confirmed target still exists. The target
   remains untouched when new-bundle mode is applied. Relevant existing
   collection branches remain reviewable context: an addition defaults to its
   target's collection, and a fresh proposal may reuse a matching collection
   path, without reopening any confirmed bundle as a grouping candidate. As
   amended on 2026-08-09, existing collection context carries stable collection
   identity and is read-only; selecting a nested bundle resolves its complete
   ancestor path even when no collection checkbox was directly selected.
   Choosing a persisted destination resolves its current ancestor path at edit
   time, so the plan records the same committed hierarchy the picker displayed.
6. **Role assignment within a bundle** is derived during proposal/apply: primary
   = the single video or dominant media; cover = an image named
   `cover`/`poster`/`thumbnail`/`thumb`, else the first image; external
   `.srt`/`.vtt` become subtitle tracks linked to the current video
   (language/forced parsed from the suffix, per ADR-0003). As amended on
   2026-07-14, the default `sequence` ranks video, then audio, then image, then
   remaining files, preserving numeric/name order within each group; grouping
   review can persist an exact override before apply.
7. **Explicit review edits are owner decisions.** As amended on 2026-07-14,
   dragging a file within or across bundle proposals, reparenting a bundle into
   a suggested collection, or renaming a proposal marks the affected proposal as
   owner-edited. Apply may therefore revise eligible provisional membership
   while preserving each snapshotted `base_bundle_id` and every `AssetFile.id`.
   This does not make a confirmed uncategorized bundle eligible for regrouping:
   confirmed bundles remain settled regardless of collection membership, and an
   untouched suggestion still cannot silently split, merge, or retitle one.
   As amended on 2026-08-09, new collection proposals may also be reparented,
   with cycle rejection. Existing collection context cannot be renamed, moved,
   or reclassified because it describes a stable destination rather than new
   work.

   Further amended on 2026-08-09, after review found the owner-edited flag being
   read more broadly than it is set. "Owner-edited" now names two distinct
   things, because only one of them may override a confirmed decision:

   - `owner_edited` still marks any explicit edit — rename, destination switch,
     placement — and still lets apply revise *provisional* membership.
   - `membership_edited` marks only a change to **which files** a proposal
     holds, and is the sole licence to move a file out of an already-confirmed
     bundle. Without the split, choosing where a suggestion is filed silently
     unlocked a confirmed bundle, contradicting §5 above.

   Read-only-ness is likewise its own fact rather than an inference. A folder
   suggestion whose title path matches a persisted collection resolves to that
   collection — which is how re-scanning an applied folder avoids duplicating
   it — but it remains the owner's row to rename, move, and reclassify. Only a
   node synthesized to stand in for a live collection is immutable, and only
   such a node is prunable when it stops leading to proposed work.

   An addition has no placement of its own. Its files join a bundle that already
   exists and already has whatever collection membership it has, and that
   membership is append-only, so "placing" an addition could only ever add the
   confirmed bundle to a second collection. Switching the row to a new bundle
   first makes placement meaningful, and permitted.

## Provisional bundle model

Option A+ avoids nullable `AssetFile.bundle_id` and avoids making ungrouped files
a special case throughout browsing, playback, subtitles, thumbnails, smart
collections, and moved-file repair.

Implementation should add small, explicit grouping-state metadata to bundles,
for example:

```text
asset_bundles.grouping_state = provisional | confirmed
asset_bundles.grouping_source = scan_suggestion | manual | fast_add | import
asset_bundles.grouping_rule_version
asset_bundles.confirmed_at
```

Exact column names may change during implementation, but the invariant is fixed:

- every `AssetFile` belongs to an `AssetBundle`;
- scan-created bundles are provisional unless the user explicitly confirms them;
- manually created / fast-add bundles may be confirmed immediately because the
  user already made the grouping decision;
- Bundle Browser may hide provisional bundles by default or show them under a
  clear **Needs Review** system view, but it must not silently present a
  provisional grouping as a final confirmed asset.

## Grouping plan model

The plan should be durable, reviewable, and apply by **stable file IDs**, not only
by paths. Paths are display/context fields; `AssetFile.id` is the durable target
that survives moved-file repair.

A minimal implementation shape:

```text
grouping_plans
- id
- scan_job_id
- status: open | applied | superseded | cancelled
- heuristic_version
- generated_at

grouping_proposals
- id
- plan_id
- proposal_kind: bundle | container
- proposed_title
- proposed_parent_collection_id
- target_collection_id (for stable existing collection context)
- confidence
- reason
- payload_json

grouping_proposal_files
- proposal_id
- asset_file_id
- proposed_role
- sequence
```

The exact schema can be refined in the implementation PR, but these semantics
must hold:

- a plan is a snapshot of suggestions, not a live path-sync rule;
- applying an old/stale plan must detect conflicts when a target file has moved,
  disappeared, been manually regrouped, or no longer matches the proposal;
- conflicts should be localized to the affected proposal where possible, not
  force the whole scan result to be discarded;
- selected acceptance applies file-backed bundle work and resolves only its
  required structural collection ancestors;
- existing collection context resolves by stable id and conflicts if the target
  disappeared or moved, rather than falling back to a same-name collection;
- regenerating suggestions should not overwrite confirmed user decisions.

## Folder classification heuristic (BUNDLE vs CONTAINER)

Content signals are more reliable than names, so lead with content and use the
name as a secondary hint. All outputs are suggestions with a shown reason, so
fuzzy guesses are acceptable.

Lean **BUNDLE** when a folder has a single clear "subject":

- exactly one video plus only sidecars (images, subtitles, attachments), or
- most media share a common stem (the folder/stem name), or
- a small media count with cover/poster/thumb + part-numbered files.

Lean **CONTAINER** when:

- many media files with distinct, unrelated stems (e.g. a photo dump), or
- it holds subfolders that are themselves bundles, or
- the name matches a category-ish hint (configurable; secondary to content).

As amended on 2026-07-14, a flat directory with multiple videos pairs sidecars
by a unique normalized full filename stem first, including full-stem suffixes
such as language subtitles or `-poster`. Only then does it fall back to a unique
leading subject prefix. This avoids treating long filenames that share an
author/source prefix as ambiguous while preserving one-file proposals for
image-only folders.

As amended on 2026-07-20, fresh files in a confirmed bundle's directory are
partitioned into filename-stem candidates **before** any existing bundle is
selected. Each candidate independently targets a unique matching confirmed
bundle; the directory alone is only a fallback for one candidate/one owner or a
sidecar-only arrival. A lone confirmed bundle therefore cannot absorb several
unrelated new video stems. The balanced matcher folds conservative trailing
rendition markers such as `720p`, `1080p`, or `4K`, so a new rendition can still
target the otherwise-identical confirmed bundle and retain the reversible
existing/new destination choice.

Grouping plans also carry a bounded per-directory map of **stem levels**: how
much of each filename has to match for two files to join one bundle, as a dial
rather than named stops. At level `L` every name in a folder is compared on its
first `max - L + 1` segments, where `max` is the longest name there — so level 1
compares whole (rendition-folded) stems and is the default, and level `max`
compares first segments alone. Level 0 is the one rung outside that scheme: the
complete stem with its rendition tag intact, since folding `4K [tag]` versus
`720p` is not expressible as a segment count.

The dial is deliberately absolute rather than "drop `L - 1` segments from each
name": under a relative reading, two names of different segment counts produce
keys of different lengths, which can never be equal, so nothing merges at all
until the top rung collapses the whole folder at once.

Narrow and Widen re-suggest one directory inside the open plan (see
`data-model.md`); a full regeneration creates a new plan snapshot under the
normal supersession rules. Neither ever mutates files or confirmed bundles.

This replaced a three-value `narrow` / `balanced` / `wide` enum whose stops were
not points on one scale — `balanced` folded a rendition tag while `wide` switched
to an entirely different key, so "one step wider" meant two unrelated things and
could split as easily as merge. Level 1 reproduces the old `balanced` exactly, so
an existing library regroups nothing on upgrade.

Nested folders recurse: a CONTAINER's children are classified independently, so
`Movies/` (container) can hold `Cosmos/` and `Waves/` (bundles).

## CONTAINER semantics: collection suggestion, not path synchronization

A directory classified as **CONTAINER** may suggest creation of logical
collections and bundle memberships as an import-time/review-time snapshot. It
does **not** create an ongoing rule that the physical directory and logical
collection stay synchronized.

This distinction is required by the product model:

- File Browser is the filesystem browser.
- Bundle Browser is logical and bundle-first.
- Collection membership never implies a filesystem move.
- Moving files externally must not break collections or bundles.

Therefore, if a new file later appears in a directory that previously suggested a
collection, re-scan should create a new suggestion (for example, "add this file
or bundle to collection Movies?") rather than silently changing a confirmed
collection.

## Re-scan idempotency

- Already-linked files keep their bundle. Membership is the durable record of a
  past decision.
- Moved-file repair (ADR-0006) runs before suggestion and updates existing
  `AssetFile` rows in place when confidence is high.
- Confirmed bundles are never silently split, merged, or retitled by heuristics.
- Genuinely new files are run through the suggester and surfaced as additions
  (for example, "add `cosmos.fr.srt` to bundle **Cosmos**?") — never auto-applied
  to a confirmed bundle. Review may instead create a separate bundle from that
  same proposal; the confirmed target remains the reversible default.
- Ambiguous moves/copies remain unresolved suggestions rather than automatic
  merges.

## Apply-plan invariants

The apply service/API must enforce at least these invariants:

- Cover references must point to files in the same bundle.
- Media sequence is deterministic; current playback location is governed by
  ADR-0016 rather than a grouping-selected primary file.
- External subtitle tracks must point to an external subtitle `AssetFile` and,
  once linked, to a video `AssetFile` in the same bundle.
- Splitting or merging provisional bundles must preserve `AssetFile.id` values so
  moved-file repair, subtitles, thumbnails, notes, and future generated cache
  identity remain stable.
- Applying a plan never mutates the physical filesystem.

## Deferred option: unify bundle and collection schema

A future ADR may revisit full schema unification where a bundle is a hidden
`Collection(kind = bundle)`. That option is deliberately deferred.

It is attractive long term because bundle/container reclassification could become
a flag flip and the app would have one grouping primitive. But today it is not
just a table cleanup; it changes the core product boundary between the
user-facing asset card and the logical collection hierarchy. It would require a
broad migration/refactor: `AssetFile.bundle_id`, cover/primary FKs, bundle tags,
bundle collections, subtitle `bundle_id`, smart collection predicates, browse
queries, counts, and "uncategorized" semantics would all need to move to or
filter against a unified entity.

The metadata milestone gains little user-visible benefit from taking that risk
now. Revisit only if promote/demote between bundle and collection becomes a real,
frequent workflow.

## Implementation rollout

Each phase should be a separate PR; none moves or modifies files on disk.

1. **Schema state for provisional grouping.** Add bundle grouping-state metadata
   and any durable plan/proposal tables needed for review/apply. Existing bundles
   should backfill as confirmed/manual or confirmed/legacy.
2. **Suggester (read-only).** Pure function over observed library files and
   existing confirmed decisions → grouping plan (BUNDLE/CONTAINER proposals,
   roles, confidence/reason). Unit-test fixtures: movie folder, photo folder,
   nested containers, multipart video, covers, subtitles, already-confirmed
   bundle, moved/repaired file, stale plan.
3. **Apply-plan service + API.** Take an optionally user-edited plan and confirm
   bundles/collections, merge/split provisional bundles, assign roles, and link
   subtitles. It must be idempotent and conflict-aware.
4. **Review UI.** Surface the plan after scan; support accept-all, merge, split,
   reclassify, rename, and apply. Wire it to the existing job/registry flow.
5. **Re-scan additions.** Suggest new files into existing confirmed bundles or
   logical containers without disturbing confirmed groupings. The reviewed
   proposal may reversibly create a separate bundle instead; that explicit
   destination choice never mutates the suggested confirmed target.
6. **External subtitle auto-link.** Fold subtitle linking into role assignment so
   the data-model claim in ADR-0003/docs becomes true for scan/grouping flows.

## Alternatives considered

- **Automatic grouping on scan (no review).** Rejected: the owner explicitly
  wants grouping to be a confirmable suggestion, and any fixed rule mis-handles
  either movie folders or photo folders (a pure directory rule merges unrelated
  photos; a pure stem rule won't attach a differently-named poster).
- **Nullable `AssetFile.bundle_id` / truly unbundled files.** Rejected for now:
  it would force every browse/playback/subtitle/thumbnail/smart-collection path
  to handle loose files. Provisional bundles preserve current invariants while
  still making scan-created grouping reviewable.
- **Keep one-bundle-per-file, add only subtitle auto-link.** Rejected as the
  primary answer (it leaves the over-fragmentation the owner flagged), but its
  subtitle-linking piece is folded into the rollout.
- **Jump straight to schema unification.** Deferred: large migration and refactor
  for little metadata-milestone benefit; revisit if promote/demote between
  bundle and collection becomes a real need.

## Consequences

- Scan remains non-destructive and repair-first, but scan-created grouping is
  explicitly provisional rather than silently final.
- Grouping becomes a reviewable, user-owned step matching the Eagle-inspired
  product stance.
- The core schema remains stable: `AssetBundle` and `Collection` stay separate,
  and `AssetFile.bundle_id` remains non-null.
- New surfaces are required: grouping-state metadata, a durable grouping plan,
  a suggester, an apply-plan service/API, and a review UI.
- `AGENTS.md` §4/§7 and `docs/data-model.md` will need updates during
  implementation to describe provisional grouping and the accepted Option A+
  decision.
- The demo media tree can be used as a future grouping fixture, but current docs
  must not claim ADR-0009 behavior is already implemented before the rollout
  lands.

## References

- ADR-0002 (core schema/identity/hierarchy), ADR-0003 (subtitle tracks),
  ADR-0006 (scanner identity & moved-file repair), ADR-0008 (per-library
  metadata & registry).
- `AGENTS.md` §2/§3 (product principles & fixed decisions), §4 (domain model),
  §7 (bundle grouping), §15 (tests).
- `docs/data-model.md` (current bundle/collection/asset-file relationships).
