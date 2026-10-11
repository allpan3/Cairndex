# ADR-0036: Portable source operations and retained content versions

- Status: accepted within the approved source-operation scope
- Date: 2026-09-28
- Amends: ADR-0013; complements ADR-0029, ADR-0031 and ADR-0035

## Contract

Copy, Rename, Move, Replace, Trash and Undo require both the deployment permission and
the serving instance's per-library write permission. Access checks and Release admission
apply. Copying a library does not copy write permission. Source reads, discovery,
metadata exchange and collection membership do not grant write permission.

An operation has a stable ID and exact private intent. A worker prepares a review with
the actual source observations, catalog revisions and collision choice. Complete
independent recovery copies precede destructive steps. Acceptance retains that review.
It does not obtain new revisions on the owner's behalf. A retry with changed intent is
refused. Long byte reads use bounded blocks and report progress. Two source workers run
separately from HTTP exchange. Directory reviews include at most 128 entries and 128
catalog identities per tree, with separate bounded metadata limits. Hidden, linked and
special entries are refused before capture.

Private mutable state stays outside the library. Completed content versions and
immutable operation receipts travel in `.cairndex/source-operations/`. A receipt names
its catalog event, affected paths, versions and conditional inverse.
`catalog_source_edit` identifies the source-operation semantics; older strict readers
refuse that event kind. Metadata, receipts and source bytes can arrive separately.
Missing dependencies wait. A received receipt never runs its physical operation. It
cannot authorize a second rename or deletion on the receiving device.

Copy creates independent identity. Copy Replace retains the destination file ID and
authored metadata. Rename and Move retain the source file ID. Replace retains the
displaced destination's bytes and metadata for explicit recovery. Trash uses retained
catalog deletion history so concurrent edits and references participate in the existing
lifetime conflict rules. It does not erase authored history.

Undo is a new journaled operation. It requires the affected catalog values and local
bytes to match the recorded result. It restores only the operation's changed values.
Unrelated later metadata stays intact. Later changes to an affected value, an occupied
restore path, unresolved alternatives or unavailable recovery bytes require review. An
exact completed retry cannot apply the inverse twice.

## Failure model

Several clients of one server share its private operation queue. Independent local
copies author independent catalog events and retain concurrent alternatives. Servers
that share mounted source storage also share mutable filesystem names; their private
locks do not exclude each other. A synchronized lease cannot fence a disconnected
process. Safe no-replace filesystem primitives and post-capture identity checks are
required independently of local process exclusion.

A source replacement between inspection and capture can be retained under the
operation's recovery directory. It must not receive the reviewed file identity. An
occupied destination is never overwritten. Symlink components and cross-device
relocation are refused. Unsupported storage primitives require a clear refusal; the old
check-then-rename and cross-device fallback are not portable guarantees. ADR-0034's
earlier mounted-SMB evidence does not qualify this contract.

Recovery versions are independent copies, not hard links to mutable source files.
Completed versions have no automatic purge or retention expiry. Each operation has a
byte budget that counts snapshots, captured originals, outputs and uploads. It can fail
for insufficient storage without discarding its originals or completed versions. Storage
consumption grows with retained versions; source backups must include these versions.
Private snapshots do not contain them.

Hashes and filesystem observations detect the changes they observe. They cannot prove
the absence of arbitrary external writes. A process with an already-open file can
continue writing after a rename. A provider or another actor can delete every source and
recovery version. The application cannot recover bytes absent from all surviving copies
and backups. Provider conflict filenames are evidence to inspect, not a transaction
protocol. Parent identity checks detect observed replacement or detachment; they cannot
exclude a directory rename between the last check and the filesystem call. External
processes must not move library directories during application.

## Implementation and qualification

The implementation follows this contract within its stated bounds. Current implementation
state and remaining work belong in `docs/STATUS.md`. Synthetic tests must cover operation and
collision identity, lost responses, restart boundaries, conditional Undo, independently
delivered metadata/bytes, concurrent authors, external changes, path safety, access,
Release and private recovery.

Provider/NAS qualification and final installation/owner acceptance remain later groups.
Incoming OS drag delivery remains paused. No source-write permission is implied by
metadata publication capability.
