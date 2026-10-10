# Portable application extraction

## Scope and state

Branch: `feature/portable-library-lifecycle`. It was published on the PR #38 merge
`a8c536e1` and is rebased onto current main for its PR. IDs are current after the
history rewrite of 2026-10-09.
Group 1 merged through PR #38. The owner approved one application branch for
former groups 2–5, with separate functional test rounds. The application is
implemented and tested in the [VM guests](audit-vm-handoff.md). PR #45 merged it
into main on 2026-10-10 with merge commit `cbf1643d`.

Normal format-three Create/Open, private access, Release/Reopen, snapshots and
recovery share the catalog workspace with Update, browsing, metadata edits and
playback. Separate application branches would require temporary reduced workflows.
One round's acceptance does not approve the other rounds or authorize merge.

## Functional rounds

1. Create/Open, old-format refusal, access, Release/Reopen, snapshots and recovery.
2. Update, reviewed grouping, stable file identity and interrupted/retried work.
3. Browse, filters, metadata edits, relationships, selection and retained drafts.
4. Playback, library/server switching, keyboard and restart continuity.

Functional checks use a local production build and disposable fixtures.
The installed app stays unchanged. A local launcher holds the owner profile,
selects the disposable profile and restores the original profile after app exit.
The agent performs code review and all tests that available access permits. The
owner does not need to repeat scripted checks. Owner assistance is limited to
product decisions, missing access or devices, and explicitly approved real-data
operations. Functional testing does not authorize application publication.

## Implementation and contract changes

- Registry Create/Open admits portable packages and refuses old packages. Registry
  migrations add package format, released state and durable recovery tasks.
- Private owner sessions and access settings remain outside recovery generations.
  Release blocks new content work, drains active requests and closes private locks.
- Library-scoped catalog, discovery, media and recovery APIs use the private store.
  OpenAPI and frontend types are generated from this branch.
- The ordinary workspace supports complete catalog queries, metadata relationships,
  private drafts, Update review and local playback. Desktop request scope and
  navigation protect library/server boundaries.
- Packaged smoke tests use portable Create, Update, review and media derivatives.
  The existing signing configuration remains unchanged.

## Extraction differences and fixes

- Group 1 migration, conversion, private layout and search-index modules are
  retained. Private database upgrades remain distinct from format conversion.
- Local immutable publication uses exclusive hard links. Mounted SMB publication,
  source-operation routes, workers, transport and UI remain in group 6.
  `source_operations_version` is unavailable. Recovery retains source validators
  and private schemas without enabling source operations.
- Legacy model fixtures use explicit internal admission. Normal application
  admission remains closed to old packages. Legacy handlers are retained for
  internal model dependencies; portable requests cannot enter those handlers.
- Three reference lease cases (cached legacy connection and two background lease
  cases) are omitted because they test the superseded shared-folder lease workflow.
  Portable admission/refusal and lifecycle drain remain covered.
- The mounted-SMB EACCES creation case stays with group 6. Local unsupported-link,
  no-space and permission-denied creation/retry cases are included.
- Empty-library Refresh does not request an undefined bundle. Browser regression
  coverage and the rebuilt native app verify this new fix.
- Portable thumbnails use the portable media adapter. A real-server browser test
  verifies this extraction repair.

## Branch validation

All results below apply to this extracted application, not only to the reference.

| Check | Result |
| --- | --- |
| Backend Ruff, formatting, mypy | Passed |
| Backend tests | 1,612 passed, one existing skip |
| Frontend lint, formatting, types | Passed |
| Frontend unit tests | 1,253 passed |
| Browser tests | 31 passed |
| Rust formatting, locked Clippy, tests | Passed; 135 tests |
| Sidecar build and portable package smoke | Passed |
| Frozen sidecar recovery/discovery process tests | Three passed |
| Production macOS app and DMG build | Passed |
| Native synthetic checks | Passed for the cases below |
| Docker/deployment | Not run on the original machine: no Docker daemon. Ubuntu guest run: see below |
| Ubuntu Rust | Passed in the Ubuntu guest: see below |

