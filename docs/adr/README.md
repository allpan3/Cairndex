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
| [0007](0007-file-view-host-integration.md) | File Browser native handoff / host integration | accepted |
| [0008](0008-per-library-metadata-and-registry.md) | Per-library metadata and a server-side registry | accepted |
| [0009](0009-bundle-grouping-and-suggestions.md) | Suggestion-based bundle grouping (Option A+) | accepted; primary-file provisions superseded by 0016 |
| [0010](0010-per-library-passphrase-lock.md) | Per-library optional owner passphrase lock | accepted |
| [0011](0011-suggestion-scope-and-review-state.md) | Categorization-driven grouping suggestions; retire the user-facing "review" state | accepted |
| [0012](0012-client-platform-strategy.md) | Client platform strategy (web player, Android TV, macOS desktop) | accepted |
| [0013](0013-library-write-mode.md) | Library write mode — gate, trash-first deletion, operation journal | accepted |
| [0014](0014-hls-session-model.md) | HLS playback session model and transcode-cache location | proposed |
| [0015](0015-device-pairing-and-bearer-tokens.md) | Device pairing and scoped bearer tokens | proposed (accepted-pending-owner-review) |
| [0016](0016-ordered-bundle-media-cursor.md) | Ordered bundle media cursor | accepted |
| [0017](0017-desktop-bearer-media-relay.md) | Desktop bearer media relay | proposed (accepted-pending-owner-review) |
| [0018](0018-library-ownership-lease-and-local-server.md) | Library ownership lease and desktop local-server sidecar | accepted |
| [0019](0019-open-source-distribution-model.md) | Open-source distribution and desktop sidecar packaging | proposed |
| [0020](0020-macos-private-api-startup-background.md) | macOS private API for the desktop webview background | accepted |
| [0021](0021-library-journal-mode-lifecycle.md) | Library journal-mode lifecycle — WAL while served, rollback at rest | accepted |
| [0022](0022-grouping-plans-in-a-server-local-database.md) | Grouping plans live in a server-local database, attached to each library | accepted |
| [0023](0023-native-modifier-state-during-drag.md) | Read modifier state natively during a drag | accepted |
| [0024](0024-directory-groups-in-bundles.md) | Directory groups — a folder of files as one row | superseded by [plan 6](../plans/06-folder-as-bundle-member.md) |
| [0025](0025-moment-tag-propagation.md) | A moment's tag propagates to its bundle, one way | accepted |
| [0026](0026-armed-range-loop.md) | An armed range loop confines ordinary playback | accepted |
| [0027](0027-vendored-muda-command-modifier.md) | Do not vendor muda for the Full Screen shortcut | rejected; conclusion superseded by [0028](0028-globe-shortcut-default-for-full-screen.md) |
| [0028](0028-globe-shortcut-default-for-full-screen.md) | Register the AppKit Globe-shortcut default so Full Screen shows ⌃⌘F | accepted |
