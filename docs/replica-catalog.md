# Complete authored replica catalog

The shared app/API serves complete **synthetic** metadata catalogs under
[ADR-0029](adr/0029-cloud-metadata-replicas.md). Real-library conversion, provider
qualification, playback, filesystem discovery and physical source operations remain
unavailable for replica packages. Legacy libraries retain their existing workflows.

## Compatibility and transport

| Package | Wire | Capability |
| --- | --- | --- |
| Format version 1 | Protocol 1 | `bundle_metadata_v1`: existing bundle title, notes and rating |
| Format version 2 | Protocol 2, catalog 1, minimum reader 2 | Exact ordered capabilities `authored_catalog_v1`, `linked_payload_v1`, `structural_choices_v1` |

Both use the `cairndex.replica-library` discriminator. An unknown format, reader
requirement, capability combination, field or operation requires upgrade/recovery;
legacy and protocol-one mutators refuse a complete catalog before changing it.

Each protocol-two record contains a unit key, canonical SQLite-cell JSON text and
observed revision hashes. An empty basis creates a new unit. Existing local IDs
require edits or explicit recovery; independent additions of the same Boolean edge
combine while retaining both authors. Stable operation IDs retry identical intent.
Opaque JSON column text is a string inside the record, preserving whitespace,
large integers, precise literals and SQL NULL versus JSON null.

Canonical JSONL records are split at UTF-8 boundaries into parts of at most 32 KiB.
Parts link by checksum; each envelope is at most 256 KiB. A complete root names the
tail, part/record count, payload checksum, parents, replica and operation identity.
Roots activate only after every linked byte and required revision is verified.
Missing or damaged artifacts preserve the previous valid projection. The complete
seed supports more than the protocol-one limit of 100 bundles; this does not establish
representative large-library performance or provider readiness.

## Units and relationships

[`replicas/inventory.py`](../apps/server/src/cairndex/replicas/inventory.py) pins every
legacy table and column. Every authored cell maps to an independent scalar unless
it belongs to one of these units:

| Unit | Meaning |
| --- | --- |
| Entity `$alive` | Retained lifetime; every edit/reference supplies observed live guards |
| Bundle `$members` | Complete file/directory membership, role and sequence |
| Tags/collections `_/$forest` | Complete hierarchy and sibling ordering |
| Moment `$span` | Bundle, file, start and end together |
| Smart Collection `$filter` | Filter version and exact allowlisted AST text |
| Subtitle `$source` | Bundle, video/source files and embedded index together |
| Stable pair edge | Boolean lifetime plus any independent edge-order scalar |
| Notes column | Complete ordered strings; duplicates, empty entries and whitespace retained |

Transfers include source/destination arrangements, collapsed-directory contents,
relevant cover/primary clearing and moment/subtitle ownership. Hierarchies must be
acyclic and complete. A bundle cover/primary belongs to that bundle; a collection
cover belongs to the collection or a descendant. Removing its last membership
previews the corresponding cover clear. Source bytes never move with membership.

Deletion previews include the complete metadata cascade and retain deleted values.
Concurrent delete/edit or delete/reference intent becomes an explicit lifetime
choice. An ordinary save cannot resurrect an observed tombstone. Recovery selects a
retained causal branch, reconstructs it in a separate private store and prepares the
same IDs and necessary relationships while preserving unrelated current work.
An unresolved selected branch requires a choice first.

Atomic operation cohorts connect required lifetime/placement transitions. Indexed
active and projected ownership claims connect contested arrangements while keeping
a valid local display. Superseded anchors release historical coupling; unrelated
scalar edits remain independent. A structural choice covers every displayed affected
unit and validates the exact reviewed revisions before preview and commit. Concurrent
choices conflict again. Rejected values/branches remain in history indefinitely.

## Private storage and jobs

SQLite under `CAIRNDEX_DATA_DIR/replicas` holds event bytes, linked parts, active
revisions, authored projection, indexed placements/references/uniqueness, path
indexes, parent/frontier graph, holds, inbox/outbox, drafts and jobs. Normal edits
update affected rows rather than replaying all history. Reads use committed
snapshots during a background write. Complete seed activation is transactional.

`POST /api/v1/libraries/{id}/replica/catalog/jobs` queues bounded preview, save,
reviewed-commit or recovery intent. Handlers do not build a seed, replay a branch or
execute a structural operation. Jobs have stable IDs and queued/running/succeeded/
failed/cancelled states. Restart requeues interrupted jobs; authored saves retry
idempotently. Only queued work can be cancelled. A paginated jobs list omits large
payloads; opening one job retrieves its review and receipt.

Browser and server drafts preserve creation inputs, scalar/composite input, choices,
reviewed bases and prepared job identities. Delayed generations cannot revive a
dismissed draft. Malformed browser envelopes are reported and retained rather than
trusted. Draft delivery retries while the editor is mounted. Peer delivery is unknown;
“saved here” describes the private commit, not provider delivery to every device.

## Shared workflow

The catalog opens with paginated bundles and exposes every authored family and edge.
Editors provide reference pickers, exact numeric input, ordered notes and complete
operation previews. Provenance/identity controls are available under advanced options.
Smart Collections preserve arbitrary supported AST text and offer an explicit
structured replacement builder. History offers field restoration and named branch
recovery. **Saved operations** recovers a prepared review after a lost response,
reload or restart. The indexed File Browser shows cataloged paths beneath the active
root; it does not browse arbitrary server paths or prove local media availability.

## Conversion and evidence

The [migration contract](replica-migration.md) defines the complete private archive
and reversible activation boundary. Developer fixtures populate every content/plans
table and use invented metadata and source byte specimens. The specimen with a video
extension is not playback-qualified media. Conversion verifies DB integrity,
references, known inventory, independent seed reconstruction and exact legacy round
trip. Rollback export retains original observations/auth plus a separate archive of
all new events, conflicts, jobs and drafts. No owner-library activation is exposed.

Focused backend tests cover all-family edits/creation/deletion/recovery, exact
conversion, delayed structural events, cover constraints, linked corruption, active
readers, capability fences and subprocess exits around seed/save commits. Real
browser tests use independent HTTP servers and controlled local artifact delivery.
These results do not qualify native UI, actual providers, power loss, Windows or
representative NAS/large-library performance. Current gate results are in
[STATUS](STATUS.md).