Foreground native checks used the normal production app with disposable private
state. Create preserved source bytes; Update and review created one two-file
bundle. Old-format Open refused the fixture without changing it. Snapshot,
verification, Release, preparation, review, activation and explicit Reopen passed.
Wrong unlock was refused; correct unlock succeeded. Recovery retained destination
access protection. The bundle and file relationships remained present. Image and
video pixels rendered. A saved note survived protected restart. A second empty
library remained independent; switching and empty-library Refresh passed.

The owner profile was restored with matching file hashes, modes and links. The
installed desktop and sidecar executable hashes remain unchanged. Synthetic source
media and old-format fixture hashes remain unchanged. No owner library, signing
identity, Keychain grant, production service or source media was changed.

## Additional native checks on 2026-10-09

The agent tested a local application checkpoint in the primary checkout. That
checkpoint never reached the remote and is not available after the history
rewrite; its source inventory is equal to `14dfb6a5`. The
production desktop executable SHA-256 was
`9971d18f9553c94033aa977bd915b622d80bf32f1d8c6c836a73ffa22eee8475`.
No application source changed during these checks. Earlier automated results
therefore still apply; full suites were not repeated.

- Search selected the intended bundle. A nonmatching rating filter returned the
  empty state; clearing it restored the result. List layout showed all bundles.
- Explicit tag and collection membership reviews preserved the unsaved note.
  Library switching kept the note and cover draft with their original library.
- Saved note, four-star rating, cover and both memberships survived app restart.
- File Browser listed the six generated files under the active library root.
- Native Update checked six files. After an external move of one generated video,
  Update repaired one link. A comparison of every catalog row found only the
  file's relative path changed. IDs, metadata, memberships, cover, moments and
  subtitle relationships were identical. Restoring the filename and running
  Update again restored every catalog row exactly. Source hashes matched.
- Native direct, remux and fallback video displayed decoded test-pattern frames.
  Pause, keyboard seek, external captions, playback settings, Escape and local
  resume after restart were exercised. The image fixture also rendered.

The first long-running session showed stale Update status and black video
captures while the backend completed work and the playback clock advanced.
Switching libraries refreshed Update status. After a clean restart, Update status
advanced and all three video fixtures displayed decoded frames. The cause of the
first-session observations is not established; no code repair is claimed.

The local test launcher supervises the actual production executable until exit.
Disposable fixtures use durable local storage. Temporary fixtures and the former
launch-helper wait were insufficient for a test session retained across days.
The launcher and private receipts remain outside Git.

After testing, the owner profile was restored and checked against its receipt:
file hashes, modes and links matched. Installed app and sidecar hashes matched.
Docker was checked again and had no daemon socket. No alternate local Linux
runtime was found. Docker and Ubuntu Rust checks remain open platform gates;
they are not assigned to the owner as manual feature tests.

## VM results on 2026-10-09

