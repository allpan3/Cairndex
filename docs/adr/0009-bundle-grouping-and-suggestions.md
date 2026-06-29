# ADR-0009: Suggestion-based bundle grouping (and bundle ↔ collection model)

- Status: **proposed** (awaiting owner decision on the data-model option)
- Date: 2026-06-29
- Branch/PR: `docs/adr-0009-bundle-grouping`

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

Current model (ADR-0002, ADR-0008): `AssetFile.bundle_id` (CASCADE) ties each
file to exactly one `AssetBundle`; `AssetBundle` carries `title`, `rating`,
`note`, `cover_file_id`, `primary_file_id`; `Collection` is a hierarchical
grouping of **bundles** (M:N), independent of the physical File View. Bundles are
already hidden leaves — they never appear in the collection tree. So insight (3)
partly describes today's behavior; what is new is unifying the *mental model* and
deciding whether to unify the *schema*.

`AGENTS.md` constraints that apply: metadata-only / non-destructive (§2/§3 — no
file moves); one source of truth (§2.7); Eagle-inspired, reviewable, never
auto-merge destructively (the old §7 spirit); scale by design (§2.10 — no full
scans/hashes on the request path, ADR-0006); collections are the product term and
contain bundles, not loose files (§3).

## Decision (proposed)

Replace silent per-file bundling with a **propose → review → apply** pipeline,
and treat folder classification (bundle vs container) as a heuristic *suggestion*
the user confirms. Concretely:

1. **Scan stays discovery + non-destructive.** A scan links/repairs files and
   tracks availability exactly as today (ADR-0006), but **does not finalize
   grouping**. Files discovered without a confirmed grouping are *unbundled*
   (see the model options for how "unbundled" is represented).
2. **A grouping suggester produces a plan**, never writing content rows itself:
   for each directory it proposes either
   - **BUNDLE** — one grouping of the folder's media (a primary item + sidecar
     cover/subtitle/part files), or
   - **CONTAINER** — a collection-like folder whose children are themselves
     bundles or sub-containers (e.g. `Photos/` → each photo its own bundle).
   Each proposal carries a confidence and a human-readable reason.
3. **The user reviews and applies the plan.** A review surface shows proposed
   bundles/containers with the ability to accept-all, merge, split, reclassify a
   folder (bundle ↔ container), and rename. Applying the plan creates the
   bundles/collections and assigns file roles. This is the only step that writes
   grouping.
4. **User decisions are durable and win over heuristics on re-scan.** A confirmed
   bundle is never silently re-split or merged; new files appearing later are
   *suggested* into the right existing bundle/container, not auto-applied.
5. **Role assignment within a bundle** is derived: primary = the single video (or
   dominant media); cover = an image named `cover`/`poster`/`thumbnail`/`thumb`,
   else the first image; external `.srt`/`.vtt` become subtitle tracks linked to
   the primary video (language parsed from the suffix, per ADR-0003); `sequence`
   from numeric/name order.

The **data-model question — how literal "a bundle is a sub-collection" should
be — is left to the owner**; the two options and a recommendation are below.

### Folder classification heuristic (BUNDLE vs CONTAINER)

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

Nested folders recurse: a CONTAINER's children are classified independently, so
`Movies/` (container) can hold `Cosmos/` and `Waves/` (bundles).

### Re-scan idempotency

- Already-linked files keep their bundle (membership is the durable record of a
  past decision).
- Genuinely new files are run through the suggester and surfaced as *additions*
  ("add `cosmos.fr.srt` to bundle **Cosmos**?") — never auto-applied to a
  confirmed bundle.
- Moved-file repair (ADR-0006) is unchanged and runs before suggestion.

## Data-model options (owner to choose)

### Option A — Conceptual only; keep `AssetBundle` and `Collection` as separate tables (recommended)

Bundles already are hidden metadata-carrying leaves; collections already group
bundles. Keep both tables. The reframe guides UX and the suggester; "bundle is a
sub-collection" stays a mental model, not a schema change.

