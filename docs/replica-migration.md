# Library migration preparation

## Current boundary

`replicas.catalog.migration.prepare()` prepares format-three metadata from a
fresh disposable legacy fixture. It accepts a `DisposableCatalog` test object.
This object is not authorization to convert arbitrary paths. There is no owner
conversion command, application route, registration, or activation operation.
`CONVERSION_AVAILABLE` remains `False`.

[ADR-0035](adr/0035-portable-library-format.md) defines the target application:
one ordinary portable library format, with private working databases. The first
extracted group contains preparation code only. Main's existing application
routes are unchanged; do not install this branch as the portable application.
The portable Create/Open and old-format refusal changes belong to group 2.
No legacy application support is added or restored by this preparation group.

## Compatibility classification

Inspect each selected library separately before proposing any real operation.
A format-three portable package does not need legacy library-format conversion.
A recognized older private SQLite layout can receive an additive private database
upgrade. That upgrade retains its library ID, epoch, genesis, package descriptor,
source paths and authored history. Unknown or partial private layouts are refused.

An old `cairndex.library` package requires separate format conversion before the
ADR-0035 application can open it. Formats one and two of
`cairndex.replica-library` have their own capability contracts; this preparer does
not promote them by changing their descriptor. No blanket migration is required.
No real-library format inventory has been made in this task.

## Disposable procedure

Run from `apps/server`:

```python
from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog.migration import prepare
from cairndex.replicas.catalog.conversion import export_legacy

fixture = create_disposable()
prepared = prepare(fixture)
assert prepare(fixture).package == prepared.package
rollback = export_legacy(prepared)
```

Preparation records a private immutable intent containing the source checkpoint
and one epoch. It validates the actual SQLite schema, schema version, relationships,
manifest, private records and source-operation journal. Unknown data stops work.
Pending operations and unresolved Trash recovery stop work; they are not replayed.
The original source remains authoritative and unchanged.

SQLite backup captures committed WAL values from the quiescent fixture. The
private archive retains both databases, exact manifest and synthetic access record
with checksums. Every modeled table is preserved, including private plans,
observations, progress, cursors and operation recovery records. Exact authored
values produce linked immutable seed objects. A separate private catalog imports
all dependencies. A legacy export must match every original row and cell before
the candidate descriptor is published. IDs, paths, relationships, null/empty
values, ordered notes, numeric values and opaque JSON text remain intact.

Format three requires catalog version 2, minimum reader 3 and the complete
`discovery_identity_v1` capability set. Preparation generates this catalog; it
does not relabel a format-two package. It does not copy source media into the
candidate. Native qualification uses separately copied synthetic media only.

One process lock excludes competing preparations. Process exits retain incomplete
attempts. Retry checks the same source checkpoint and uses the same epoch in a new
attempt. An acknowledged completed retry validates and reuses its original result.
Changed source, archive, seed or receipt data require inspection. No attempt or
recovery copy is automatically removed. Power-loss durability is not established.

## Backup and rollback

Before edits, `export_legacy()` produces a separate exact legacy metadata copy.
After edits, it exports the last valid authored arrangement and retains complete
new private history, rejected branches, drafts, jobs and receipts in
`replica-recovery.db`. It checks references and database integrity. It does not
replace the source or activate a legacy application. Recovered jobs and drafts
must not be submitted automatically. The all-family catalog tests include conflict
choices, deletion/recovery and exact save retries.

The original media remains in its original root. A rollback export is metadata,
not a complete media backup. Unsupported new mappings must stop a real rollback.
The synthetic exporter uses fixture defaults for newly created file/bundle
observations; this is not approved behavior for an owner conversion.

## Requirements before a selected real-library operation

1. Identify the selected package format, exact schema, app versions, all known
   writers and any offline work. Record why this library needs conversion.
2. Stop or drain every known writer. Preserve unreceived browser text separately.
   Record pending journals, Trash, source recovery files, private plans and drafts.
   Unresolved work requires an explicit decision; never discard or replay it.
3. Prepare a private, independently verified backup outside provider folders:
   consistent DB/WAL checkpoint, manifest, shared history, source/recovery media,
   registry, credentials and server settings. Record checksums, counts and space.
4. Implement and test a read-only adapter for that exact historical schema and
   its external artifacts. Current fixture validation deliberately refuses other
   schema layouts, caches, extensions and recovery artifacts. It is not that adapter.
5. Prepare a separate candidate from the checkpoint. Prove all IDs, values,
   relationships and paths; test independent reconstruction, interruptions,
   exact retry and rollback. Do not register the candidate during preparation.
6. Present the selected paths, backup receipt, validation results, writer shutdown
   evidence, activation steps and rollback target for owner approval. Activation
   needs a separate reviewed operation; it is absent from this group.
7. After approval, use the qualified portable application. Keep the original
   backup immutable. Before new edits, rollback can restore the verified original
   authority. After edits, retain all new history and reconcile a separate copy;
   raw database replacement is not rollback. Offline old writers remain separate
   preserved branches and cannot be revoked by a descriptor change.

The full source inventory currently hashes all synthetic media. It is suitable
for small disposable tests only. Real-library preparation needs a bounded storage
plan, historical schema adapters and recovery-artifact validation. No owner
activation request is ready. NAS, provider delivery, hydration, scale and power
loss require separate qualification.
