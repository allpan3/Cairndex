# ADR-0011: Confirmed grouping suggestions; retire the user-facing "review" state

- Status: accepted, amended 2026-07-14
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

1. **One durable suggestion boundary.** Routine scan/**Update** and manual
   **Suggest grouping** both leave every confirmed bundle settled. They propose
   still-unbundled files and new additions to confirmed owners; collection
   membership does not make a confirmed grouping eligible again. Repeated
   generation from inside grouping review therefore uses the same candidates as
   entering the review.

2. **Retire the user-facing "review" state.** The "Needs review" badge is
   removed. Provisional/confirmed remain **internal** (they still drive
   re-scan-addition durability per ADR-0009 phase 5); they are no longer
   surfaced as a status the owner has to track.

## Consequences

- “Uncategorized” describes collection membership, not bundling state. Moving a
  confirmed bundle into a collection remains a separate collection operation;
  **Suggest grouping** never re-litigates that bundle.
- The internal provisional/confirmed model is intentionally **kept** (removing
  it would be destructive and break ADR-0009 phase-5 rescan additions). Only the
  UI vocabulary changed.
- No schema or API-shape change. The server-internal alternate scope is removed
  so the endpoint and scan handler cannot drift apart again.

## Amendment history

The 2026-07-03 decision originally gave manual **Suggest grouping** a broader
`uncategorized` scope. Product-owner testing found that entering grouping review
and clicking **Suggest grouping** again changed the candidate set and made
already-bundled files appear unbundled. The 2026-07-14 amendment removes that
alternate scope and restores confirmation as the single grouping boundary.
