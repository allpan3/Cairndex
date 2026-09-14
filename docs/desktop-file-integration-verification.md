# Desktop file integration verification

Scope: the production macOS shell on `fix/library-ownership-lifecycle`, using
disposable libraries and Finder. Engineering owns the automated checks and
native controls it can operate. The owner does not need to repeat the regression
matrix. Native gesture delivery requires visible outcomes and matching destination
bytes; simulated events and command dispatch alone do not establish that delivery.

## Observed native outcomes

| Check | Evidence |
| --- | --- |
| Single-file drag-out and drag-in | Owner performed both gestures; independently checked destination hashes match their sources |
| Multi-file import | Agent selected two synthetic files through the packaged app's Add Files Here picker; both destinations match their sources, both have completed `IMPORT` journal entries, and both are visible after relaunch |
| Keyboard reorder | Agent reproduced a false conflict on a second reorder, fixed the file-read basis, then performed three successful reorders in the rebuilt package; the restored order persists across view changes |
| Mapped Open | Preview's document URL and visible image match before/after library switching, after a server round trip, and after recovery from missing files/roots |
| Failed server switch | The local workspace remains selected; bundle Open targets its correct local cover |
| Mapped Reveal | Visible target verified after a library switch |
| Missing file and wrong portable identity | Packaged Open shows the corresponding rejection |
| Unavailable mapped root | Packaged Open and Reveal show “Volume not mounted”; restoring the root restores Open |
| Unmapped remote library | A second disposable server shows no Open/Reveal buttons; cancelling Locate leaves it unmapped |
| Navigation protection | The reproduced outside-window drag/layout sequence retains the SPA in the package with the navigation guard |
| Fixture integrity | All 14 baseline source hashes and the original manifest match; all three disposable databases pass `quick_check` |

The multi-file import uses the same shipping HTML upload implementation as file
drops, entered through the file picker. It establishes batch import and persistence;
it does not claim a two-file Finder drag was performed. The native picker briefly
left Cairndex accessibility reads timing out after import. A process sample showed
the main thread waiting in its event loop; restarting only the disposable app and
sidecar restored automation. The cause of that accessibility timeout is unresolved.

## Engineering coverage

The copy-only follow-through adds three backend regression cases using synthetic
bytes. Another-directory Copy and same-directory Keep Both create separate asset
IDs/bundles and leave the source unchanged; Undo trashes the copy. Same-path
Replace trashes the prior identity, catalogs a new identity, and Undo restores the
original ID, membership, path and bytes. A new component case verifies that scope
teardown aborts the request, prevents the remaining batch and skips stale linking.
These checks pass with **178 backend file-operation/path tests** and **1,220
frontend tests**. Backend Ruff/format/mypy and frontend lint/format/typecheck/build
also pass. Runtime code is unchanged; no runtime defect was demonstrated.

All **six real-backend browser cases pass**: File Browser copy/Undo, its three
conflict choices, and bundle card/inspector Keep Both/linking. They verify actual
destination bytes, journal receipts, independent cataloged identities, preserved
source membership and reload persistence. The browser uses the file picker and
synthetic HTML drop events; these results do not qualify OS gesture delivery.
Lint, formatting and the normal frontend typecheck pass after the final test
corrections. Chromium executed with owner-approved escalation after sandbox IPC
and approval-service timeouts. Native-control access still timed out twice in
automatic approval review during the approved retry, before controls loaded.
No new native input or delivery result is claimed.

An additional standalone strict TypeScript check of the e2e graph reports an
existing `Buffer`/`BodyInit` incompatibility in unchanged `e2e/realBackend.ts`.
The repository's normal frontend typecheck passes; the shared helper was not
changed as part of this copy-only verification.

| Behavior | Executed coverage |
| --- | --- |
| Multi-file drag payload and partial availability | Six added Rust tests exercise the production resolver against synthetic files: ordered survivors, fully unavailable selection, unsafe paths, unmapped members, changed portable identity and empty selection |
| Repeated reorder and real concurrent conflict | Real-backend browser regression reproduces HTTP 409 before the fix and passes afterward; the existing stale pointer-reorder rejection still passes |
| Import permissions, collisions, cancellation, cleanup and linking | Frontend import coverage, 178 backend path/file-operation tests and six real-backend copy/import browser cases pass |
| Alternate drag sources, selection and internal reorder | Existing component/source tests cover selection-aware payloads and pointer-vs-Option behavior; full frontend suite passes |
| Modifier changes and cancellation guard | Existing tests cover modifier polling, move/copy decisions, drag IDs, grace periods, stale completion, cancellation and failed starts |
| Server/mapping isolation | Existing connection, settings and Rust mapping tests cover scope changes, failure recovery, identity validation and containment; native outcomes appear above |

