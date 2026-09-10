# ADR-0029: Private replicas with immutable metadata changes

- Status: **accepted — architecture and first bounded production group approved 2026-09-10**
- Date: 2026-09-10
- Branch: `fix/library-ownership-lifecycle`
- Would amend: ADR-0008 storage authority, ADR-0018 cloud exclusivity/portability,
  ADR-0016 progress portability, and ADR-0021 journal scope for converted libraries
- Implementation status: see `docs/STATUS.md`; prototype evidence is not provider qualification

## Requirement and decision

Two devices must be able to keep their **local cloud-folder replicas open**, edit
without a network or before provider synchronization finishes, and reconcile
later. Keeping one device closed is insufficient. NAS storage is optional. Local
replicas and centrally served libraries are usage scenarios, not required app
modes. Several clients of one server still share one server-owned database;
server ownership does not establish which version each client edited.

**Retain the existing app, API and local sidecar. Give each replica a private
SQLite working database outside the synchronized folder. Exchange immutable,
causally linked metadata transactions through ordinary provider file sync.**
The durable history and complete seed reconstruct authored metadata; the local
DB materializes it for current queries. No live database, WAL, active-owner lease
or mutable “latest library” file is the replication payload.

Disjoint fields combine automatically. Conflicting fields keep all alternatives
until the owner chooses one or writes a replacement. Structural relationships use
larger explicit conflict units. This is a small domain-specific causal protocol,
not whole-library snapshot selection, text merging or a general-purpose CRDT.

| Candidate | Correctness and cost | Disposition |
| --- | --- | --- |
| One authoritative server; other devices connect | Simple shared edits with mandatory stale-edit preconditions; unavailable offline without another protocol | Keep for central access; insufficient alone |
| Private DB + complete immutable library snapshots | Good complete-generation boundary and recovery; divergent snapshots force a whole-library choice, including unrelated edits, unless a semantic merge layer is added; large transfers for small saves | Backup/migration tool, not normal reconciliation |
| Mutable structured file per entity, optionally native/serverless | Smaller conflicts than a DB; partial files, multi-file relations, deletes, causality and conflict copies still require a protocol; replacing SQL/API adds migration and indexing work | No correctness simplification |
| Private DB + immutable domain transactions | Per-field disjoint merge, explicit conflicts, transactional local saves; needs stable edit identity, ancestry, domain validation and retained history | Recommended minimum satisfying the requirement |

## Identities, generations and local transactions

The new package discriminator, `cairndex.replica-library`, carries the
logical library ID, protocol version, immutable history epoch and pinned genesis
hash. Entity IDs survive conversion. A replica incarnation is generated and kept
**privately per registered working copy**, not derived from a hostname, endpoint,
absolute path or cloud account. Restoring/cloning private state creates a fresh
incarnation before authoring. Event IDs are content hashes; each client save also
has a stable random operation ID for retries. Reusing an operation identity with
different bytes is an alarm, not a last-writer-wins update. Hashes detect damage;
they do not authenticate a malicious writer with access to the cloud account.

Each generation has an immutable manifest and immutable payload containing the
complete values of its changed conflict units. The manifest names library/epoch,
replica/operation identity, schema, parent event IDs, payload hash and length.
Its identity hashes the canonical manifest. Complete generation means **all its
bytes and the entire necessary ancestor closure have been validated**. A seed is
a complete authored catalog; production seeds may need bounded chunks whose
complete manifest is validated before activation. That chunking is not prototyped.
An event's complete causal version can be reconstructed from the retained seed
and ancestry, including any unresolved alternatives that version observed.

1. A save carries the editor's observed revisions/frontier, not just whatever the
   server has received most recently. Unsaved drafts are private durable records.
   Saving a stale draft creates a visible concurrent edit, never an overwrite of
   unseen remote content. Centrally served clients need the same mandatory basis
   and operation-ID contract; an unversioned legacy mutation must be rejected.
2. Under one local writer transaction, validate intent and relationships, save the
   canonical event/outbox and update the query projection. Report “saved here”
   only after commit. Import must not replace an editor's unsaved draft.
3. Publish payload then manifest with local temp/write/fsync/rename. Retry the
   same bytes and identity after a crash; repair absent local transport copies
   from the retained archive. Atomic rename on one filesystem says nothing about
   provider delivery order, completeness or durability.
4. The receiver validates bounded bytes, content identities, compatibility and
   dependencies, independent of filenames and provider-renamed conflict copies.
   Missing dependencies wait. Invalid bytes are retained/quarantined. Archive and
   projection change together in one local transaction. Repeated delivery is a
   no-op; transport disappearance is never metadata deletion.
5. Concurrent candidates remain explicit. A resolution is another ordinary
   immutable transaction, consuming exactly the reviewed frontier. A new arrival
   invalidates that review. Concurrent opposite resolutions conflict again.

