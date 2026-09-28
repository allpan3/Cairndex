# Unified library creation

Status: proposed product rollout; the empty-catalog synthetic implementation scope
is owner-approved. Ordinary Create still produces `cairndex.library` packages.
Real-library conversion remains unavailable. No provider readiness is implied.

## Target contract

Use the complete format-three catalog as the portable representation for new
libraries after the capability and qualification gates below pass. Keep one
Create/Open workflow. Do not detect cloud folders or ask the owner to select a
library type. Open existing legacy packages without conversion.

The package carries the library ID, history epoch, complete seed and immutable
authored history. SQLite, drafts, credentials, jobs, caches and process ownership
remain private to the serving instance. Independent copies can author concurrently.
Clients of one server use that server's store and observed edit bases. Retain the
current connection-scoped library selection, credentials and query caches.
Independent private stores can use the same mounted transport folder only after
its publication primitive is qualified. A synchronized lease is not a lock across
independent copies. Legacy ownership and ADR-0030 remain unchanged.

## Implemented synthetic creation boundary

`devtools.replica_creation_fixture.prepare_disposable()` allocates a fresh
temporary tree. It accepts only an optional parent directory, never an existing
library. The package and private state are separate children of that tree.
`replicas.catalog.creation.complete()` accepts that developer fixture. Neither
function is an application endpoint or an owner-library creation command. The
fixture dataclass is not an authentication or authorization boundary.

Preparation creates empty package directories and commits a private creation
intent. The intent contains the exact descriptor, seed author and operation IDs,
plus local root/metadata directory identities. It is not synchronized content.
An empty complete catalog contains the required empty tag and collection forests;
no legacy SQLite database or schema conversion is needed.

Completion takes a private process lock. It reconstructs the seed in a separate
private store, publishes its immutable objects without replacement, checks their
bytes and synchronizes directory entries before publishing the descriptor last.
Retries use the same identity and bytes. A competing descriptor or changed object
stops publication; it is never overwritten. Temporary files from interruption
remain ignored. Directory replacement and linked paths require review.

Before a complete descriptor exists, ordinary registration refuses the package.
Ordinary creation refuses its existing metadata directory. When a peer receives
the descriptor before its objects, the existing importer waits for the complete
seed. A copied package opens with a separate private author. Clients of the same
server use one private store; Release/Reopen and restart retain that lifecycle.

If preparation stops before its private intent is complete, no package descriptor
exists. Retain that incomplete tree for inspection and allocate a separate fixture.
Do not guess its identity. A missing creation receipt does not authorize reuse of
the directory. This implementation does not supply production directory adoption,
root relocation, private-store recovery or historical-client qualification.

## Remaining product gates

- Complete or explicitly defer the remaining ordinary interface capabilities.
  Existing complete synthetic packages support collection/tag navigation,
  structured filters, File Browser, title/note/rating controls, membership reviews,
  covers, local file details, paginated bundle albums and reviewed bulk metadata
  changes. Random, recorded local Missing Files and paginated Unbundled views are
  available.
  Recently Used and source-operation views remain separate work; see
  the [capability inventory](../replica-catalog.md#ordinary-browse-and-edit-boundary).
  Retain the existing all-family conflict and discovery controls.
- Define passphrase access for private stores, including protected legacy
  upgrades and explicit setup on each new server. Credentials must not enter
  synchronized content. An ADR-0010 amendment is required.
- Provide normal backup controls with separate coverage for private drafts,
  unexchanged edits, credentials, source media and portable history. Browser-only
  text is not included in a server snapshot.
- Design copy imports and journaled Rename/Move/Replace/Trash/Undo separately.
  Retain content versions, stable IDs, competing-operation review and conditional
  Undo. An imported metadata event must not replay a physical operation on every
  device. Preserve the distinct Copy Replace and Rename/Move Replace contracts.
- Implement deliberate per-library upgrade under the complete migration contract.
  Collect known writers, retain private drafts and recovery data, drain work, verify
  exact round trips and require reviewed activation. Unknown durable state blocks
  upgrade. Offline old copies require separate reconciliation; a descriptor cannot
  revoke their writers. No bulk or second-device automatic conversion is implied.
- Qualify metadata publication on supported storage. Current publication requires
  hard links and POSIX directory descriptors. Existing SMB source publication does
  not qualify metadata transport. Cross-device resume and history compaction remain
  separate scopes.

## Verification sequence

Use synthetic packages and independent private stores first. Test empty-catalog
editing, conflicting values, complete reconstruction, incomplete and duplicate
delivery, conflict filenames, exact retries, process exits, storage failures,
publication collisions and Release/Reopen. Check that ordinary creation and the
conversion gate retain their contracts. Use full backend static and test gates.

Before default activation, add ordinary UI/browser and packaged acceptance,
mixed-version tests with supported historical executables, private recovery,
multi-server routing, mounted storage and representative performance checks.
Then qualify each provider with disposable libraries: offline edits, delayed
delivery, missing objects, conflict filenames, placeholders, hydration and restart.
Local process-exit tests do not establish provider or power-loss safety. Tests must
not use owner libraries. Capability gaps need implementation or an explicit owner
decision before the ordinary creation default changes.
