# Project status

## Current checkpoint

The local desktop and web test installation is `35310a1`, qualified on
2026-11-09. A file copy publishes its own upload or snapshot instead of copying
it a second time and keeps no duplicate (ADR-0042); Trash offers **Delete Kept
Copies…** for the duplicates earlier builds kept. The copy dialog marks folders
it will create as “new folder”. Update's file changes list each changed file with its folder and
kind, and settle each with one action that checks the whole file when needed,
prepares the review and accepts it. Large files copied in by Cairndex stay
confirmed after their share is mounted again, through samples recorded at copy
time. It lays out Network
Share Access as a compact confirmation. It asks for network-share access before a file task's first step,
stops a task at its first failed step, reports why a refused upload stopped,
and counts and lays out the activity card as described in the changelog. It is
signed by a new local signer in the build VM's login Keychain, so the owner's
Mac asks once more for network-volume and share-login access. It includes one-move Rename/Move/Put Back/Undo with reused SMB
mapping proofs, ⌘Z for the latest operation's Undo, the **Make new bundle**
label, faster network-share Rename/Trash/Put Back, folder
suggestions and New Folder in the incoming dialog, title-only grouping headings,
a persistent local app signature, copy-free same-volume Rename, Move and Trash
(ADR-0041), operation feedback/retry fixes, contextual conflict review, album file actions, retained autosave
acknowledgements, and SMB access preparation when enabling
Write Mode, open-bundle incoming drops, exclusive file/bundle inspectors,
inline name rejection, compact copy throughput/progress,
inline New Folder naming, source-write network access
recovery, incoming-files dialogs and background tasks on top of
the merged historical audit, latest-Update acceptance, Widen title repair and
SMB source-read improvement. This is an owner-test installation, not a release.
Rollback copies and private profiles are preserved. Incoming-files remains
unmerged pending the owner's step-by-step acceptance.