No wall-clock ordering, timeout, heartbeat or “last modified” winner determines
metadata truth. A provider “latest” pointer may eventually optimize discovery but
cannot be an authority or suppress other branches.

## Conflict units and retained versions

| Data | Proposed reconciliation |
| --- | --- |
| Entity title, rating, source URL, note record text | Independent registers; different fields combine; concurrent different values of one field require a choice; equal values combine while retaining both writers |
| Notes and moments | Stable IDs; one note text or moment definition is indivisible initially; no text diff merge; ordered note IDs form one order unit |
| Smart Collection | Name independent from the complete versioned filter AST; never simplify an unsupported AST |
| Bundle/tag/collection membership | One Boolean edge per stable pair; independent edges combine; opposite concurrent changes on one edge conflict |
| Bundle membership and file/directory sequence | One complete ordered membership unit per bundle; cover/cursor references must validate against it; transfers between bundles require one atomic domain operation and cross-unit validation |
| Collection/tag hierarchy and sibling order | One complete ordered forest per hierarchy initially; concurrent structural changes require a forest choice; entity names remain separate |
| Entity deletion | Retained lifetime tombstone; every edit or new reference touches that entity's lifetime, revealing concurrent delete/edit or delete/reference intent |
| File identity/path collision | Explicit identity conflict; never coalesce two IDs merely because paths, sizes or quick hashes match |

For a scalar conflict, choosing the Blue title retains the Amber note and every
unrelated merged edit. Rejected title values and their **complete causal branches**
remain recoverable. For an order or forest conflict, the choice covers the whole
shown relationship unit; it can reject unrelated structural edits *inside that
unit*. Show the exact affected moves, membership and ordering before confirming.
Offer a manually composed valid arrangement as an alternative. Do not advertise
this as a fine-grained structural merge.

“Keep deleted” names the hidden object, its edits and references affected by the
choice; retain their full versions. “Keep edited object” explicitly restores the
selected live version and necessary relationships. Choosing a title cannot
implicitly resolve a lifetime conflict. An already-observed tombstone cannot be
undone by an ordinary stale save. A later **explicit recovery** can restore the
same stable ID with a new causal event and validated relationships, or export a
separate copy. Same-ID post-deletion recovery needs production implementation;
the prototype only exposes retained branches and prevents implicit resurrection.

A whole-library winner is reserved for explicit disaster recovery. It must list
all rejected changes and save a separate recovery archive. Retaining that archive
is **not** merging its unrelated edits. Normal conflicts do not use this shortcut.

## Authored metadata versus device observations

| Class | Storage and synchronization intent |
| --- | --- |
| Titles, notes, ratings, tags/groups, collections, saved filters, moments, manual covers/subtitle choices and confirmed grouping | Replicated authored history, preserving existing stable IDs and all supported fields |
| Catalog identities and durable membership/path metadata | Baseline preserves existing records; new discoveries/repairs need validated identity transactions before becoming shared facts; independent same-path discoveries remain reviewable |
| Local file availability, inode, probes, discovery candidates, scan times, FTS and aggregate indexes | Local observations/derived state; absence on one device cannot delete shared identities or alter another device's availability |
| Playback progress and bundle cursors | Separate per-replica resume hints; coalesce on actual playback transitions, not idle timers; prefer this device's session and offer another device's session explicitly, never conflict with authored edits |
| Jobs, leases, heartbeat, caches, HLS, grouping plans, pairing tokens and endpoint configuration | Private runtime state, excluded from authored transport; applied grouping creates authored transactions; plan lifecycle remains ADR-0022 |
| Unsaved editor text and conflict-review drafts | Private durable drafts with observed basis; retained across import, disconnect and crash |

Conversion preserves old progress/cursors in a legacy resume record rather than
silently dropping them. Cross-device resume hint transport is a distinct later
slice; the prototype excludes it. Merely leaving two apps open creates no authored
generations. Replicating automatic scan observations as user edits would violate
this rule and is not an acceptable production shortcut.

## User experience and source media

One library experience shows **saved here**, **waiting to exchange**, **waiting
for metadata/files**, **conflicts to review**, or **recovery/upgrade required**.
“Written to the cloud folder” is not “delivered to every device.” Show last
validated peer receipt where available, not an invented global synchronized flag.
Users can keep editing independent content while waiting for missing artifacts or
while unrelated conflicts exist. Conflicted controls show the locally saved view
with a badge and both candidates; deleted objects remain discoverable in the
conflict inbox. Device displays may differ until a choice arrives, honestly marked.

Missing payload/ancestry keeps the last good projection. Corruption identifies
an unimported generation and offers retry from a verified archive. Unknown schema
or an operation-identity fork blocks new saves until upgrade/recovery review;
keep browsing validated data and retain drafts. No empty-library reset or silent
“repair from the newest file.” Disk-full failure retains the prior committed
state and editor input and must never show “saved.”

