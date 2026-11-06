# Project status

## Current checkpoint

The local desktop and web test installation is `074a71f0`, qualified on
2026-11-06. It includes open-bundle incoming drops, exclusive file/bundle inspectors, inline name rejection, compact copy throughput/progress,
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

The full Linux backend runs retain the known ARM manifest exclusion, covered by
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