- *Easier:* no migration; browse/tags/smart-collections/file-FK code untouched;
  ships the suggestion workflow (the part the owner actually asked for) without
  destabilizing the core. Represent "unbundled" either as a single-file bundle
  (status quo) or with a nullable grouping marker — a small additive change.
- *Harder:* the two concepts remain two tables, so any future "promote a bundle
  into a browsable collection" (or vice-versa) is an explicit conversion, not a
  flag flip.

### Option B — Unify the schema: a bundle *is* a `Collection` (e.g. `kind = collection | bundle`)

Folders map to collections; a "bundle" is a collection marked as a hidden,
metadata-carrying leaf. Files attach to a leaf collection instead of a separate
bundle table.

- *Easier (long term):* one hierarchy; "this folder is actually a bundle / is
  actually a collection" becomes a flag flip; a single grouping primitive.
- *Harder:* a real migration and broad refactor — `AssetFile.bundle_id` →
  membership in a leaf collection; collection↔bundle M:N collapses; browse
  ("bundle-first") must filter to `kind = bundle`; tags, smart collections,
  cover/primary, and subtitle FKs all move to the unified entity. Higher risk,
  and the metadata-only milestone gains little user-visible benefit from it yet.

**Recommendation: Option A now, with Option B documented as a future
consolidation.** It delivers the suggestion-based grouping the owner wants
without a risky migration, and keeps the door open: if "promote/demote between
bundle and collection" becomes a real workflow, revisit B with its own ADR.

## Proposed phased rollout (after the option is chosen)

1. **Suggester (read-only).** Pure function: library tree → grouping plan
   (BUNDLE/CONTAINER proposals + roles + confidence/reason). Unit-tested against
   fixtures (movie folder, photo folder, nested, parts, subtitles). No writes.
2. **Apply-plan service + API.** Take an (optionally user-edited) plan and create
   bundles/collections, assign roles, link subtitles — idempotent and
   non-destructive. Decouple scan (discovery) from grouping (apply).
3. **Review UI.** Surface the plan post-scan; accept-all / merge / split /
   reclassify / rename; then apply. Wire to the existing job/registry flow.
4. **Re-scan additions.** Suggest new files into existing bundles/containers
   without disturbing confirmed groupings.
5. **External subtitle auto-link** folded into role assignment (closes the
   existing gap where the data-model doc claims auto-link that isn't implemented).

Each phase is a separate PR; none moves or modifies files on disk.

## Alternatives considered

- **Automatic grouping on scan (no review).** Rejected: the owner explicitly
  wants grouping to be a confirmable suggestion, and any fixed rule mis-handles
  either movie folders or photo folders (a pure directory rule merges unrelated
  photos; a pure stem rule won't attach a differently-named poster).
- **Keep one-bundle-per-file, add only subtitle auto-link.** Rejected as the
  primary answer (it leaves the over-fragmentation the owner flagged), but its
  subtitle-linking piece is folded into phase 5.
- **Jump straight to Option B (schema unification).** Deferred: large migration
  and refactor for little metadata-milestone benefit; revisit if promote/demote
  between bundle and collection becomes a real need.

## Consequences

- Scan becomes purely discovery; **grouping becomes an explicit, reviewable,
  user-owned step** — matching the Eagle-inspired, non-destructive product
  stance.
- New surfaces: a grouping suggester, an apply-plan service/API, and a review UI;
  plus durable handling so re-scans respect confirmed groupings.
- Under Option A the core schema is essentially unchanged (at most a small
  additive "unbundled" marker); Option B is a separate, larger migration if ever
  chosen.
- `AGENTS.md` §4/§7 and `docs/data-model.md` will need updates to describe the
  suggestion model and (if chosen) the unified entity; the data-model's current
  claim of external-subtitle auto-link becomes true in phase 5.

## References

- ADR-0002 (core schema/identity/hierarchy), ADR-0003 (subtitle tracks),
  ADR-0006 (scanner identity & moved-file repair), ADR-0008 (per-library
  metadata & registry).
- `AGENTS.md` §2/§3 (product principles & fixed decisions), §4 (domain model),
  §7 (bundle grouping), §15 (tests).
- `docs/data-model.md` (current bundle/collection/asset-file relationships).