Media synchronization belongs to the provider. Undownloaded files, placeholders,
mount outages and observed absence are local availability states. Metadata still
opens; playback offers download/retry when implemented. A missing media file is
not a tombstone. Concurrent source replacement/rename/delete and provider-created
media conflict copies require their own content-version/identity review. Never
hash or download the whole library just to synchronize notes. The first converted
replica scope permits **metadata edits only**, with physical write operations
unavailable until a separate source-operation design is approved. Legacy centrally
served write mode retains its current explicit journaled gates.

A central server can remain the one replica serving many clients from any supported
storage, including ordinary local disk. Clients do not acquire separate database
leases or replica identities. A managed sidecar serves a local replica similarly.
The existing lifecycle drain/fencing still protects each physical working store;
private process ownership replaces a globally synced lease for new replicas.
Legacy packages retain current ADR-0018 ownership. Storage format/capability can
vary during migration without introducing a “NAS mode” or a second application.

## Migration, compatibility and recovery

No automatic conversion is approved or implemented. Proposed rollout:

1. Inventory every durable field and relation, including custom/unknown data,
   notes/order, progress, directory members, filters, passphrase configuration and
   file-operation recovery records. Produce a reversible conversion mapping.
   All existing IDs survive. Runtime caches/jobs may be rebuilt; authored data
   may not be rescanned away. Unrecognized durable fields stop conversion.
2. Require one **conversion checkpoint** with known devices quiesced and their
   legacy changes collected. Use the completed ownership drain and SQLite backup
   API under verified ownership, then integrity/foreign-key checks in a private
   copy. The existing snapshot helper is useful here, not as a transport protocol:
   it replaces one mutable backup name and has no causal/conflict semantics.
3. Preserve a verified legacy backup, old manifest and a field/relationship count
   report outside provider churn. Build the private projection and a complete
   hashed seed; validate round-trip equality of all portable metadata. Failures
   leave the legacy package authoritative and untouched.
4. Publish a new epoch and complete descriptor only after local seed validation;
   another device waits for every dependency. Use the **new format discriminator**,
   not just a version increment: the current legacy parser reads `format_version`
   without enforcing its supported value. A synthetic test confirms the distinct
   discriminator is rejected before the legacy DB is opened. Full mixed-version
   route/startup testing is still a production gate.
5. Switch only by explicit owner action after a reviewed migration receipt.
   Keep the legacy backup immutable and out of ordinary open paths. An offline
   old app may still edit its old copy before learning about conversion; those
   edits require a preserved legacy branch and explicit extraction/reconciliation.
   A marker change is not remote revocation. Do not import raw legacy DB changes
   into the new epoch automatically or pretend simultaneous independent seeds
   with one library ID have shared ancestry.
6. After conversion, reopen/rebuild from validated history on a new device. Pending
   local outbox/drafts require private backup until successfully exchanged; copying
   only the cloud folder cannot recover unsynced changes. Moving the media root
   rebinds paths to the same identity after verification. Cloning as a new library
   requires a new library ID/epoch, not silently merging two catalogs.

Recovery can rebuild a damaged private projection from retained verified events;
local unsent events/drafts need their own backup. Corrupted/missing provider
artifacts can be restored from another verified archive without changing identity.
Retain losing generations, tombstones and unresolved branches indefinitely in the
initial scope. No age-based collection: a sleeping replica has no expiry date.
Future compaction requires an authenticated device roster, acknowledged checkpoint
and explicit device retirement; a retired returning device exports/reviews its
unsent work before reseeding. Backups and pinned recovery versions remain separate
from collection. Storage pressure must be visible before it prevents saving.

## Cost, validation and next decision

Normal transfer cost follows changed metadata, not DB size. SQL/FTS, virtualization,
media processing and the sidecar are retained. Costs are protocol validation,
ancestry indexing, domain conflict UI and a complete schema migration. Whole-forest
conflicts and indefinite retention intentionally trade convenience/storage for a
smaller safe first implementation. Large-library baselines, bounded discovery,
chunked seeds, incremental materialization and provider file-count limits need
measurement before readiness claims. The in-memory prototype is not that engine.

See [the validation record](../proposals/cloud-metadata-validation.md) and
[prototype instructions](../../apps/server/prototypes/cloud_metadata/README.md).
The simulator proves only behavior under the modeled deliveries and crash points.
It does not qualify iCloud Drive, OneDrive, Google Drive or another provider, power
loss, provider placeholders or the application UI.

**Approved first production group:** format/capability gate and
complete reversible migration contract; private projection plus transactional
outbox and mandatory edit basis for one vertical authored-metadata slice; bounded
verified import plus conflict/recovery UI and synthetic end-to-end tests. Keep
conversion unavailable to real libraries until all metadata families round-trip
and preserve conflicts. Then qualify each provider on disposable libraries through
its real offline/placeholder/restart behavior. Source-file writes, resume hint
transport, compaction, general server chooser and unrelated audit fixes remain
separately scoped. The first group is authorized; real-library conversion and the separately scoped work remain unavailable.
