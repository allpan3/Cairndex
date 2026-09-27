# Complete authored replica catalog

The shared app/API serves complete **synthetic** metadata catalogs under
[ADR-0029](adr/0029-cloud-metadata-replicas.md). Real-library conversion, provider
qualification and physical source operations remain unavailable for replica
packages. Format-three packages support [manual discovery](replica-discovery.md).
Complete catalogs support local media through
the shared production viewer. Legacy libraries retain their existing workflows.

## Compatibility and transport

| Package | Wire | Capability |
| --- | --- | --- |
| Format version 1 | Protocol 1 | `bundle_metadata_v1`: existing bundle title, notes and rating |
| Format version 2 | Protocol 2, catalog 1, minimum reader 2 | Exact ordered capabilities `authored_catalog_v1`, `linked_payload_v1`, `structural_choices_v1` |
| Format version 3 | Protocol 2, catalog 2, minimum reader 3 | Format-two capabilities plus `discovery_identity_v1` |

All use the `cairndex.replica-library` discriminator. An unknown format, reader
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
| File `$content` (format three) | Optional authored full-hash or explicitly sampled identity evidence |
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

The [private backup/recovery command](replica-recovery.md) captures coherent
private state, validates retained history and prepares a separate generation for
explicit activation after Release. Restores keep exact drafts and bases, preserve
retry receipts, allocate fresh authors and retain pending jobs for deliberate
retry. Private media observations are revalidated; source-bound resume remains
private. Shared package history alone cannot restore unexchanged work or drafts.

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

## Ordinary browse and edit boundary

Ordinary Open registers an existing complete synthetic package. A server with
`browse_version: 1` opens the shared virtual Bundle Browser and shared title,
ordered-note and star-rating controls. Save changes commits the retained causal
request. Input remains editable while a save is pending. Its acknowledgement
advances only saved fields; newer input and unrelated draft bases remain intact.
An uncertain response keeps the exact operation for Retry save, including after a
library switch. An already observed conflict requires explicit metadata review.

| Surface | Current route and capability | Remaining integration |
| --- | --- | --- |
| Open | Existing `/libraries/register`; capability read at `/replica/status` | Default Create, real conversion and provider qualification remain unavailable |
| Bundle Browser | Shared `Browser` and `Toolbar`; `/replica/catalog/bundles/browse` | Covers, technical facts, other system views, multi-selection actions, albums and collection navigation |
| Search | Private FTS5 over the complete eligible catalog before pagination | Representative large-library performance qualification |
| Sort and filters | Title, rating and date-added sorts; stable ID ties | Structured filters, facets and Smart Collection execution are visibly unavailable; unsupported request fields/sorts return 422 |
| Inspector | Shared title, note boxes and half-star control; durable `/replica/catalog/jobs` saves | Tag/collection pickers, file details and the remaining inspector actions use metadata review |
| Conflict/history | Existing complete choice, history and recovery controls under Metadata review | Common inspector conflict indicators do not replace complete structural review |
| File Browser | Existing paginated `/replica/catalog/files` beneath the library root | Ordinary physical File Browser integration and local availability presentation |
| Update/media | Existing discovery controls and shared viewer | Source writes, provider hydration and cross-device resume remain unavailable |

Search has the same token-prefix AND contract as legacy bundle search. It includes
bundle titles, ordered bundle notes, file notes and moment comments. Filenames,
paths, origins, tags and collection names are excluded. Empty bundles are eligible;
unconfirmed scan suggestions and bundles with only hidden files are excluded.
The count, search and order apply before the bounded page. Competing values remain
in review; search follows the valid local projection. No source file is inspected
by a browse request. Unknown size and availability are not reported as measured facts.

The query adapter reads the private projection; it does not open a legacy ORM
session. The strict request accepts only `q`, `sort`, `order`, `offset` and `limit`.
A private derived search index follows projection insert/delete operations in the
same transaction. Older stores build the index in bounded startup batches;
backup schema validation accepts the complete old or new schema. Recovery rebuilds
it from the validated projection. The index never enters shared history.

Single selection supports pointer, arrow keys, Home/End and Enter to open media.
Notes retain exact list values; arrow keys on each reorder control move a note.
Metadata review retains the all-family controls, saved jobs and deleted objects.
Older servers without the browse capability keep those catalog controls. Legacy
library queries and mutations retain their existing routes and behavior.

## Local media

The server advertises `media_version: 1` for complete catalogs. **Open media on this
device** opens a bundle, indexed file, saved moment or subtitle's video in the shared
viewer while retaining the catalog editor and its draft. Bundle playlists use
catalog order and paged file metadata; folder-member selection keeps its existing
scope. A local cursor is resolved before starting a later-page member.

Only the selected cataloged file is inspected. Video uses a bounded FFprobe operation
for local codec/duration observations; images do not require FFprobe. Inspection never discovers tracks, creates file identities,
repairs paths or changes authored choices. Unavailable bytes leave the catalog usable.
**Retry local media** rechecks the file after it becomes readable. No provider
hydration/download API or placeholder-recognition claim is included.

Video supports direct ranged reads and the existing HLS remux/transcode decision;
images use private thumbnails/previews and originals. Cataloged SRT/VTT tracks use
bounded text conversion; applicable external/embedded choices can use burn-in.
Saved moments and authored cover times retain their catalog IDs and values.
Local resume and bundle cursors survive Release/Reopen and server restart; another
server has separate progress. Closing/reopening observes current bytes and progress.

Source generations include the relative path and filesystem identity, size and
nanosecond modification/change times. Stream, decoder, session, derivative and
progress operations reject stale generations. Sources are opened through no-follow
directory descriptors; nonregular and hidden paths are refused. A direct response
pins its descriptor and checks each bounded chunk. Decoder subprocesses inherit
validated descriptors; replacement paths cannot redirect reads to another file.
HLS startup failure frees its reservation, and release stops local sessions.

Private observations and resume tables live beside authored projection in the
private DB. Image/subtitle derivatives live under its `cache` directory; HLS stays
in the server's private transcode directory. None becomes an authored event or a
synced `.cairndex/cache` entry. Legacy authored APIs remain fenced. Storyboard jobs,
server export workflows, audio-only viewing, cross-device resume, source discovery
and physical source operations are outside this media capability.

## Conversion and evidence

The [migration contract](replica-migration.md) defines the complete private archive
and reversible activation boundary. Developer fixtures populate every content/plans
table and use invented metadata and source byte specimens. The base catalog specimen
with a video extension is not playback-qualified media. `replica_media_fixture.create_playable()`
generates separate synthetic H.264, remux/transcode, image and subtitle specimens.
Conversion verifies DB integrity,
references, known inventory, independent seed reconstruction and exact legacy round
trip. Rollback export retains original observations/auth plus a separate archive of
all new events, conflicts, jobs and drafts. No owner-library activation is exposed.

Focused backend tests cover all-family edits/creation/deletion/recovery, exact
conversion, delayed structural events, cover constraints, linked corruption, active
readers, capability fences and subprocess exits around seed/save commits. Real
browser tests use independent HTTP servers and controlled local artifact delivery.
Provider delivery, power loss, Windows and representative NAS/large-library
performance remain unqualified. Current gate results are in
[STATUS](STATUS.md).