[PR #130](https://github.com/allpan3/Cairndex/pull/130) merged the qualified audit
fixes and privacy correction into main after all required hosted checks passed.
[PR #131](https://github.com/allpan3/Cairndex/pull/131) merged the separate SMB
source-read change after all six required checks and the full hosted CI passed.

The incoming-files branch is backed up remotely. Its combined test build is
installed; owner testing is the remaining merge checkpoint. Original local
branches and unfinished worktree edits remain untouched. No release is authorized.

## Implementation and decisions

Normal Create uses portable libraries under
[ADR-0035](adr/0035-portable-library-format.md). Immutable metadata history lives
in the library; working databases, drafts, jobs, access settings and derived
caches are private to each server. Initial preparation can therefore be needed
on a new server even when the library already exists. Later Update scans are
incremental. See [discovery](replica-discovery.md) for phases and measurements.

[Reviewed conversion](replica-migration.md) retains old metadata and leaves media
untouched. Source Copy, Rename, Move, Replace, Trash, New Folder and conditional Undo require
explicit per-library and deployment permission and a journaled operation.
Collection membership never moves source files. The
[source-operation record](source-operations-extraction.md) retains qualification
and recovery boundaries.

The audit restores hierarchical tag, collection and moment pickers; shared
memberships for multi-selection; narrow-window File Browser controls; Locate
on the selected file; stable hover scrubbing; and grouping review spacing.
It also batches catalog, metadata and Update work. Write Mode immediately
enables reviewed Rename. Review opens the latest completed Update while keeping
older edited drafts available. Widen preserves subject names under collections.
See [owner findings](restoration-audit.md#owner-testing-findings-november-2026),
[catalog behavior](replica-catalog.md) and [file operations](file-operations.md).

macOS SQLite writers retain FULL synchronous and both fullfsync flags.
[ADR-0039](adr/0039-macos-sqlite-durability.md) records the durability decision;
[storage measurements](development.md#macos-sqlite-durability) record its cost.
Batching must preserve durability, source validation and repair safeguards.
Do not restore cross-device metadata reuse as a shortcut for SMB remounts.

Bundle inspector autosave and Write Mode access preparation are installed
from the incoming-files branch. Ordinary scalar edits retain their causal request
and save after a short pause or field exit; uncertain replies retry that exact
request. Conflict review remains explicit. Enabling Write Mode verifies the
mounted-SMB saved login before reporting success. The macOS package uses
a persistent sidecar signing identity; one approval can be required when moving
from the former ad-hoc signer. Two different synthetic executables verified
Keychain access in fresh processes without prompting, but only for an item the
executable created in a disposable Keychain. For the owner's Finder-saved share
login, macOS's partition list records the self-signed sidecar by code hash, so
each rebuilt sidecar asks once (2026-11-08). File tasks now ask before their
first step; an Apple-issued signing identity is the owner decision that would
remove the request. Actual owner-share access remains an owner check. Existing conflict alternatives are preserved.
Album file menus now include Open, Locate in File Browser, and gated Rename/Trash;
the selected file inspector also supports filename editing. Ordinary conflicts
open in a compact dialog with readable alternatives. Structural conflicts retain
full review. Confirmed saves survive inspector remounts, and explicit conflict
choices advance only their covered local drafts.

## Work awaiting consolidation

Original branches remain available as local implementation and evidence records.
The prepared stack keeps the audit fixes and privacy correction together,
followed by the separate SMB and incoming-files changes. Application runtime
files match the tested audit and installed SMB snapshots; the incoming application
tree matches a merge of the original branches. Audit and SMB are merged;
incoming-files now includes main and stays unmerged for owner testing.

| Scope | Original branch | Prepared branch |
| --- | --- | --- |
| Audit, metadata, Update, Rename, Accept and Widen | `fix/audit-build-owner-findings` | `prepare/audit-owner-findings` |
| Unique SMB scanner implementation and measurements | `fix/smb-reconnect-update` | `prepare/smb-reconnect-update` |
| Incoming-only workflow after both prior scopes | `fix/incoming-copy-dialog` | `prepare/incoming-copy-dialog` |

The incoming branch adds background copies, bundle-aware drops, per-action menus,
Library-only Write Mode and Trash. Immediate Apply uses the exact prepared
receipt; Enter confirms Rename. Undo for a bundled copy trashes its files and
removes the task-created bundle. Replace bundling has no Undo. The old storage
budget, saved-draft and recent-operation panels are removed; the default budget
remains. Waiting operations cover only the newest page. Native-drop Move remains
deferred. New Folder is installed with journaled creation and conditional Undo.
It uses an inline row with Untitled selected; Enter or clicking outside confirms,
and Escape cancels. A folder request on the owner's network library completed
after saved-login authorization. The installed fix exposes source-worker
authorization failures through the existing Allow Access notice and retains
the intent for explicit retry. See its source-operation documentation.

Copy performance and activity UI follow-up is installed from the incoming branch.
It batches upload writes, removes a redundant retained copy and throttles
progress-only commits. Collision cancellation persists. macOS passed 108 source
cases. Linux passed 2,071 memory and 81 disk cases, then 19 final upload/API cases
covering the last cancellation and immutable-upload guards. Both platforms passed
1,443 frontend units, static checks, production web builds and four affected
browser scenarios (two passed initially; two passed after correcting test setup).
Synthetic screenshots were inspected. Sidecar smoke, four frozen integrations,
app-only build, signature/distribution and installed desktop/web checks passed.
Component measurements and the full-SMB publication qualification limit are in [file operations](file-operations.md).
Owner-NAS timing remains open; no Finder-parity claim is made.

The naming/activity correction is installed on desktop and web.
Rename and New Folder keep occupied names editable with a short adjacent error;
no retry/recovery card appears for an unstarted naming collision, including old
saved rejections. Actual interrupted writes retain recovery. Copy progress floats
in a compact bottom-right card without shifting the toolbar or grid. macOS passed
all 1,447 frontend units, lint/format/type checks, production build and four
source/Rename browser scenarios. Synthetic narrow-window error and copy-progress
screenshots were inspected. Backend, Rust, Linux and frozen-integration evidence
is retained for unchanged sources; no backend/API/dependency change is included.
Finder was checked with disposable synthetic folders: it rejects the occupied
name with a short message and an OK button. The correction keeps that refusal
beside the editor, with Escape to abandon the name. The app-only package,
sidecar smoke, signature/distribution and installed desktop/web identity, health,
production page and shutdown checks passed. Installed app bytes, modes and
symlinks match the qualified package. A stopped-profile snapshot confirms private
file names, modes, sizes and modification times survived installation and smoke;
credentials were untouched. Rollback and receipts are retained locally under
`20261105-inline-name-errors`. The branch remains unmerged for owner acceptance.

The album inspector follow-up is installed on desktop and web.
A selected album file shows file details only; clearing selection restores bundle
metadata and its unsaved draft. Locate, viewer return and selection changes use
the same behavior. Naming conflicts now say “This name is already in use.”
macOS passed 1,447 frontend units, lint/format/types, production build and six
album/source/Rename browser cases. The synthetic inspector screenshot was checked.
Backend, Rust, Linux and frozen-integration evidence is retained for unchanged
sources; this follow-up changes no backend contract or dependency. App-only
packaging, sidecar smoke, signature/distribution and installed desktop/web checks
passed. The stopped-profile comparison confirms unchanged private file names,
modes, sizes and modification times; credentials remain untouched. Rollback and
local receipts are retained under `20261106-album-inspector`. Owner acceptance
remains the merge checkpoint.

Open-bundle incoming drops are installed on desktop and web. Drops and
Add Files target the open bundle; the first ordered file's parent (or directory
member) supplies the editable folder suggestion. Empty bundles use the remembered
folder, and a manual choice wins over a late suggestion. macOS passed all 1,453
frontend units, lint/format/types, production build and five album/source browser
cases. The synthetic dialog screenshot was inspected. Backend, Rust, Linux and
frozen-integration evidence is retained for unchanged sources; no backend contract
or dependency changed. App-only packaging, sidecar smoke, signature/distribution
and installed desktop/web identity, health and shutdown checks passed. Installed
application bytes match the package; stopped private profiles retain identical
files, modes, sizes and modification times. Credentials were untouched. Rollback
and local receipts are retained under `20261106-open-bundle-drop`. The branch
remains unmerged for owner acceptance.

## Qualification and evidence

These results qualify the named snapshots. The latest New Folder installation
includes a full Linux backend run and focused macOS source-operation checks.

| Snapshot | Qualification |
| --- | --- |
| Installed one-write copies and Delete Kept Copies | macOS full backend 2,221 cases and full frontend gate with 1,490 units; on the disposable Samba share, 12 of 14 upload cases including publication by move, refusal of a changed upload, resume after an interrupted move and kept-copy deletion with Undo (the two remount cases fail identically without this change, because their simulated remount does not apply to a real mount); signed app-only package with sidecar smoke, four frozen integrations, distribution, installed signature and embedded commit. The 1 GiB test-share measurement is in ADR-0042. Copy time and kept-copy deletion on the owner's NAS remain owner checks |
| Installed file-changes pane | macOS full frontend gate with 1,489 units on the packaged commit, including the one-action verify/prepare/accept unit test; discovery browser spec 4 of 4 and grouping browser specs 6 of 6; a synthetic library with two ambiguous moves and three unconfirmed files (one 600 MB) screenshotted at desktop and phone width, with Check and Restore reading, restoring and leaving the list; signed app-only package with sidecar smoke, four frozen integrations, distribution, installed signature and embedded commit. Restoring the owner's pre-fix copies on the NAS remains an owner check |
| Installed copied-file samples across remounts | Disposable Samba share: an 8 MiB copy recorded its samples; after a remount changed `st_dev`, the content check passed and Update raised no file-change candidates. Host: 285 related backend cases (two more need host ffmpeg); macOS: backend lint/format/mypy and 92 focused discovery, verification, upload and SMB cases including both ffmpeg cases; signed app-only package with its full frontend gate, sidecar smoke, four frozen integrations, distribution, installed signature and embedded commit |
| Installed compact share-access dialog and unconfirmed-content wording | Disposable Samba share: a 1 MiB copy kept its generation while mounted for 31 s; one remount changed only `st_dev` and raised the old warning. Host: 107 related backend cases (one more needs host ffmpeg and fails identically without the change) with ruff/format/mypy on the changed files; macOS full frontend gate with 1,488 units, source-operation browser spec 5 of 5 and the synthetic dialog screenshot inspected; signed app-only package with sidecar smoke, four frozen integrations, distribution, installed signature and embedded commit |
| Installed share-access preflight and stopped-task card | macOS 135 focused source/SMB/write-mode/conversion backend cases with lint/format/mypy; the full host backend run's 59 failures and errors were all missing host ffmpeg/ffprobe or the packaged binary, none in changed files; full frontend gate with 1,488 units; source-operation browser spec 5 of 5 (one test-server startup failure passed on two reruns) with the stopped-card screenshot inspected; signed app-only package with the new login-Keychain signer, sidecar smoke, four frozen integrations, distribution, installed signature and embedded commit. The macOS Keychain request and copy flow on the owner's NAS remain owner checks |
| Installed one-move relocation and ⌘Z | Linux 2,039 backend cases plus 172 disk-backed source/file cases, with the one known ARM manifest case deselected; backend lint/format/mypy on both platforms; macOS 193 focused source/SMB cases; full frontend gate with 1,485 units in packaging, including the ⌘Z hook test; source-operation and grouping browser specs, with the drop scenario failing 2 of 11 runs on a proxy connection reset that names no assertion; disposable Samba Rename 0.35–0.37 s, Put Back 0.32–0.40 s, Undo 0.25–0.34 s, Trash 0.58–0.79 s and Empty Trash 0.85 s with a fresh connection per step, zero copies and preserved identity; signed app-only package with the persistent app signer, sidecar smoke, four frozen integrations, distribution, installed sidecar smoke and profile preservation |
| Installed network-share speed, folder suggestion and grouping headings | Linux 57 SMB/signing backend cases; macOS backend lint/format/mypy, 119 focused backend cases and the full frontend gate with 1,484 units on the packaged commit; source-operation and grouping-section browser specs (one known teardown flake passed on rerun); synthetic new-folder and grouping screenshots inspected; disposable Samba Rename/Trash/Put Back/Undo/Empty Trash at 1 MiB and 512 MiB in 0.8–1.2 s per step; signed app-only package with the persistent app signer, sidecar smoke, four frozen integrations, distribution, installed sidecar smoke and profile preservation |
| Installed same-volume original operations | Linux 2,061 memory plus 110 disk backend cases after one test update (the old Undo-race setup queued a second recovery that the new admission guard refuses); macOS backend lint/format/mypy and 97 focused SMB/source/write-mode cases; full frontend gate with 1,479 units; disposable Samba Rename/Trash/Put Back/Undo/Empty Trash at 1 MiB and 512 MiB; signed app-only package, sidecar smoke, four frozen integrations, persistent signature/distribution, installed sidecar smoke and profile preservation. The source-operation browser spec was not rerun after the final backend changes |
| Uninstalled file-operation feedback/retry fixes | macOS 264 source/SMB/catalog backend cases; backend lint/format/mypy; full frontend gate with 1,474 units, then 11 naming-hook cases including the added refresh-order regression and a strengthened backend draft no-write case; seven source/conflict/draft browser scenarios; synthetic activity/access screenshots inspected. Whole backend suite, Linux, real SMB reconnect/large-file timing and packaging deferred until the recovery design is settled |
| Installed album actions and contextual conflict review | macOS full frontend gate with 1,471 units; 19 of 20 broader browser cases initially passed, then the corrected full-review case and both affected album/conflict cases passed on final source; synthetic screenshots inspected; signed app-only package, sidecar smoke, persistent signature/distribution and installed desktop/web checks passed. Backend, Rust, Linux and frozen-integration evidence retained for unchanged source areas |
| Installed autosave and Write Mode access | Linux 2,078 bulk cases passed with the known ARM manifest failure, plus 81 disk cases passed; backend static checks on both platforms, macOS 35 focused backend and 64 packaging/manifest cases; 1,463 frontend units, full frontend gate, 20 of 21 initial browser cases followed by five affected final-source cases and three inspector repeats passing; signed app-only package, sidecar smoke, five frozen cases across four integration modules, distribution and installed desktop/web checks |
| Audit metadata follow-up | macOS 2,089 backend cases; Linux 2,088; both platforms 1,422 web units, 67 browser cases, static checks, web builds and four frozen integrations |
| Latest-Update Accept | macOS full frontend gate with 1,432 units; ten selected browser cases on each platform |
| Widen | Linux 2,042 memory plus 55 disk backend cases; both-platform backend static checks; three new backend regressions; six macOS grouping browser cases and the new Linux browser case |
| SMB before Widen incorporation | Linux 2,054 memory plus 55 disk backend cases; 20 focused SMB cases per platform; macOS 280 broader source/discovery/recovery cases; static checks on both platforms |
| Installed combined audit/SMB | Linux 86 backend cases, macOS three Widen cases, 11 selected browser cases per platform; sidecar smoke, four frozen integrations, app-only build, signature and distribution checks |
| Incoming branch alone | macOS full frontend gate with 1,439 units, production build and 26 browser cases |
| Installed incoming combination | Full frontend gates with 1,439 units and 14 combined browser cases on each platform; production web/app-only builds, sidecar smoke, four frozen integrations, signature/distribution and installed identity/startup/shutdown checks |
| Installed New Folder follow-up | Linux 2,061 memory plus 77 disk backend cases; macOS 91 source-operation cases; both-platform backend static and full frontend gates with 1,439 units, seven browser cases per platform; packaged New Folder/Undo smoke, four frozen integrations, app-only build, signature/distribution and installed desktop/web checks |
| Installed inline naming follow-up | macOS full frontend gate with 1,439 units and four source/Rename browser cases; synthetic screenshot inspected; app-only build, sidecar smoke, signature/distribution and installed desktop/web checks. Backend, Rust, Linux and frozen-integration evidence retained for unchanged source areas |
| Installed source-access recovery | Linux 2,063 memory plus 81 disk backend cases; macOS 90 source/API/exchange/Keychain cases; backend static checks on both platforms; sidecar smoke, four frozen integrations, app-only build, signature/distribution and installed desktop/web checks. Frontend and Rust evidence retained for unchanged sources |

The album/conflict round corrected an effect that returned the browser’s scroll
Promise as React cleanup. The failed browser attempt remains retained. Final
source passed the affected cases. Installed application bytes, modes and symlinks
match the qualified package; the stopped-profile comparison confirms unchanged
private file names, modes, sizes and modification times. Credentials were untouched.
Rollback and local receipts are retained under `20261106-album-conflicts`.

The autosave round retained one transient inspector tag re-add failure; its
standalone recheck and three subsequent repeats passed. The initial package
attempt stopped at the source-freshness preflight after integration tests created
Python caches; building the app before those tests passed without changing the
gate. Failed attempts remain in local receipts under `20261106-autosave-access`.
Installed bytes match the qualified package and stopped private profiles retain
identical files, modes, sizes and modification times. Credentials were untouched.

Earlier full Linux backend runs retain the known ARM manifest exclusion, covered by
hosted x86 CI. Unchanged Rust, dependency and frontend gates were retained where
applicable; these are not fresh whole-suite combined runs. Docker checks were
not repeated for changes that left deployment sources unchanged. DMG creation
failed during the Rename round; the later combined round qualified an app-only
package and did not rerun DMG creation.

Installed desktop/web identity, health, startup and shutdown checks passed using
disposable private data. Package bytes, modes and symlinks matched. Earlier
installations retained private-file names, modes, sizes and modification times;
the earlier copy-progress shutdown comparison is qualified below. Credentials were untouched. Receipts are retained locally under
`20261105-copy-progress`, `20261105-folder-access`, `20261105-inline-folder`, `20261105-new-folder`, `20261105-incoming-files`, `20261104-smb-update-combined` and
`20261104-widen-title`. The local testing
checklist records rollback and installation details. Do not publish private
receipt contents wholesale. Failed attempts remain evidence, not passing gates. The copy
installation's initial snapshot preceded graceful app shutdown: two settings/window
records and transient SQLite files changed, while ordinary database-file metadata
was unchanged. The subsequent installed smoke used disposable data and preserved
the stopped private profile exactly. Both snapshots and the failed initial
comparison are retained; the initial comparison is not counted as a pass.

The established synthetic 8,911-file library's unchanged Update fell from
26.453–27.396 seconds to 4.228–4.896 seconds. Ten additions took 5.288 seconds,
with review ready at 6.929 seconds. See the
[Update measurement record](replica-discovery.md#established-library-update-timing).
Six alternating disposable SMB cold-remount worker runs took 19.545–20.436 seconds
before and 2.431–2.638 seconds after, with equal evidence and bounded concurrency.
A same-size server edit with restored mtime was detected after remount. The SMB
measurement excludes scheduling, history exchange, UI polling and probing; it
is not an owner-NAS or full-UI Update benchmark.

## Remaining limits and next steps

- Owner decision (2026-11-09, ADR-0042): file copies publish their own version.
  Delete Kept Copies covers completed copies only. Copy-based Rename and Trash
  versions from before ADR-0041 still have no deletion action; Undo of those
  operations needs them. The two simulated-remount upload tests do not apply
  to a real SMB mount and need a real-remount variant. Next: running the server
  in Docker on the NAS, after the macOS checks, then the Eagle-style items.
- Owner decision (2026-11-08): a file copied in by Cairndex records a complete
  SHA-256. Mounting its share again changes the device number of every file there,
  and so its generation, while inode, size and mtime stay (measured on the
  disposable Samba share). Files over 192 KiB were then seen only through samples,
  so playback and the inspector refused them and Update raised verification
  candidates after every remount. Copies now also record their samples, and a
  same-path file whose samples, inode and mtime are unchanged keeps its complete
  hash ([replica discovery](replica-discovery.md#evidence-and-limits)). Copies
  made before this change need one Check and Restore in Update's file changes.
  The refusal still answers as "not found"; a distinct unconfirmed state would
  change the local-media API and is not built.
- The owner accepted ADR-0041. The installed build implements journaled
  same-volume original relocation for Rename/Move/Trash, conditional Put Back/Undo
  and confirmed Empty Trash. Copy/Replace and existing journals retain independent
  recovery copies. Metadata exchange uses a separate lock from source work, and
  final original-file observations run outside the database writer transaction.
  Permission grants survive transient reconnects in process memory and are revoked
  on access changes/closure; pending Keychain requests are coalesced.
- Local macOS qualification includes 22 original-operation cases (including a
  512 MiB zero-content-read regression), focused source/worker/credential checks,
  five source-operation browser cases and the final Trash browser check. The final
  frontend gate passes with 1,479 units; backend lint, format and mypy pass.
- A disposable Samba share mounted through smbfs (relayed into the macOS guest)
  qualified Rename, Trash, Put Back, Undo, Trash again and Empty Trash at 1 MiB and
  512 MiB: every step succeeded in 0.7–3.2 s independent of size, with zero source
  reads and no Keychain reread across forced reconnects. Most of that time was
  smbfs keeping a cached absence for about 2 s after each direct SMB move; a probe
  file in the target folder now clears it, and each step takes 0.8–1.2 s. The
  remainder is safety checks: about 117 mount lookups, 369 direct SMB round trips
  and 21 synchronous database commits per Rename. The owner then approved one
  move per relocation (ADR-0041 amendment): Rename, Move, Put Back and Undo no
  longer pass through or claim the operation directory, and mapping proofs are
  reused per mount and directory object. Rename now takes about 0.35 s there.
  The share first exposed a mounted
  visibility defect: after a direct SMB create or rename, an open through the mount
  could fail with ENOENT indefinitely. A stat by name now precedes such opens
  (ADR-0037). These are source results, not an installation or owner-NAS
  performance claim; timing uses an injected disposable credential and does not
  qualify packaged credential access.
- The earlier feedback/retry fixes (activity wrapping, permission popup, duplicate
  admission, rename refresh ordering, no repeated acknowledged draft writes) are
  installed with it. Owner-NAS timing and the packaged Keychain prompt remain
  unverified. The local app is now re-signed with the persistent build
  certificate, so macOS privacy approvals such as Network Volumes survive later
  local builds; the first launch of this build asks once more. No PR, merge or release is authorized for this follow-up; owner
  acceptance remains required.

- The owner approved correcting the two verified privacy false positives: a
  generic temporary-directory prefix in the local profile and a literal inside
  a fixed public signing key. Actual private values remain protected. Repeat
  publication audits before each push. All 25 privacy-gate tests, focused lint,
  format and mypy checks pass in the Linux guest; the corrected whole-history
  scan passes with all actual private literals retained. Required hosted checks
  also passed on both audit and SMB merge heads.
- Test incoming-files one workflow at a time, now beginning with right-click →
  New Folder in File Browser with Write Mode enabled. Keep its branch unmerged
  until owner acceptance. Combined automated checks and local installation
  passed; native Finder-drop delivery and interaction quality remain owner
  checks. Rust source is unchanged, so its existing gates were retained.
- Complete owner acceptance and representative NAS/media timing. Synthetic
  measurements do not establish large-library readiness on the owner's storage.
- Provider/cloud delivery, offline delivery, hydration, conflicts, large-scale use
  and physical power-loss safety remain unqualified. Do not downgrade private
  stores after the derived search-layout replacement.
- File Browser folder pagination, file note/source UI, cross-device resume,
  owner-media playback diagnosis and production registration repair remain
  deferred. [The restoration audit](restoration-audit.md) records the boundaries.
- Release tags and production deployment remain separate owner-triggered actions.

Update these sections when state changes. Keep durable design and measurements
in topic documents, and use Git history for superseded status. Do not append
completed checkpoint diaries or copy them into a new archive.
