# ADR-0031: Private replica backup and explicit device recovery

- Status: accepted within the approved S12/I05 private recovery outcome
- Date: 2026-09-13
- Complements [ADR-0029](0029-cloud-metadata-replicas.md); no real-library conversion

## Decision

Provide a supported local administrative command, also included in the frozen
sidecar, for coherent backup, verification, separate preparation, inspection,
cancellation and explicit activation. No HTTP endpoint accepts recovery paths.
The command operates only on already capable packages and never converts a legacy
library or writes source media. The [recovery guide](../replica-recovery.md) defines
the workflow and complete storage policy.

A private backup contains a SQLite online snapshot and a final canonical receipt
binding its checksum, length, exact package authority, table counts and coverage.
A read transaction captures committed WAL state while requests, jobs and exchange
continue. The receipt is published only after schema, integrity, reference and
independent history validation. The directory is create-only. Partial backups have
no valid receipt; previous backups remain unchanged.

Recovery prepares a separate private store from a verified backup and/or available
package history. It validates the exact capabilities, library ID, epoch, genesis,
accepted-event dependencies, linked payloads, causal indices and the preserved
valid conflict display. Unknown schema objects, partial additive capabilities and
unknown configuration require an upgrade. Known pre-media/private-receipt schemas
and historical cohort layouts have explicit compatibility rules. Incomplete or
corrupt transport stays visible as pending/blocked and cannot activate a partial
baseline. A healthy original's newer private records absent from the candidate
block activation, with counts and inspectable original checkpoints.

Before authoring, each prepared restoration receives a fresh random incarnation.
Immutable events retain their old authors and IDs. Private author lineage and
exact retry receipts recognize committed work, including matching original-device
events delivered after the backup. Pending jobs retain their intent and operation
IDs but require explicit exact-intent retry. Drafts retain their observed bases and
are never submitted automatically. Conflict choices still require their reviewed
alternatives. Two independently approved restores may author concurrent events;
they never impersonate one author or duplicate an entity on an exact local retry.

Activation uses an exact review hash. A private process lock is held from server
store admission through Release/shutdown drain, including requests, exchange,
jobs and media. The administrator must obtain the same lock. Activation installs
verified immutable bytes into a new generation and atomically updates a small
private binding; it never overwrites the old database. Bindings live separately
from working stores so missing stores remain recovery-required. Old handles are
retired, and each connection checks the bound directory/database identity.
An interrupted pointer publication is retryable; incomplete unbound candidates
remain private and cannot become a live store accidentally.
Activation independently validates candidate readiness and surviving original
private records. Repeated activation validates the current live generation.
Missing bindings with surviving generations fail closed; separate-data-directory
recovery preserves those ambiguous originals for inspection.

## Coverage and limits

The snapshot includes events/outbox, retained alternatives, drafts/dismissals,
jobs/results, source/inbox receipts, local observations, progress and cursors.
[ADR-0032](0032-replica-discovery.md) adds private discovery runs, evidence, identity
mappings, candidates and exact prepared reviews. Restored reviews retain their
causal bases and require explicit revalidation before acceptance.
Observations are reset in the candidate for local revalidation; original values
remain in the backup. Resume retains its source-generation fence. Different-device
bytes do not inherit progress automatically, and no resume transport is introduced.
Derived media, HLS and temporary branch projections are rebuilt.

Registry/authentication, endpoint configuration, source media and legacy conversion
archives have separate backup responsibilities and are never installed as another
device's credentials. Browser-only text never received by the server is outside a
server snapshot. Connected editors already deliver durable drafts; the workflow
requires checking receipt coverage and retaining disconnected browser work.
No system can recover unique work absent from every surviving store/backup.

Backups and recovery sets remain outside shared metadata transport and ordinary
provider trees. The application can reject paths inside the selected library and
linked private paths; it cannot discover every configured sync root. Checksums
detect damage, not a malicious writer with local access. POSIX process exclusion
and synthetic abrupt-exit tests do not establish provider or power-loss safety.

## Alternatives

- Raw live DB copying: misses WAL and duplicates the author identity
- Overwriting the active DB after a confirmation prompt: races admitted work and
  destroys the last valid local copy
- Shared-folder-only backup: cannot retain unexchanged edits or private drafts
- Automatic replay of recovered jobs/drafts: grants stale intent new authority
- Copying server credentials and machine observations to a new device: violates
  private identity and source-generation boundaries

## Ordinary controls

Libraries provides authorized private snapshot and recovery controls. The HTTP
surface accepts only server-managed operation identities, never filesystem paths.
Snapshots use `CAIRNDEX_PRIVATE_BACKUP_DIR`, or a separate sibling of the server
data directory. Storage must be outside library and sync trees; the application
cannot identify every provider directory. Administrators retain the local command
for explicit paths and moving verified sets to another server.

One registry-backed worker performs snapshot validation, preparation, inspection
and activation. Lists and inspection pages are bounded. Queued operations can be
cancelled. Running operations finish at the service's safe boundary; the UI does
not report them cancelled. Restart marks pending operations interrupted. Explicit
retry retains the operation identity, adopts only a complete verified result, and
never overwrites an incomplete set. A new preparation retains the incomplete set.

Preparation through the interface requires Release. Review binds the exact
candidate and original state. Activation requires that receipt and process
exclusion; Reopen is a separate action. The interface reports received drafts,
unpublished events and saved jobs, and identifies the separate backup needs for
source media, portable metadata, credentials and unreceived browser text.
