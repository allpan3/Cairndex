# Unified library creation

Status: accepted normal creation contract; see [ADR-0035](../adr/0035-portable-library-format.md).

## Current contract

Normal Create makes a complete format-three portable library. Open rejects
`cairndex.library`. Conversion is separate and never automatic. One Create/Open
workflow serves all supported storage locations.

The package contains the library ID, history epoch, seed and immutable authored
history. SQLite, drafts, credentials, jobs, caches and process ownership remain
private. Existing source files are preserved. A private creation intent under
`CAIRNDEX_DATA_DIR/library-creations` records exact identities. Retry uses that
intent and refuses changed directories, names or metadata.

Independent copies use separate private stores. Passphrases are independent per
library and serving instance. Backups and recovery use the normal library manager.
Provider and NAS publication still require separate qualification.

## Implemented synthetic creation boundary

`devtools.replica_creation_fixture.prepare_disposable()` allocates a fresh
temporary tree. It accepts only an optional parent directory, never an existing
library. The package and private state are separate children of that tree.
`replicas.catalog.creation.complete()` accepts that developer fixture. Normal Create uses the same completion procedure after recording its own intent. The
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
Normal creation resumes only a matching private intent. When a peer receives
the descriptor before its objects, the existing importer waits for the complete
seed. A copied package opens with a separate private author. Clients of the same
server use one private store; Release/Reopen and restart retain that lifecycle.

If preparation stops before its private intent is complete, no package descriptor
exists. Retain that incomplete tree for inspection and allocate a separate fixture.
Do not guess its identity. A missing creation receipt does not authorize reuse of
the directory. This implementation does not supply production directory adoption,
root relocation, private-store recovery or historical-client qualification.

## Qualification limits

Use disposable synthetic libraries for creation, editing, conflicting values,
complete reconstruction, interruption, duplicate delivery, storage failure,
publication collisions and Release/Reopen tests. Provider, NAS, power-loss,
historical-client and representative-scale qualification remain separate.

Source operations need a portable journal and competing-operation contract.
Recently Used, cross-device resume and history compaction remain separate work.
The application does not supply owner-library conversion.
