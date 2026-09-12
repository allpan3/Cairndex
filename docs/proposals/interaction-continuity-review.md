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
- Unknown file counts and sizes remain Loading during a delayed response.
- A forced read failure exposes Retry and cached content; retry recovers after
  an injected four-second delay.
- A child image playlist advances from 1/73 to 2/73; the parent remains 1/1.
  Folder Enter opens File Browser, and Back restores the disclosure.

The native input trace observed system routing diverting Home/End away from the
test application. Directly targeted synthetic attempts did not establish their
delivery to WebKit. Home/End are browser-tested; native Home/End remain
unqualified. No system shortcut configuration is changed.

## Validation status

Frontend lint, formatting, types and build pass, with 1,192 unit tests. The final
full browser rerun and final desktop rebuild verification are in progress.
Desktop package tests pass; Rust formatting and Clippy pass with 124 Rust tests.
The production application builds and signs with its isolated identity.

Backend source and contracts are unchanged; the production backend participates
in browser and native integration checks. This group does not repeat the S09
codec/performance matrix or claim Ubuntu, Windows, notarization, real providers,
Docker or NAS qualification. Native input checks are not a comprehensive
accessibility certification. Private synthetic screenshots and logs remain
outside the repository.
