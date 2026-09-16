# Shared-server metadata editing

Clients of one legacy library share its server-owned SQLite database. Each authored
request carries the read basis captured when editing began and a stable retry identity
([ADR-0030](adr/0030-shared-server-edit-bases.md)). Server/library ownership and
ADR-0029 replica protocols remain separate.

## API contract

Content reads return `X-Cairndex-Basis`. Its opaque value identifies the content and
private grouping-plan database incarnations and their revision clocks. Clients retain
it with displayed data and drafts. `GET /api/v1/libraries/{library_id}/metadata` reads
the two clock rows for refresh detection; polling never advances an existing draft.

Authored writes require `X-Cairndex-Basis` and `X-Cairndex-Operation`. An operation
identity is a random 16–100 character ASCII identifier; reuse it only with identical
method, URL, body, basis and review headers. An exact retry returns the committed
response. Reusing an identity with different bytes returns 409. Missing or invalid
preconditions return 428; old clients may browse but must upgrade before saving.
Clients generate 128-bit cryptographic edit identities on private LAN HTTP as
well as HTTPS and desktop origins; secure-context-only UUID APIs are not required.
The current client also refuses to send authored requests without a valid basis.
Optional entity `If-Match` checks remain an additional compatibility constraint.

A save reserves the SQLite writer before reading current metadata. Triggers validate
changed units and update their clocks in the same transaction. Content and the exact
response receipt commit before HTTP success. A database failure returns a structured
503 and leaves the request safe to retry. Bulk edits and metadata deletions accept up
to 200 explicit bundle IDs and commit all selected changes together.

A 409 contains the conflicting unit, current/proposed values and the exact current
revision. `X-Cairndex-Review` acknowledges only explicitly reviewed unit revisions;
it never advances the opening basis for other fields. A later edit invalidates that
choice. The server rejects review overrides for structural units. No automatic
overwrite or text/list merge occurs.

## Mutation inventory

All paths below are relative to `/api/v1/libraries/{library_id}`. Scalar units are
independent unless the table specifies a composite. Deletion checks the entity's
edits and incoming references; tombstone clocks detect delete/recreate and ABA changes.

| Family | Authored actions | Conflict unit |
| --- | --- | --- |
| Bundles | Create, title, ordered notes, rating, cover, batch edits and metadata deletion | Individual fields; complete ordered notes list; entity edits/references on deletion |
| Bundle order | Reorder and cleanup order, including collection-scoped ordering | Complete library or collection ordering |
| Files and directory members | Link, metadata PATCH, sequence/role, repair, forget missing, collapse/expand, unlink | Individual descriptive fields; complete affected bundle membership/placement |
| Manual bundling and fast-add | Empty/create bundle, add files, `/fast-add` | Affected memberships, stable identities and grouping state |
| Tags | Create, rename, color, hierarchy/order and deletion | Name/color separately; hierarchy forest; edits/references on deletion |
| Collections | Create, from directory, name, description, cover, hierarchy/order and deletion | Separate fields; hierarchy/order; edits/references on deletion |
| Tag groups | Create, rename, order, deletion and membership | Fields, membership edges and group arrangement |
| Tag/collection assignments | Single, bulk, paste, checkbox and create-and-assign | Individual stable edges; full replacements also check removed edges |
| Smart Collections | Create, name, expression, view defaults, order and deletion | Separate fields; expression version plus exact AST is one composite |
| Moments | Create, comment, time span/source, tags and deletion | Comment separately; source plus start/end as one span; independent tag edges |
| Cover frames | Set and clear `/files/{id}/cover-frame` | File cover time, plus any affected authored bundle cover |
| Grouping plans | Generate, proposal title, destination, files/directories, parent, kind, stem levels, apply | Private plan arrangement plus affected content units |
| Subtitle metadata | Internal matching and regrouping writes | Track fields/references contribute clocks; no separate authored HTTP editor |

File lists and successful link/PATCH/reorder/repair/cover responses include saved
`note` and `source` with their read basis. Note and origin are independent scalar
units; clearing one uses `null`, and omitted fields remain unchanged. A retained
file-list row or successful response supplies the opening basis for a later edit.
The optional `If-Match` counter remains an additional constraint. Filename echoes
never write the stored legacy title; unsupported custom names return 422 without
changing metadata. Historical unsupported requests remain retained for explicit
discard/review; refresh never rewrites their bodies or bases. There is no file
note/source or custom-name editor in the current UI.

The explicit clock inventory is in `metadata/schema.py`. Internal ORM/bulk-SQL writers
advance the same clocks. Automatic opened times, resume progress, bundle cursors,
technical probes, availability and caches are observations. Browse/filter/preview,
playback sessions, exports, maintenance job enqueueing and suggestions do not require
an authored basis. Journaled source operations keep ADR-0013's own gates; their
resulting content writes still advance clocks. Legacy `primary_file_id` is retained
compatibility data, not an authored playback cursor.

## Client behavior and recovery

Text fields retain their opening value/basis through background reads. Notes are one
ordered list. Menus/dialogs and drag operations retain opening context; asynchronous
preparation binds subsequent requests to that context. Checkbox/paste assignments
send explicit additions/removals, preserving unrelated memberships. One visible
library poll refreshes active queries every five seconds when the revision changes;
focus/reconnect also refresh reads.

Grouping waits for its first read before generation. A review retains its first
loaded plan basis; an acknowledged plan edit advances only the guarded plan clock,
while the original content basis remains in force for apply-time checks. Background
reads never reauthorize retained selections or inline drafts.

Failed requests are retained in private server/library-scoped browser storage. The
review dialog shows current and proposed values, permits an exact scalar choice, or
keeps/discards the proposal. Structural conflicts retain the request and require
reopening the updated arrangement before starting a replacement action. Historical
scalar drafts without a basis show every proposed/current field before an explicit
choice establishes a new basis. Unsupported historical actions remain retained.
Storage failure is visible; in-memory drafts then last only for the current session.
Completing or discarding a recovered request clears matching stored field drafts
even after their editors close, while preserving newer input.

`metadata_clock`, indexed `metadata_revisions` and `metadata_receipts` contain protocol
state. Tombstones and receipts have no time-based expiry. Supported library engines
register the required connection-local SQLite functions; raw SQLite maintenance must
not write content tables without those functions. Backups use SQLite's backup API.

Synthetic conversion accepts either the pre-clock schema or the exact recognized
clock/receipt/trigger schema, archives it privately, and preserves unchanged rollback
values. An edited rollback receives a new content incarnation so old client requests
cannot authorize that authority. Unknown schema extensions still block conversion;
real-library conversion and provider qualification remain unavailable.

Grouping acceptance stores a pending plan settlement with its content receipt.
Content commits first; plan retirement commits separately; clearing the pending
settlement commits last. Recovery finishes only those recorded plan effects before
subsequent reads/writes, and exact retries retain the accepted result. Unconfirmed
plans still disappear on server startup (ADR-0022); no review is reconstructed.
The nullable receipt field is added without rewriting existing receipts.

## Verification

Backend tests exercise actual competing SQLite writers, disjoint/same-field saves,
review races, ABA, membership/deletion conflicts, atomic bulk rollback, commit failure,
plan resets, receipt replay and schema inventory. Browser tests use separate contexts
against a disposable real server for retained drafts, polling, conflict review,
lost-response retry, historical-draft recovery, pointer reorders and grouping
generation/acceptance with concurrent plan changes. Synthetic replica tests verify
exact rollback and rejection of altered protocol triggers. These checks do not
qualify owner libraries, providers, NAS deployments or power loss.
