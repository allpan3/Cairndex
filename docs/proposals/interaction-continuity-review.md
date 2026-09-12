# Interaction continuity review

S10 covers keyboard selection, dialog cancellation, inspector loading and folder
navigation on `fix/library-ownership-lifecycle`. The implementation baseline is
`62bbb6ec`. Source operations, providers, Docker and real NAS use are outside this
qualification.

## Behavior and boundaries

- Focused bundle and file listings own their selection shortcuts. Shift ranges
  grow and shrink around a stable anchor; command arrows move focus separately.
  Select All applies to loaded items and identifies a partial listing.
- New collections remain local name drafts until Create. Escape closes a nested
  picker before its parent dialog; Tab wraps and closing restores the opener.
  Pending confirmed mutations keep their dialog open.
- Inspector counts and sizes distinguish unknown from zero. Failed reads offer
  retry, cached files remain readable, and directory membership must load before
  arranging loose files and folder rows. Query identity fences late responses.
- Folder disclosures survive inspector/viewer/File Browser round-trips in the
  window. Retained state is bounded and scoped by server, library, bundle and
  surface. Indexed file selections and viewers follow file IDs across renamed
  paths and reordered results. Unindexed files and directories use paths.
- Complete successful listings prune missing selections. Failed, pending and
  partial reads cannot establish deletion. Parent and child playlists retain
  their separate membership boundaries.

## Evidence

Synthetic regression tests reproduced range-anchor failures, collection creation
before confirmation, missing dialog Escape, false inspector zero/empty states
and the inspector retaining an old path after an indexed file rename.

Browser coverage includes delayed files and directory membership, initial
failure/retry, cached reselect, late responses after selection changes, a
74-file inspector, a 600-item virtualized listing, sorting/removal/filter
selection behavior, and thumbnail delay/failure. A delayed one-pixel synthetic
thumbnail decoded 3 ms after releasing its response; this is a fixture fill
measurement, not a media or frame-rate benchmark. Thumbnail failure retained
the file row and its selection action; no persistent thumbnail defect was
established.

Agent-operated desktop checks use the normal production Tauri app, a separate
application identity, and an isolated production backend containing only
generated images and invented metadata. Checks establish:

- Cancel and Escape submit no collection write; Create submits the entered name.
- Focus returns to the opener; forward/reverse Tab wrap at the dialog boundary.
- A collection picker closes before its Smart Collection draft.
- Shift ranges grow from two to three items and shrink to two. Select All
  reports 100 loaded bundles out of a 132-bundle fixture.
- Native arrows traverse offscreen items beyond the first loaded page and return
  to the first bundle. File Browser ranges grow/shrink and Select All selects all
  73 folder files; Escape clears that selection in the final production build.
- Unknown file counts and sizes remain Loading during a delayed response.
- A forced read failure exposes Retry and cached content; retry recovers after
  an injected four-second delay.
- A child image playlist advances from 1/73 to 2/73; the parent remains 1/1.
  Folder Enter opens File Browser, and Back restores the disclosure.

The focused native recheck on 2026-09-12 uses the unchanged production build
with explicit application activation and macOS foreground-process readback
before every input sequence. Accessibility focus/selection and screenshots agree:

- Bundle list: Down moves 050 → 051; Home selects 001 and reveals the top.
  End selects 100, the last loaded bundle. After the next page loads, another
  End selects 132 and reveals the bottom of the virtualized listing.
- File list: Down moves 050 → 051; Home selects 001; End selects 132 and
  reveals the last file. Home selects the first file on a repeat check too.
- File-list keyboard scrolling accounts for the measured sticky column header.
  The rebuilt production app verifies Down 050 → 051, Home → 001, End → 132
  and Home → 001, with the complete first row visible below the header on both
  Home checks.

The earlier Raise/click attempts established WebKit focus while macOS still
reported another application as frontmost. Explicit activation resolves the
native verification gap; the earlier attempts do not establish Home/End
interception by the OS. These checks send native Home/End without modifiers.
No system shortcut changes or renderer instrumentation are used.

Two browser geometry regressions check full row visibility after Home, End and
upward navigation at item sizes 120 and 300. Both reproduce the header overlap
without the scroll correction and pass with it. The correction uses the actual
header bounds after nearest-item scrolling; grid navigation has no header inset.

## Validation status

Frontend lint, formatting, types and build pass, with 1,192 unit tests and 164
browser tests. The final committed implementation passes its desktop rebuild
and native loading, draft-cancellation, disclosure and file-selection checks.
Desktop package tests pass; Rust formatting and Clippy pass with 124 Rust tests.
The production application builds and passes strict signature verification with
its isolated identity.

All 76 generated source images retain their baseline hashes. Test clients and
backend are stopped; the synthetic library, registry, runtime identity data and
Launch Services registration are removed. The ignored app build output remains
available. The S10 committed-range privacy gate passes. The cumulative branch
gate exceeds its 8 MiB new-blob limit, so publication remains blocked and history
is preserved. No installed application or owner library is changed.

Backend source and contracts are unchanged; the production backend participates
in browser and native integration checks. This group does not repeat the S09
codec/performance matrix or claim Ubuntu, Windows, notarization, real providers,
Docker or NAS qualification. Native input checks are not a comprehensive
accessibility certification. Private synthetic screenshots and logs remain
outside the repository.

Each focused native recheck preserves all 132 generated source hashes and removes
its disposable app copy, backend, library, registry, connection settings and runtime
identity data. The header repair passes frontend lint, formatting, types, all 1,192
unit tests, 18 focused browser tests, production frontend/app builds and strict
signature verification. Backend/Rust source is unchanged; their test suites and
the broader browser matrix are not rerun for this repair.