These results apply to source inventory
`12f35cdb150161fc0e6a66a1ee4bbcaf7d651c4dc22b717f8fc648befc5ce655`, which is
the content of `14dfb6a5`. The [handoff](audit-vm-handoff.md#current-test-environment-2026-10-09)
describes the guests. The rebase onto current main needs new results; the next
sections record them.

macOS guest, all section A checks passed:

- Backend Ruff, formatting and mypy. Backend tests: 1,613 passed, none skipped.
  The pinned ffmpeg is installed, so the earlier ffmpeg skip does not apply.
- Frontend lint, formatting, types, 1,253 unit tests, production build and 31
  browser tests.
- Sidecar build with the bundled ffmpeg, package smoke and the frozen recovery
  process test (one passed).
- Rust formatting and locked Clippy. Rust tests: 135 passed with the real sidecar.
- `npm run tauri build -- --bundles app` and `infra/verify_macos_distribution.sh`.
  Sidecar SHA-256 `a3571ce725f45185bf71d4b2047f57f007d18625d27f811ef94735be8c94d70a`;
  desktop executable SHA-256
  `43f72ebd21ff909fe8f10d8af8f863c12855dbb8a70564df1156185fa204b9a1`.

Ubuntu guest:

- Passed: frontend 1,253 unit tests and production build; sidecar build with
  `--skip-ffmpeg` and package smoke; the frozen recovery process test; Rust
  formatting, locked Clippy and 133 tests with the CI placeholder sidecar
  resource.
- `test_ffmpeg_manifest.py::TestPlatformNaming::test_current_platform_is_a_manifest_key`
  fails because `linux-arm64` is not a manifest platform. This is a guest limit.
- `test_privacy_gate.py::test_range_scan_finds_a_deleted_secret_blob` failed with
  Git 2.43. PR #42 on main and the Git 2.55 upgrade address this; the rebased
  branch needs a new run.
- Some backend tests fail only on the guest's slow ext4 disk. They pass with
  `--basetemp` on `/dev/shm`. The set of failures changed between runs (eight,
  then four).
- `e2e/replica-discovery.spec.ts:447` fails only on that disk and passes with
  `TMPDIR` on `/dev/shm`. `e2e/replica-media.spec.ts:62` and
  `e2e/catalog-browse.spec.ts:308` fail because Linux arm64 Chromium cannot decode
  H.264/AAC. Both pass in the macOS guest.

Open observation:
`test_replica_discovery_binary.py::test_sidecar_complete_collection_and_full_verification`
takes 61 seconds in the macOS guest and 47 seconds on Linux tmpfs. On the Linux
disk it fails when one 60-second wait expires. The test makes about 1,598
`fdatasync` and 16 `fsync` calls. The timeout margin is small, and slow storage,
for example a NAS with hard disks, can make the same work slower. The cause of
the duration must be found before a timeout change is considered.

## Results after the rebase onto current main

The branch was rebased onto main `7d5e50b6` without conflicts. Compared with
`14dfb6a5`, the rebased tree differs only by main's six changed files. Its source
inventory SHA-256 is
`11a648f0bd09b84ef6baa5c9715793fd018cdf7a8edfbbc130a65bb6e2fd9369`.

### Docker and deployment (section E)

The two smoke scripts were repaired for format three (see the changelog and
`docs/deployment.md`). In the Ubuntu guest, on tree
`e83befc2c387b94bdef2d02465fedebcbe575382`, `build-and-check.sh`, `smoke.sh` and
`backup-restore-smoke.sh` passed with image `cairndex:application-test-e83befc2c3`
(arm64, image ID `sha256:0e6368e5831475ccb96b60fb76338d2617d9dc07b1aad44195fb4689c7a1f7a0`).
The largest build context was 7.69 MB. The checks cover a non-root and
arbitrary-uid runtime, a read-only container root, separate private data and
snapshot volumes, direct ranges, copy-only HLS, a database-free `.cairndex/`
package, a clean restart, a forced `SIGKILL` restart, damaged-store recovery from
a snapshot, and a retained passphrase. The scripts removed their containers,
volumes and temporary directories after each run. After all runs, the test images
and the build cache were removed; the engine was empty again. The amd64 image
was then built under Rosetta in the same guest on tree
`09f1d09270c8b811ad3fa4d80f3064ddaeee3d9a` (image ID
`sha256:2bf273c79ff358cc9bbfd578676f1c5dd193b02acf280437ca65c64dd418b901`); both
smoke scripts passed with it. Rosetta emulation is not the NAS, and the NAS was
not tested.

### Ubuntu gates

On tree `09f1d09270c8b811ad3fa4d80f3064ddaeee3d9a` in the Ubuntu guest: Ruff,
formatting and mypy passed; backend tests passed 1,613 of 1,614 on tmpfs and
1,612 on the ext4 disk; frontend lint, formatting, types, 1,253 unit tests and
the build passed; 29 of 31 browser tests passed; the sidecar build with
`--skip-ffmpeg`, its smoke and three frozen process tests passed; Rust formatting,
locked Clippy and 133 tests passed. The failures are the guest limits listed in
the handoff: the `linux-arm64` ffmpeg manifest test, the slow frozen discovery
test on ext4, and the two browser tests that need H.264/AAC in Chromium. The
privacy-gate range test that failed with Git 2.43 passes with Git 2.55 and the
PR #42 change.

### macOS gates

On tree `5d042f47095853d3bd359d506b0f4a77290d89b8` in the macOS guest, every
section A step passed except two tests that the repairs below address: one HLS
test and one browser test. The npm, Python and Rust dependency audits report no
findings. The frozen process tests passed 3 of 3 with the bundled sidecar, and
Rust passed 135 tests with the real sidecar. After the repairs, the HLS file
passes 55 tests and the browser test passes 20 of 20 runs. On tree
`84f4c18dca63a90893e2403b6146e56cd760bdce`, which differs from the branch head
only in this paragraph, the full backend suite passed 1,614 tests and all 31
browser tests passed.

### Test repairs

- `test_hls_sessions.py::test_init_follows_an_immediate_far_seek_restart` (from
  main) failed 13 of 30 isolated runs in the macOS guest. Its stub encoder wrote
  the first segment as soon as it started, so on a fast machine the first run was
  complete before the seek. With a lead time before the first segment it passed 30
  of 30 runs, and it fails 3 of 3 runs when the original defect is restored.
- `e2e/replica-discovery.spec.ts` (inherited from the reference) failed 1 of 5
  runs, in two ways. First, the server correctly stops a started media response
  when the source file moves; the test proxy then failed the test instead of
  giving the page a reset connection. Second, the test ran the recovery CLI
  `prepare` before Release; the serving server could still change the store files,
  so activation correctly refused. With both repairs it passed 20 of 20 runs.

### Sustained native session and functional rounds (sections C and D)

The production app was built in the macOS guest from `20c17dac` (desktop
executable SHA-256 `b13ff5a725c29cda6b274684e90cb82cd303e109246ed00c5fa66fcba8563283`,
sidecar launcher `a3571ce725f45185bf71d4b2047f57f007d18625d27f811ef94735be8c94d70a`,
ad-hoc signature, version 0.2.1). Later commits change only tests, Docker scripts
and documents, so the application source of this executable equals the branch
head. It ran from a separate folder with a fresh guest profile and **This
Computer**. Fixtures came from the section B recipe. The guest audio output was
muted at about 06:08; this does not change decoding.

The session ran from 06:01 to 07:04 with checkpoints at 06:01, 06:15, 06:31 and
07:01. It included ten minutes in the background, a guest lock and
sign-in at 06:23–06:25, and idle periods. At every checkpoint, Update status advanced to
completion without a library switch, and direct play (`movie.mp4`), copy-only HLS
(`remux.mkv`) and transcoded HLS (`fallback.avi`) showed decoded frames in
full-resolution captures, not only an advancing clock. Pause, keyboard seek,
external captions, local resume ("Resumed at"), the PNG and the TIFF preview
worked. A saved note persisted across library switches at each checkpoint.
The stale Update status and the black video of the first long session on the
original machine did not occur.

- Round 1. Create in a folder with media and no Cairndex package wrote format
  three and left the source bytes unchanged; Open refused the old package without a change; the
  portable package opened; an empty second library stayed independent. A
  passphrase was set; Lock refused content; a wrong passphrase was refused with
  HTTP 401 and the correct one unlocked. A snapshot was created and verified;
  preparation was possible only after Release; the review, inspection, activation
  and Reopen passed. The new generation kept the bundle, its two files, their IDs
  and the cover; the original store files remained; the passphrase stayed on.
- Round 2. Update and a reviewed accept created one two-file bundle. After an
  external rename, Update repaired one link: only the relative path changed and
  the file ID stayed. After the name was restored, Update repaired it again and
  every catalog path equalled the first record. No duplicate bundle appeared.
  Interruption, cancellation and exact retry are covered by the process tests.
- Round 3. Search found the one matching bundle; rating filters returned the
  correct populations (none, all three, the two 3½-star bundles); clearing
  restored all bundles. The three layouts and a two-bundle selection with the bulk
  editor worked. File Browser listed only the library root. A tag membership was
  applied while an unsaved note draft existed; the draft stayed, did not appear
  in another library, and survived a switch.
- Round 4. See the session results above. Library switching was exercised at each
  checkpoint. After Quit, no app or sidecar process remained and all three binding
  locks were free. After a restart, the saved note, rating and tag membership were
  present, local resume continued at the saved position with decoded frames, and
  the protected library asked for its passphrase again. Connecting to a second,
  empty loopback test server showed "No libraries"; switching back to This
  Computer showed the original libraries again.

After the session, all 34 fixture files outside `.cairndex/` and the old-format
package had their original hashes.

Minor observations from these rounds, none blocking:

- In transcoded HLS playback (`fallback.avi`), Space three times moved the
  playhead instead of pausing: once to an older saved position (about 12 s) and
  twice to the end, which advanced to the next item. Each time, Space came soon
  after the viewer opened or switched to that file with a saved resume position.
  In other trials, Space and `k` paused the same file correctly, also after a
  click on its list entry. Direct play and copy-only HLS did not show it. The
  cause is not established.
- The rating filter counts exact values only. The synthetic bundle rated 2.25
  is in no bucket of the popover, and "= 2" returns no bundle. "= 3½" returned
  and counted the two 3½-star bundles correctly.
- A filter with no result shows "Update the library or add files to see
  bundles", which does not describe a filter result.
- In the recovery panel, Inspect removes the review confirmation, and the only
  visible way back is to prepare again. The access and backup controls are in a
  short inner scroll area of the library dialog.

### Open observations

These come from reference code that the extraction did not change. They need an
owner decision; no product code was changed for them.

- Update throughput. The replica worker runs one exchange per library each second,
  and each discovery phase handles at most 32 entries in one tick. In the slow
  frozen test the sidecar used about 5 s of CPU in 43 s; the Update phase alone
  took 27–29 s on tmpfs and more than 60 s on the Ubuntu ext4 disk, where the
  fsync cost of each batch adds to each tick. The walk phase alone therefore needs
  at least about 52 minutes for 100,000 files. A worker that continues while work
  remains, and sleeps only when idle, would remove the idle waits; it needs a
  fairness check against HTTP writes.
- Same-device recovery after an Update. The exchange records `sources` rows for
  its own published objects one tick after publication. A snapshot taken before
  that tick lacks the rows, and a later recovery onto the still-valid original is
  blocked by the gap check, which compares those rows by name. The prepared
  candidate contains the same objects under recovery source names.
- The recovery CLI `prepare` does not require Release or take the binding lock.
  The API does. Activation still refuses when the original changed.
- When the server stops a media response for a moved source, it logs an
  "Exception in ASGI application" traceback for an intended stop.

## Limits and next step

The platform gates, Docker checks, the sustained native session and the four
functional rounds are complete on synthetic data in the test guests. No scripted
owner test is required. PR #45 merged the branch on 2026-10-10 (merge commit
`cbf1643d`). The next step is the owner's decision on the open observations
above. Source operations/SMB and deployment/distribution
remain separate groups. No real conversion, registration or replacement is approved.
`CONVERSION_AVAILABLE = False`; there is no owner conversion command.

Cross-device iCloud, offline delivery, hydration and provider conflicts need two
accessible endpoints and disposable synchronized roots. Local two-process tests
are not provider qualification. There is no new SMB/Keychain evidence. OS drag is
incomplete and paused. Folder pagination, Recently Used, file note/source UI,
cross-device resume, owner-media playback diagnosis and production registration
repair remain deferred. Scale and power-loss guarantees are not established.
There is one ordinary library concept.
