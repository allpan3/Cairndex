# ADR-0041: Same-volume file operations

- Status: accepted by owner; implemented; owner-NAS qualification pending
- Date: 2026-11-06
- Amends: ADR-0036; retains ADR-0037's guarded SMB operations

## Decision

Rename, Move, Trash and Put Back relocate the original object on the same
filesystem without streaming its contents. Undo reverses that relocation when
its recorded object and affected metadata still match. Empty Trash is an
explicit journaled permanent deletion of selected retained objects. Copy and
Replace keep their independent-copy recovery contract.

This changes recovery from an independent historical byte copy to the retained
original object for relocation operations. An external process with an open handle
can still modify that object. Changed observations stop automatic Undo/Put Back
for review; neither inode nor server file ID proves that the contents never
changed. These operations are not a substitute for backups.

## Why

The current preparation makes a complete hashed recovery copy even for Trash.
Rename and Move additionally stage another copy for publication. Cost therefore
grows with file size, consumes storage, and replaces the original's filesystem
identity and attributes. A source phase also holds the library exchange lock,
delaying metadata saves. Small synthetic-file tests missed these consequences.

## Required implementation boundaries

- Preserve per-library Write Mode, deployment permission and lifecycle admission.
  Record exact intent before touching names and preserve stable catalog file IDs.
- Use existing no-replace local and SMB handle primitives with root, parent,
  mapping and object checks. Never fall back to overwrite or cross-device copy.
- Record source/destination object observations before mutation. After a lost reply,
  distinguish the original at source, the original at destination, and an ambiguous
  state requiring review. Never move an unrelated replacement or accept it as the
  reviewed file. Preserve filesystem attributes by moving the original.
- Prepare only affected catalog changes, retaining their observed causal bases.
  Do not invent full-content evidence or require a full Update merely to rename a
  locally observed file. Preserve existing content claims without upgrading them.
- Trash retains the original in an operation-owned directory. Put Back refuses an
  occupied destination. Permanent deletion targets only a verified retained object
  after explicit owner confirmation; deleting metadata alone never deletes bytes.
- Separate long source preparation from metadata exchange. Keep one source mutation
  per library, with admission held through its operation and catalog conditions
  rechecked before mutation/commit. Prove Release and recovery exclusion with tests.
- Existing queued, prepared, interrupted and completed copy-based operations retain
  their original interpretation and recovery bytes. A new explicit operation/receipt
  variant must fail closed on older readers. Do not reinterpret old reviews, purge
  their versions automatically, or add a generic format version field.

## Qualification required

Count content bytes read and written: same-volume file relocation must use zero.
Check identity, timestamps, permissions and synthetic extended attributes before
and after Rename, Trash, Put Back and Undo. Exercise collision, external replacement,
changed content, restart before/after relocation, lost replies and catalog commit
failure. Retain old-operation compatibility coverage. Verify metadata saves complete
during a deliberately slow independent copy and Release waits for active work.

Run disposable macOS SMB tests for large files, multiple small files, name mapping,
reconnects and namespace visibility. Record actual wall time and operation counts;
do not claim owner-NAS performance from local or mocked tests. Directory operations
need bounded catalog updates and separate qualification for large/hidden subtrees.
