# Replica capability and reversible migration contract

The accepted architecture is [ADR-0029](adr/0029-cloud-metadata-replicas.md).
The package `cairndex.replica-library` supports version 1 with exactly
`bundle_metadata_v1` and version 2 with the complete
[authored catalog capability](replica-catalog.md). Version 3 adds the exact
`discovery_identity_v1` capability under [ADR-0032](adr/0032-replica-discovery.md);
only a fresh disposable fixture can opt in. There is **no conversion endpoint
or owner-library conversion command**. `replicas/inventory.py` sets
`CONVERSION_AVAILABLE = False`. Developer functions create a new disposable legacy
catalog, validate a private conversion checkpoint and export separate rollback
copies. They accept no existing-library path through an application API or CLI.
Their Python fixture dataclass is a developer test boundary, not authentication
or permission to convert an arbitrary library. A handwritten descriptor is not a
conversion receipt.

## Storage and wire contract

The package contains `.cairndex/manifest.json` and immutable objects under
`.cairndex/replica/objects/<two hex digits>/<event hash>.json`. The descriptor pins
library ID, epoch, genesis hash, format and capabilities. It contains no DB path.
In protocol one, each transaction is one bounded canonical JSON envelope `{sha256, body}`. The hash
covers its body, which includes protocol, kind, library, epoch and, for edits,
replica, operation, bundle and field changes. Each field change carries its full
value and a required nonempty `basis` list of observed revision hashes. Neither
clock time nor provider filenames establish causality. Unknown schema blocks
new edits; truncated/corrupt objects wait without replacing validated content.

This first wire revision intentionally combines the prototype's manifest and
payload into one envelope. Maximum envelope size is 256 KiB; the complete seed has
at most 100 bundles; each field has at most 128 active revisions. Notes are one
**whole ordered-list conflict unit**, preserving duplicates, whitespace and order.
A notes choice replaces that list and never claims to merge individual notes.
Protocol two uses separate capabilities and the complete conflict units described
in [the catalog mapping](replica-catalog.md). Its roots validate linked payloads
before activation; the protocol-one 100-bundle limit does not apply.

`CAIRNDEX_DATA_DIR/replicas/<library UUID>/replica.db` holds private SQLite/WAL,
immutable event bytes, field revisions/projection, inbox/outbox receipts and drafts.
The data directory must be outside all provider synchronization trees. The app
rejects storage inside the library and detects linked/rebound metadata paths;
it cannot discover every provider's configured synchronization roots. One physical
private store is shared by clients of that server. SQLite serializes transactions;
there is no synchronized active-owner lease. Copying a private DB to make another
replica is unsupported. The [supported recovery command](replica-recovery.md)
verifies a private snapshot, prepares a separate generation with a fresh author,
retains old retry lineage and requires explicit reviewed activation after Release.
Private bindings select the original directory or `generations/<recovery ID>`;
missing bound stores cannot silently reset. Copy only package artifacts when
creating independent synthetic replicas without private recovery.

A save commits archive, projection and outbox atomically before acknowledging local
durability. Stable operation IDs retry the same intent. Imports validate all basis
revisions before changing any field; disjoint fields merge independently. Conflicts
retain the last good local display and every candidate. Resolution consumes exactly
the current reviewed field basis and retains rejected revisions. History is paged
in stable hash order, not chronological order. Restoring a value is an explicit new
save. Private drafts retain their original basis; delayed draft writes cannot
resurrect a dismissed revision. Browser drafts are connection/library/editor scoped.

Exchange discovers at most 32 directory entries per tick, then imports, publishes
and checks missing authored artifacts in separate batches of at most 32. Indexed
field lookups update only affected projection rows; reads/saves do not replay the
entire history. Publication writes/fsyncs a temporary file and creates the final
name using an atomic link that refuses replacement, then removes the temporary
name and fsyncs the directory. A crash may leave ignored temporary files; receipt
retries use identical bytes. Missing authored objects are repaired from the private
archive; changed objects require recovery. This local primitive requires POSIX
`dir_fd`, no-follow directory access and hard links (currently macOS/Linux).
Unsupported filesystems report exchange failure while retaining private saves.
Windows and real provider placeholder behavior are not qualified.

