# Portable application extraction

## Scope and state

Branch: `feature/portable-library-lifecycle`, based on merged main `b8d9e3b9`.
Group 1 merged through PR #38. The owner approved one application branch for
former groups 2–5, with separate functional test rounds. The application is
implemented and locally tested. Functional acceptance and merge are pending. Branch publication is authorized
for the [VM handoff](audit-vm-handoff.md).

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
| Docker/deployment | Not run: local Docker daemon unavailable |
| Ubuntu Rust | Not run locally; required before merge |

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

The agent tested application source `4fea9d07` in the primary checkout. The
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

## Limits and next step

The local synthetic functional checkpoint is ready for review. No scripted owner
test is required now. Continue on the separate test machine using the
[VM handoff](audit-vm-handoff.md). Remaining platform gates, application acceptance
and exact PR privacy checks are required before merge. Source operations/SMB and deployment/distribution
remain separate groups. No real conversion, registration or replacement is approved.
`CONVERSION_AVAILABLE = False`; there is no owner conversion command.

Cross-device iCloud, offline delivery, hydration and provider conflicts need two
accessible endpoints and disposable synchronized roots. Local two-process tests
are not provider qualification. There is no new SMB/Keychain evidence. OS drag is
incomplete and paused. Folder pagination, Recently Used, file note/source UI,
cross-device resume, owner-media playback diagnosis and production registration
repair remain deferred. Scale and power-loss guarantees are not established.
There is one ordinary library concept.
