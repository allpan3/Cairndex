# Architecture Decision Records

This directory records consequential, hard-to-reverse decisions: stack
choices, data model shape, identity/fingerprint strategy, filter language
design, subtitle modeling, and similar structural choices called out in
`AGENTS.md`.

## Process

1. Copy `0000-template.md` to `NNNN-short-title.md` using the next sequential
   number.
2. Fill in context, decision, alternatives, and consequences before or
   alongside the implementation — not after the fact.
3. Land the ADR in the same branch/PR as the change it justifies.
4. If a later decision reverses an earlier one, add a new ADR and mark the
   old one "superseded by ADR-NNNN" rather than editing history.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-stack-and-database-choice.md) | Stack and database choice | accepted |
| [0002](0002-core-schema-identity-and-hierarchy.md) | Core schema — identity, hierarchy, and ORM access | accepted |
| [0003](0003-subtitle-track-model.md) | Subtitle track model | accepted |
| [0004](0004-eagle-import.md) | Eagle library import (read-only, idempotent) | superseded — feature removed |
| [0005](0005-packaging-and-deployment.md) | Packaging and deployment (single hardened container) | accepted |
| [0006](0006-scanner-identity-and-moved-file-repair.md) | Scanner identity and moved-file repair | accepted |
| [0007](0007-file-view-host-integration.md) | File View native handoff / host integration | accepted |
| [0008](0008-per-library-metadata-and-registry.md) | Per-library metadata and a server-side registry | accepted |
| [0009](0009-bundle-grouping-and-suggestions.md) | Suggestion-based bundle grouping (Option A+) | accepted |
| [0010](0010-per-library-passphrase-lock.md) | Per-library optional owner passphrase lock | accepted |
| [0011](0011-suggestion-scope-and-review-state.md) | Categorization-driven grouping suggestions; retire the user-facing "review" state | accepted |
| [0012](0012-client-platform-strategy.md) | Client platform strategy (web player, Android TV, macOS desktop) | proposed |
