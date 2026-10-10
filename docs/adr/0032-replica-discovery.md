# ADR-0032: Private replica discovery and reviewed catalog identity

- Status: accepted within the approved S12/I05 Update outcome
- Date: 2026-09-13
- Complements ADR-0006, ADR-0009, ADR-0029 and ADR-0031

## Decision

Manual **Update** starts bounded, cancellable private work. Filesystem enumeration,
availability, fingerprints, pending files and review drafts belong to the serving
replica. They are never catalog tombstones or provisional shared groupings. Confirmed
groupings remain settled. Review accepts new bundles or additions through the
catalog's guarded causal transactions, retaining the opening bases and retry intent.
Complete directories and settled owners are indexed privately across batches.
Normalized candidates carry all descendant groups and required ancestors; paged
selection supports existing collection placement and additions to settled bundles.
Accepted-source receipts preserve remaining siblings and partially accepted groups.
Prepared values, memberships and linked payloads remain private until atomic
validation and acceptance. Internal page sizes impose no total file-count limit.

Discovery requires package format 3, catalog version 2, minimum reader 3 and the
`discovery_identity_v1` capability. Formats 1 and 2 retain their supported workflows.
Format 3 retains protocol-two linked envelopes and permits an optional per-file
`$content` unit: algorithm, byte length and digest. Existing catalog fields and IDs
remain unchanged. Unknown readers/capability combinations fail closed. Only new
disposable developer fixtures can opt into this format; real conversion stays disabled.

Fingerprints read at most three 64 KiB regions. Small files receive a complete
SHA-256; larger files receive an explicitly distinguished sample digest. Samples
alone never coalesce independent identities. A unique move requires the original
to be absent, a prior local observation of that same catalog path, and matching
complete content evidence or unchanged local device/inode, size and samples.
An explicit sample-only repair can assign a reviewed identity across physical
files but cannot claim complete equality or transfer generation-bound resume.
Multiple possible matches require review. Copies with a surviving original are
new files. A changed same-path fingerprint requires an explicit source choice;
it never silently inherits an ID.

Small-file discovery IDs derive from library/epoch, path and complete content
evidence, allowing independently discovered identical files to share identity.
Large-file discoveries retain independent random IDs until explicit full-content
verification establishes portable evidence. Verification reads bounded blocks in a
cancellable private job, preserves completed receipts and rejects changed pinned
generations. It never runs implicitly in discovery or in an HTTP handler.
Competing paths, contents or groupings preserve all causal alternatives and a valid
local arrangement. Neither inode nor path/size is portable content proof.

Review and automatic repair revalidate current bytes and the captured path,
lifetime and arrangement bases before committing. Local absence or incomplete
enumeration never removes shared identities. A failed/cancelled walk commits no
repairs or grouping; observations remain private. Restart repeats enumeration;
accepted operations have exact durable receipts. Release drains a bounded worker
step before closing the private generation.

Private discovery/review state is included in coherent ADR-0031 backups. Restored
work requires a new filesystem validation and retains its original authored bases.
Derived traversal iterators restart. No recovered review submits itself.

## Boundaries

No continuous watcher, source-file operation, provider integration or directory
browser redesign is introduced. Batch sizes do not establish measured large-library performance. Complete catalog
validation/activation and final generation checks remain atomic. Sampling cannot
establish equality for independent large copies; explicit full verification and
review provide that evidence. Real-library conversion remains disabled.