Release drains this server's admitted work and retains its private history/drafts;
Reopen resumes local access. Every ordinary request and each background exchange
revalidates package identity. Legacy SQL sessions, heartbeats, takeover publication
and release also recheck capability before trusting cached ownership. These checks
add small manifest reads to legacy operations; NAS latency has not been profiled.
Legacy packages retain their existing DB, lease and
write-mode gates. Replica packages cannot enter legacy catalog mutations, source
operations, passphrase mutation, takeover or legacy scan/probe/cache paths.
Format-two catalogs expose an allowlisted local-media adapter for indexed files,
private probes/derivatives, direct/HLS playback and device-local resume. It does not
open a legacy content DB or publish observations. See [local media](replica-catalog.md#local-media).
The shared app shows the capable metadata workflow, library navigation, conflicts,
retained versions and draft recovery. It distinguishes local save, queued exchange,
unverified delivery and upgrade/recovery failure. Peer delivery remains unknown.

## Exhaustive durable-field inventory

[`replicas/inventory.py`](../apps/server/src/cairndex/replicas/inventory.py) pins the
exact table and column set, including the attached grouping-plan schema. A test
compares it to every SQLAlchemy content table and fails on new, missing or duplicate
columns. All raw rows, including observation/recovery categories, belong in the
private legacy archive. Classification specifies active authored representation,
never permission to drop archived data.

| Family | Preserved data and representation | Conflict/validation requirement |
| --- | --- | --- |
| `asset_bundles` | IDs, title, ordered notes, rating, covers/primary file, opaque extra metadata, manual order, confirmed grouping provenance, timestamps and version; last-opened is an observation | Scalars independent; notes whole-list; cover/file and grouping references valid against lifetime |
| `asset_files` | Stable IDs, bundle membership, relative paths, original/display names, note/source, role/sequence, cover time, timestamps/version; technical/availability/fingerprint/inode fields archived as observations | Per-file scalar units; path/identity collisions explicit; membership and order atomic; no source-media writes |
| `bundle_directory_members` | Directory-member IDs, bundle, relative directory, sequence, created time | Membership/order complete together; root/path validation |
| `moments`, `moment_tags` | IDs, bundle/file references, start/end, comments, timestamps/version and tag membership | Span atomic, valid references/lifetimes; no partial delete/reference projection |
| `tags`, `tag_groups`, `tag_group_memberships`, `asset_bundle_tags` | IDs, parent forests, names/colors/order, timestamps/version and all memberships | Validate cycles, parent lifetimes and membership; complete affected structural units |
| `collections`, `asset_bundle_collections` | IDs, forest, names/notes/covers/order, timestamps/version and per-membership sort order | Complete forest/order conflicts; membership never moves source files |
| `smart_folders` | IDs, names, exact filter JSON and version, sort/layout/order, timestamps/version | Versioned allowlisted filter validation; unsupported fields/operators block conversion |
| `subtitle_tracks` | IDs, bundle/video/source references, embedded index, language/label/format, default/forced flags, order and timestamps/version | Preserve authored choices and complete track order; validate references without probing away choices |
| `playback_progress`, `bundle_cursors` | Exact legacy positions/durations/completion, user ID, bundle/file references and timestamps | Preserve private legacy resume snapshot; later per-device hint transport is separate from authored conflict history |
| `file_operations` | Every journal ID, operation, status, payload, error and timestamp | Unresolved intents block conversion; never replay automatically or discard trash/recovery state |
| `plans.grouping_*` | Plan/proposal/file/directory IDs, inputs, parent/target/base relationships, edits, sequence, expansion and lifecycle state | Archive any in-progress work at checkpoint; active plans remain private/disposable under ADR-0022; only confirmed grouping becomes authored metadata |

Unknown columns, tables, JSON keys, schema versions, enum values or relationship
shapes must stop conversion. Opaque supported `extra_metadata` is preserved exactly;
unknown semantics cannot be interpreted as a field to discard. The code inventory
is necessary but insufficient: a future converter must also inspect the actual
SQLite schema, extensions/triggers and external artifacts, then produce a reviewed
mapping report before enabling conversion.

## Non-table state and recovery inventory

| Artifact | Required handling |
| --- | --- |
| Legacy manifest and schema/version markers | Preserve exact bytes and descriptor values; package discriminator changes only after validated activation |
| Library DB, WAL/SHM and rollback journal | Quiesce known writers and use SQLite backup under verified ownership; do not copy only a live DB file; integrity and foreign-key checks required |
| Existing DB backups/snapshots | Retain unchanged outside provider churn with hashes and provenance; mutable snapshot names are not replica events |
| Passphrase hash/configuration and authentication data | Preserve in the private recovery archive; never place credentials in authored events; future access-guard compatibility is a conversion gate |
| Registry registrations, jobs, devices/tokens, endpoints, preferences, release intent | Back up privately; rebuild/rebind runtime state explicitly, never treat credentials or absolute host paths as portable content |
| Active-owner leases, takeover requests, heartbeat and process state | Drain/stop for checkpoint; retain diagnostic evidence privately; never replicate or replay a lease |
| `.cairndex/trash`, journal-referenced files and incomplete source operations | Verify every recovery reference; unresolved operations block conversion; no automatic restore/delete/move |
| Cache, thumbnails, subtitles, storyboards, FTS/aggregate indexes, HLS and exports | Derived state may be rebuilt only after the verified archive preserves any unique input; never seed from derived output alone |
| Grouping-plan files and editor drafts | Capture private drafts/plans before restart; preserve text/basis and distinguish unconfirmed plans from authored grouping |
| Source files, sidecars and directory membership | Inventory relative identities without moving, renaming, overwriting or uploading content; handle unavailable mounts/placeholders explicitly |
| Unknown `.cairndex` artifacts, custom files or prior-app extensions | Stop and classify; never silently skip because the current app does not recognize them |

## Reversible activation and rollback contract

1. The owner explicitly selects a conversion checkpoint. Identify every known
   legacy writer/device and collect its work; drain requests/jobs and verify lease
   authority. An offline writer is not revoked by changing a descriptor.
2. Preserve a private immutable recovery set: complete consistent DB backup, old
   manifest, schema, all categories above and a checksum/count/reference receipt.
   The receipt records IDs, relationships, order, null/empty distinctions, Unicode,
   timestamps, numeric values, opaque metadata and pending recovery decisions.
3. Build the candidate seed/projection privately. Stable bundle/file/moment/tag/
   collection/track IDs survive. Round-trip **every** supported family back to the
   legacy representation and compare values plus relationships exactly. Exercise
   concurrent edits, delete/edit/reference conflicts and recovery for each family.
   Failure leaves the original package authoritative and untouched.
4. Stage immutable seed chunks and their complete dependency manifest in a new
   epoch. Verify hashes and reconstruction on an independent private store before
   making the new descriptor visible. Never partially activate a seed. Unsupported
   old readers must refuse it before opening DB/lease/cache/source mutation paths,
   including cached sessions and startup/maintenance paths.
5. Present the conversion receipt and rollback target for explicit owner activation.
   Preserve the legacy recovery set out of ordinary open paths. Do not delete it,
   compact history, regenerate IDs or alter media as a side effect.
6. Before any new-format edits, rollback restores the verified legacy authority at
   a quiescent checkpoint. After edits, rollback first exports every new event,
   conflict branch and draft and reconciles into a separate legacy recovery copy;
   raw DB replacement is not rollback. Unsupported mappings block rollback with
   the complete new history retained. Returning old-device changes become an
   explicit preserved branch, never an automatic overwrite.
7. Recovery after private-store loss verifies the complete seed and available
   archived events; missing dependencies remain pending. Unpublished events and
   drafts require the private backup. Cloning/restoration must create a fresh
   incarnation before authoring; independent seeds are not shared ancestry.

The [private recovery workflow](replica-recovery.md) executes this private-store
backup/restoration boundary for capable packages. It preserves received drafts,
pending jobs, receipts and media resume data, and blocks incomplete history or
surviving original work absent from the candidate. It does not activate a real
legacy conversion or transplant authentication/registry state.

No real conversion is available until this entire contract is executable and all
families pass round-trip and conflict recovery tests. Provider qualification,
source-write semantics, resume-hint transport, history compaction and server-choice
UX remain separate work. Synthetic local delivery and abrupt process exits prove
only the tested protocol/application boundaries, not provider or power-loss safety.

## Executable disposable checkpoint

`create_disposable()` populates every modeled table, including attached grouping
plans, progress/cursors, completed journal records and synthetic private auth.
`prepare_disposable()` backs up both databases, preserves manifest/auth bytes with
checksums, builds linked artifacts and imports them independently. It exports the
validated projection and compares every original main-table row/cell before writing
the candidate descriptor. The archive and source remain separate and unchanged.

`export_legacy()` creates a separate legacy copy and `replica-recovery.db` containing
all events, rejected branches, drafts, jobs and receipts. After edits, the legacy
view uses the last valid local arrangement and preserves observations for surviving
IDs. Resume rows for removed files remain in the original archive and are omitted
from the reconciled view. This is an export, not in-place rollback or owner activation.
