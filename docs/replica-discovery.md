# Manual replica Update

New format-three synthetic packages advertise `discovery_version: 1`. **Update**
starts a private, cancellable job against the serving device's library root. Normal
metadata exchange remains automatic. Formats one and two retain their existing
capabilities; real-library conversion remains unavailable.

## Review and identity

Update observes existing paths, repairs unambiguous external moves and proposes
new files using the existing grouping rules. Pending files and grouping suggestions
remain private until **Prepare grouping review** and **Accept reviewed changes**.
Review can change title, destination, selection and order. Additions append to a
confirmed bundle without regrouping its existing members or replacing its cover.
Unambiguous video/subtitle additions create authored subtitle links. Collection
review includes selectable descendant groups and their required ancestors. A chosen
existing collection receives the selected subtree; additions preserve settled
collection membership unless placement is explicit. Accepted source receipts retain
unchecked siblings and remaining album files for later review. Remaining files from
a partially accepted group append to its settled bundle by default.

Candidate files, descendant groups, prepared sources and metadata values have
independent pages. Selection defaults to the complete candidate, with file/group
exceptions and order edits independent of the visible page. Existing explicit-list
drafts remain recoverable. Preparation exposes complete file/group counts, actual
collection placement and exact metadata before acceptance.

A successful automatic repair preserves the file ID, bundle membership, notes,
tags, moments, covers and subtitle relationships. It requires the original path to
be absent, unique matching evidence in both directions and an earlier local
observation of that same original catalog path. Receiving a peer's moved path
cannot authorize moving it back to an older local folder. Copies with a surviving
original are new files. Multiple matches, sample-only matches across different
physical files and identities with no prior local observation require explicit
review. Sample-only review states that complete equality is unproven.

Different evidence at a cataloged path requires an explicit replacement choice.
Competing accepted replacements expose **Review content identity** in the file
editor, with both retained evidence alternatives.
Detected replacement bytes cannot inherit that identity's playback state before
review. Local absence, incomplete reads and unavailable roots never delete shared
catalog entries. No discovery operation renames, moves, overwrites or deletes media.

## Evidence and limits

An ordinary scan touches at most three 64 KiB regions per file. Files up to 192 KiB
receive a complete SHA-256; larger files initially receive `sample-sha256-v1`.
Samples cannot detect changes outside those regions or prove equality of independent large copies.
Automatic sampled repair also requires the earlier local device/inode identity.
Generation-bound local resume follows a verified repair; a manual sample-only
identity assignment does not transfer old progress to a different physical file.

**Verify complete content** explicitly queues full SHA-256 reads for an immutable
candidate. The worker reads 1 MiB blocks, yielding after at most 8 MiB or roughly
50 ms of reads. Byte progress and cancellation remain private. Complete receipts
survive cancellation; an interrupted file restarts from byte zero. A pinned
source descriptor and a final path/generation check reject files changed during
hashing. Reading a full file is never part of a request handler or ordinary scan.

Complete identities derive from library/epoch, path and evidence, so independently
verified identical large copies can share a file ID after reviewed acceptance.
Unverified large-file IDs are random and persist in a private path/evidence mapping.
A full-evidence identity observed through local samples requires verification;
matching samples alone cannot establish equality. Retained samples find possible
moves of previously verified files, with complete evidence checked before repair.
Independent large discoveries and same-path different contents retain explicit causal identity conflicts with a
valid local display. Group IDs derive from selected file IDs. Initial group/file
timestamps use the earliest selected source modification time: preserved copied
mtimes converge, while different mtimes can produce ordinary timestamp conflicts.
Timestamps never establish ancestry or authorize a move.

Enumeration yields every 32 entries, including ignored hidden/symlink entries.
Private disk-backed planning indexes every fresh source and settled catalog owner
before classifying complete directories. Assignment and role work advances in
32-file batches; worker batches never split bundles or omit later-page owners.
Preparation stages selected files, relationships and original causal bases in
private tables and emits complete linked catalog payloads. Final catalog validation
and activation are atomic operations; complete membership/forest units and the
final source-generation check may take longer than a batch. No measured
multi-terabyte readiness claim is implied. Continuous watchers, provider hydration
and directory-browser pagination remain outside this workflow.

## Private work and recovery

Progress, errors, observations, missing-file candidates, grouping drafts, identity
mappings and exact prepared reviews live in the private DB. Completed scans
supersede obsolete suggestions while retaining their bodies and saved drafts.
Cancelled or failed work retains already committed repairs. A failed or cancelled
walk cannot publish a repair; a restarted walk discards its partial observations.

Preparation captures source generations and causal bases. Acceptance revalidates
sources in pages, checks their generations again immediately before committing,
and commits authored changes and the private receipt atomically. An exact
retry retains its original preview and never silently takes newer bases. Competing
offline choices become catalog conflicts; a competing grouping received before
acceptance can instead fail safely while retaining the full private preview.
Closing/reopening review, switching libraries or refreshing the catalog preserves
private drafts. Invalid browser draft bytes are retained with a visible error.

[Private recovery](replica-recovery.md) includes every discovery table and validates
candidate shapes, identities, causal references and acceptance receipts. Restored
observations require local revalidation. **Saved discovery reviews** retains the
original selection and preview. **Revalidate saved review** checks that exact intent
without submitting it. Changed source generations require Update and a fresh
review; unchanged sources can be explicitly accepted after revalidation. Nothing
recovered applies itself. Normalized candidate members, group context, staged
values, linked preview parts and accepted-source receipts are included in recovery.
Recovered full-verification jobs require explicit retry; complete cached receipts
become trusted only after local generation checks. Incomplete hash accumulators
are rebuilt. Older backups missing whole additive discovery families remain
supported; partial or unknown schemas require an upgrade.

## API

All routes are under `/api/v1/libraries/{id}/replica/discovery`:

| Route | Behavior |
| --- | --- |
| `GET /status` | Latest private job state, phase, observed/repaired counts and error |
| `POST /runs` | Enqueue with a stable operation ID; repeated active requests reuse the run |
| `DELETE /runs/{id}` | Cancel future worker steps |
| `GET /candidates` | Paginated pending suggestions |
| `GET /candidates/{id}/files`, `GET /candidates/{id}/groups` | Page through complete sources and descendant/ancestor context |
| `GET /candidates/{id}/choices` | Page through every missing-identity choice; retain the selected label independently |
| `POST /reviews` | Queue complete selection preparation or exact-intent revalidation |
| `GET /reviews`, `GET /reviews/{id}` | Saved reviews, durable progress and exact compact preview/receipt |
| `GET /reviews/{id}/pages/{kind}` | Page through prepared `files`, `groups` or metadata `changes` |
| `POST /reviews/{id}/accept` | Queue acceptance of the exact receipt |
| `DELETE /reviews/{id}` | Cancel an uncommitted review while retaining its bytes |
| `POST /verifications` | Explicitly queue full-content verification of a candidate |
| `GET /verifications/{id}` | Read file/byte progress and retained errors |
| `DELETE /verifications/{id}` | Cancel future reads while retaining completed evidence |

HTTP handlers never enumerate media or apply grouping. Discovery shares the
existing replica worker and Release drain; its private state never enters metadata
transport. [ADR-0032](adr/0032-replica-discovery.md) defines the capability boundary.
