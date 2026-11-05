# Project status

## Current checkpoint

The local desktop and web test installation is `1980d16c`, qualified on
2026-11-04. It includes the historical UI audit, latest-Update acceptance,
Widen title repair and SMB source-read improvement. This is an owner-test
installation, not a published release. Rollback copies and private profiles
are preserved. Owner acceptance remains a release checkpoint.

The incoming-files redesign is on a separate branch. It is not installed and
has not been qualified together with the installed changes. The branches below
are unpushed; consolidation and publication checks are in progress.

## Implementation and decisions

Normal Create uses portable libraries under
[ADR-0035](adr/0035-portable-library-format.md). Immutable metadata history lives
in the library; working databases, drafts, jobs, access settings and derived
caches are private to each server. Initial preparation can therefore be needed
on a new server even when the library already exists. Later Update scans are
incremental. See [discovery](replica-discovery.md) for phases and measurements.

[Reviewed conversion](replica-migration.md) retains old metadata and leaves media
untouched. Source Copy, Rename, Move, Replace, Trash and conditional Undo require
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
Prepare dependent PRs in this order, without merging duplicate checkpoint history.

| Scope | Original branch | Integration boundary |
| --- | --- | --- |
| Audit and owner findings | `fix/audit-build-owner-findings` | UI, metadata, Update, Rename, Accept and Widen fixes |
| SMB source reads | `fix/smb-reconnect-update` | Unique scanner implementation, tests and measurements; omit copied Accept/Widen commits |
| Incoming files | `fix/incoming-copy-dialog` | Apply the incoming-only change after both prior scopes |

The incoming branch adds background copies, bundle-aware drops, per-action menus,
Library-only Write Mode and Trash. Immediate Apply uses the exact prepared
receipt; Enter confirms Rename. Undo for a bundled copy trashes its files and
removes the task-created bundle. Replace bundling has no Undo. The old storage
budget, saved-draft and recent-operation panels are removed; the default budget
remains. Waiting operations cover only the newest page. Native-drop Move and
New Folder remain deferred. See its source-operation documentation for details.

## Qualification and evidence

These results qualify the named snapshots. They do not establish a full-suite
pass for the later three-branch combination.

| Snapshot | Qualification |
| --- | --- |
| Audit metadata follow-up | macOS 2,089 backend cases; Linux 2,088; both platforms 1,422 web units, 67 browser cases, static checks, web builds and four frozen integrations |
| Latest-Update Accept | macOS full frontend gate with 1,432 units; ten selected browser cases on each platform |
| Widen | Linux 2,042 memory plus 55 disk backend cases; both-platform backend static checks; three new backend regressions; six macOS grouping browser cases and the new Linux browser case |
| SMB before Widen incorporation | Linux 2,054 memory plus 55 disk backend cases; 20 focused SMB cases per platform; macOS 280 broader source/discovery/recovery cases; static checks on both platforms |
| Installed combined audit/SMB | Linux 86 backend cases, macOS three Widen cases, 11 selected browser cases per platform; sidecar smoke, four frozen integrations, app-only build, signature and distribution checks |
| Incoming branch alone | macOS full frontend gate with 1,439 units, production build and 26 browser cases; no Linux browser or desktop package qualification for the combination |

The full Linux backend runs retain the known ARM manifest exclusion, covered by
hosted x86 CI. Unchanged Rust, dependency and frontend gates were retained where
applicable; these are not fresh whole-suite combined runs. Docker checks were
not repeated for changes that left deployment sources unchanged. DMG creation
failed during the Rename round; the later combined round qualified an app-only
package and did not rerun DMG creation.

Installed desktop/web identity, health, startup and shutdown checks passed using
disposable private data. Package bytes, modes and symlinks matched. Profiles and
private files retained names, modes, sizes and modification times; credentials
were untouched. Receipts are retained locally under
`20261104-smb-update-combined` and `20261104-widen-title`. The local testing
checklist records rollback and installation details. Do not publish private
receipt contents wholesale. Failed attempts remain evidence, not passing gates.

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

- Complete source-preserving history cleanup, inspect reachable objects and
  publication metadata, and run all required privacy gates before any push or PR.
  A previous literal finding overlaps ordinary signing output; do not weaken
  private patterns or treat a range pass as whole-history clearance.
- Integrate the three scopes in order. Run proportional regression checks after
  the incoming integration and qualify any later combined package before install.
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