Earlier changed-code gates: frontend lint, format, typecheck and **1,219 tests**;
Rust format, Clippy and **135 tests**; two real-backend reorder browser cases;
production frontend and isolated app build; strict deep code-signature verification.
The prior eight browser drag/import cases also passed during this audit. No backend
code changed, so the full backend suite was not repeated. The existing frontend
chunk-size warning remains. Build output and synthetic data stay outside Git.

## Copy-only import assessment

The owner's simpler option is to treat file-manager drops as copies regardless
of original location or volume. The shipping HTML `File` route already does this;
it needs uploaded bytes, not the trusted original path. Native capture and
same-volume Move in [ADR-0033](adr/0033-selective-native-file-drops.md) are on hold.
No new native implementation, source deletion or general copy endpoint is needed
for this workflow.

| Drop and destination | Current behavior |
| --- | --- |
| Finder/QSpace files onto File Browser | Copy into the directory being viewed, subject to deployment/library write permission |
| Files from another directory in the same library | Same copy-in route; do not reverse-map to the original asset or group it in place |
| Files onto a bundle card/inspector | Choose an import directory; copy with automatic Keep Both suffixing, then link the landed copies |
| Existing name in File Browser, including the same source/destination folder | Prompt Replace / Skip / Keep Both. Keep Both picks a free suffixed name; Skip leaves it alone; Replace trashes the existing destination before writing. No automatic same-directory no-op or content deduplication |
| Unsupported target, including a collection without a file-import handler | Guidance; do not infer a physical directory from logical membership |
| Ordinary internal grouping/reorder | Existing logical gestures remain separate from HTML file imports |

Copy-in never requests source removal. Explicit Replace acts on the destination:
if that destination is also the source being dragged, it can trash that original.
Keep Both preserves both. Imported files do not borrow the source's asset ID or
memberships. File Browser writes bytes without automatically cataloging them;
bundle import/link catalogs the new path. Verify distinct IDs when cataloged and
retain the existing destination-replacement/Undo contract rather than describing
Replace as harmless to the original path.

### Minimal engineering follow-through

1. Verify synthetic same-library copies into another directory and the original
   directory through the existing HTML workflow. Check bytes, completed journal
   receipts, no implicit source removal, distinct cataloged IDs, memberships and
   persistence. Cover File Browser and bundle destination/link behavior.
2. Reuse focused import coverage for write rejection, collisions, cancellation,
   partial batches, Undo and library/server scope changes; add only missing
   meaningful regressions and fix reproduced defects in this path. File Browser
   prompts and bundle Keep Both must be tested as their actual distinct policies.
3. Qualify real file-manager delivery separately: the owner's Finder single-file
   drop already passed; the agent's two-file picker import passed. Neither proves
   QSpace transfer or multi-file OS drag delivery. Use only supported controls
   and synthetic locations; prior broad QSpace inspection was rejected, and
   repeated unsupported drag coordinates are not a substitute for delivery proof.
   No owner regression checklist is assigned.
4. Keep app-origin self-return as its own case. The shipping HTML handlers do not
   deterministically distinguish a returning native drag from Finder/QSpace.
   Targeted return may copy again; navigation protection prevents replacing the
   SPA but does not suppress an import. Do not call source discrimination solved.

The adapter is unnecessary solely to implement always-copy file-manager imports.
If reliable self-return suppression remains required, its native source/session
boundary may still need the held design or another separately reviewed solution.
Metadata-only OS grouping, volume-based moves and outside-source deletion are not
part of this copy-only assessment. Existing Open/Reveal and outgoing drag need no
new adapter merely because the incoming policy is simplified.

## Limits

Computer Use's drag coordinates can return `noWindowsAvailable` or complete at an
unintended later interaction; no mid-drag modifier-hold API is documented. Locate
selection left Open disabled under automation; cancellation worked. These do not
establish ordinary-user defects. QSpace, multi-file OS delivery, app-origin return
and remote Locate acceptance remain unqualified, independently of automated test
coverage. Windows/Linux native delivery, other receiving apps, development-server
smoke and real NAS disconnect latency are not established by local macOS fixtures.

This follow-through changes tests only. The full backend suite and Rust/native
build were not repeated because their runtime code is unchanged. The passed
evidence above remains valid; the whole integration group is not declared complete.
