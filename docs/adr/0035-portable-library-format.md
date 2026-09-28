# ADR-0035: One portable library format

- Status: accepted by the product owner
- Date: 2026-09-28
- Amends: ADR-0008, ADR-0010, ADR-0013, ADR-0018, ADR-0021 and ADR-0029

## Decision

Normal Create uses the complete format-three portable catalog. Open accepts
portable packages. The application does not create, register or serve the old
`cairndex.library` format. Existing registrations for that format are unavailable.
The owner performs conversion separately. There is no automatic conversion,
in-place upgrade, legacy passphrase import or legacy fallback workspace.

One library remains the user-facing storage concept. Local disks, NAS mounts and
provider folders are storage locations. They are not library types.

The library folder contains its descriptor and immutable authored history.
Working SQLite databases, received drafts, queued work, media caches and process
locks stay in private server storage. Creation records a private intent, preserves
existing source files and publishes the descriptor after verified seed objects.
An exact retry retains its identity. Unrelated or incomplete metadata is refused.

Each library has an independent optional passphrase on each serving instance.
Credentials stay outside shared history and recovery generations. They protect
access through that server; they do not encrypt files or protect a folder from
its holder. New servers require separate setup. Recovery retains the destination
server's access settings. Changes revoke paired access and browser grants for
that library before the new setting is stored.

Private backup and recovery use durable, library-scoped operations. Preparation
and activation require Release. Exact review receipts and private process locks
protect activation. Originals remain intact. Pending recovered work requires an
explicit retry; recovery does not submit drafts.

## Consequences and qualification

Legacy shared-folder ownership, source-write controls and the legacy workspace
are not application workflows. Shared schema and media primitives can remain in
use by the portable catalog and synthetic developer fixtures. Their presence does
not permit an old library to open. Synthetic conversion helpers remain unavailable
for owner-library conversion (`CONVERSION_AVAILABLE = False`).

Source Copy, Rename, Move, Replace, Trash and Undo need a separate portable
operation contract. Recently Used and cross-device resume remain separate work.
Private snapshots exclude source media, credentials, server configuration and
text that has not reached the server. Shared history needs its own backup.

This decision permits the normal creation default. It does not establish NAS,
provider, power-loss, historical-client or representative-scale qualification.
