# ADR-0030: Shared-server metadata edit bases

- Status: accepted within the approved S05/I04 safety outcome
- Date: 2026-09-12
- Branch: `fix/library-ownership-lifecycle`

## Decision

Legacy libraries keep their existing ownership and SQLite storage. Authored HTTP
mutations require a database-scoped read basis and a stable request identity.
Missing preconditions return 428 with an upgrade message. An entity's optional
`If-Match` counter alone does not meet this contract.

SQLite maintains an indexed last-change clock for independent authored cells,
membership edges, complete order/placement units and entity lifetimes. These
clocks include internal writers, so scanner/grouping changes cannot become an
invisible overwrite. Runtime timestamps, probes, playback progress and cursors
do not consume authored revisions. Clock rows survive deletion and detect ABA
changes. No metadata values or full history are stored in the clock index.

A writer reserves SQLite before reading or validating its basis. Database
triggers check changed units and update their clocks in the same transaction.
Unrelated cells and independent membership edges remain independent. Ordered
notes and moment spans are indivisible; structural changes protect their whole
arrangement. A deletion checks edits and incoming references as well as lifetime.
Identical requests replay a committed receipt; a reused identity with different
bytes is rejected. Receipt and content commit before reporting success.

Clients retain the basis of the displayed value when editing begins. Refetches,
other successful edits and conflict review never replace that basis implicitly.
Conflicting input remains a draft. A scalar choice acknowledges only the exact
unit and revision shown; another edit invalidates that choice. Structural
conflicts retain the proposed action and require reviewing the updated
arrangement before starting a replacement action. No automatic latest-version
overwrite or text/ordered-list merge is permitted.

One small revision poll per visible library invalidates existing active queries
when metadata changes. Reconnect and focus refresh reads. Drafts and pending
requests retain the existing server/library fences. Polls never acquire a client
ownership lease or publish metadata externally.

## Boundaries and consequences

The additive clock/receipt schema is private protocol bookkeeping preserved by
synthetic legacy conversion/rollback. ADR-0029 replica mutation/recovery protocols
remain separate. Source operations retain ADR-0013 gates and are outside this
metadata contract. Grouping plans retain ADR-0022's attached database lifetime
and existing cross-database crash limitations.

Old clients can browse but must upgrade to author metadata. Fine-grained clocks
cost indexed writes proportional to changed metadata; they avoid rescanning the
library on a save. Clock tombstones and retry receipts are retained without a
time-based expiry. Structural conflicts deliberately favor explicit review over
speculative merges.

## Alternatives

- Optional `If-Match`: leaves unversioned callers and other mutation families unsafe
- Entity counters alone: cause unnecessary conflicts for unrelated fields and miss
  relationship changes unless every writer remembers to bump them
- A preflight GET followed by an unchecked write: permits simultaneous lost updates
- Reuse the replica event protocol for ordinary libraries: requires an unnecessary
  storage conversion and changes the accepted replica boundary
