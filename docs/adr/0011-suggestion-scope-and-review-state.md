# ADR-0011: Categorization-driven grouping suggestions; retire the user-facing "review" state

- Status: accepted
- Date: 2026-07-03
- Branch/PR: `feat/collection-bundle-ordering`

## Context

ADR-0009 introduced provisional/confirmed bundle grouping. A scan stages files
as *provisional* one-file bundles; the "Review grouping" action runs the
suggester and applying it *confirms* bundles and creates the suggested
collections. Confirmed groupings are durable and are excluded from future
suggestions so a re-scan never disturbs a decision the owner already made.

That exclusion is keyed on the *confirmed* state, which produced a surprising
gap: once a bundle is confirmed and then has all its collections removed, it
becomes uncategorized again but is still confirmed — so "Review grouping" will
never re-surface it for filing. The owner has an uncategorized bundle that no
suggestion pass will ever propose a home for. The provisional-vs-confirmed
distinction also leaked into the UI as a transient "Needs review" badge that a
bundle could silently fall in and out of, which read as noise.

## Decision

1. **Two suggestion scopes.** Plan generation takes a `scope`:
   - `new` (routine scan / **Update**): leave every *confirmed* grouping alone;
     only files not yet in a confirmed grouping get proposals. Unchanged from
     ADR-0009.
   - `uncategorized` (manual **Suggest grouping**, renamed from "Review
     grouping"): treat every bundle **not filed into a collection** as an open
     candidate again — including a previously confirmed one whose collections
     were later removed — plus still-unbundled files. Bundles already in a
     collection are treated as settled owners and are not re-suggested.

   The scope only changes what the *suggester* reconsiders (via the
   `grouping_confirmed` flag on each observation). It does **not** change the
   apply path or the database: applying an `uncategorized`-scope plan over a
   still-confirmed bundle is a conflict-aware no-op re-confirm (the DB's
   confirmed state still protects it from being re-split or retitled). This is
   what keeps the change non-destructive.

2. **Retire the user-facing "review" state.** The "Needs review" badge is
   removed. Provisional/confirmed remain **internal** (they still drive
   re-scan-addition durability per ADR-0009 phase 5); they are no longer
   surfaced as a status the owner has to track.

## Consequences

- The owner's mental model becomes "is this bundle filed into a collection?"
  rather than "is this bundle confirmed?". Uncategorized bundles are always
  re-offered by manual **Suggest grouping**; **Update** stays narrow so a
  routine re-scan never re-litigates confirmed groupings.
- The internal provisional/confirmed model is intentionally **kept** (removing
  it would be destructive and break ADR-0009 phase-5 rescan additions). Only the
  suggestion *scope* and the UI vocabulary changed.
- No schema or API-shape change: `scope` is server-internal (the manual
  `POST …/grouping/plans` endpoint selects `uncategorized`; the scan handler
  keeps `new`), so no OpenAPI/client regeneration is required.
