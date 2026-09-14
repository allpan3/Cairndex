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

| Behavior | Executed coverage |
| --- | --- |
| Multi-file drag payload and partial availability | Six added Rust tests exercise the production resolver against synthetic files: ordered survivors, fully unavailable selection, unsafe paths, unmapped members, changed portable identity and empty selection |
| Repeated reorder and real concurrent conflict | Real-backend browser regression reproduces HTTP 409 before the fix and passes afterward; the existing stale pointer-reorder rejection still passes |
| Import permissions, collisions, cancellation, cleanup and linking | Existing frontend import tests and 175 backend path/file-operation tests passed during this audit |
| Alternate drag sources, selection and internal reorder | Existing component/source tests cover selection-aware payloads and pointer-vs-Option behavior; full frontend suite passes |
| Modifier changes and cancellation guard | Existing tests cover modifier polling, move/copy decisions, drag IDs, grace periods, stale completion, cancellation and failed starts |
| Server/mapping isolation | Existing connection, settings and Rust mapping tests cover scope changes, failure recovery, identity validation and containment; native outcomes appear above |

Final changed-code gates: frontend lint, format, typecheck and **1,219 tests**;
Rust format, Clippy and **135 tests**; two real-backend reorder browser cases;
production frontend and isolated app build; strict deep code-signature verification.
The prior eight browser drag/import cases also passed during this audit. No backend
code changed, so the full backend suite was not repeated. The existing frontend
chunk-size warning remains. Build output and synthetic data stay outside Git.

## Optional native spot checks

These are the remaining OS interaction gaps, not a request to repeat automated
coverage. Use **Cairndex File Check** and only the synthetic fixture root
`/private/tmp/cairndex-file-integration` if completing full native qualification.

| Check | Short procedure and expected outcome |
| --- | --- |
| Multi-file OS payload | Library A → Bundles → select Drag Check. Drag the large inspector cover to Finder's `Receiver/Cover Out`. Amber and Blue should both arrive |
| Gesture cancellation and modifier changes | Cancel an outgoing drag with Escape before release; no copy should land and the next drag should work. For collection copy behavior, drag Drag Check from Drag Source toward Drag Target, pressing Option while dragging: both memberships should remain, with source files unchanged |
| Remote Locate acceptance | Connect to saved server 18973 → Settings → Libraries → Locate. Library A should be rejected; Library Remote should map successfully and Open should show its blue specimen. Return to This Computer afterward |

The agent can inspect destination hashes, journal entries, order and membership
after these gestures. No missing-file renaming, repeated layout sweep, collision
exercise or backend validation is assigned to the owner. Library A contains the
two verified batch imports; Drag Check remains Amber then Blue, only in Drag Source.

## Limits

Computer Use's drag coordinates can return `noWindowsAvailable` or complete at an
unintended later interaction. It has no documented mid-drag modifier-hold API.
Locate automation selected a directory but left Open disabled; cancellation worked.
Those results do not establish ordinary-human defects or successful acceptance.
Native alternate-source delivery, self-return drops and the gesture checks above
remain unqualified; passing component tests does not change that evidence level.

The shipping HTML import route does not activate native reverse mapping or the
deterministic native self-drop router. Restoring that integration remains an
engineering task requiring internal gestures to keep working. Native Linux,
Windows and development-server smoke tests, other receiving applications and
real NAS disconnect latency remain outside this macOS local-fixture qualification.
