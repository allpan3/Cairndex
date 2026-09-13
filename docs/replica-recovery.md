# Private replica backup and device recovery

This local administrative workflow supports existing `cairndex.replica-library`
packages, including complete synthetic catalogs. Real-library conversion remains
disabled. It never moves or modifies source media. A backup protects one serving
replica's private state, not every device or the entire server configuration.

## Entry point

From `apps/server`:

```bash
uv run python -m cairndex.replicas.recovery_cli --help
```

The packaged sidecar exposes the same commands without starting an HTTP server:

```bash
<sidecar-bundle>/cairndex-sidecar replica-recovery --help
```

In a desktop bundle the executable is
`Cairndex.app/Contents/Resources/cairndex-sidecar/cairndex-sidecar`. Use the server
data directory belonging to the intended server, not another saved connection.
All paths are explicit local administrator arguments; there is no remote recovery
path API. Use canonical absolute paths without symlink components. Keep the server
data directory, backups and recovery sets outside **every** ordinary cloud-sync
tree. The command rejects private storage inside the selected library; it cannot
discover a provider's other configured roots.

## Backup and verification

Choose a new backup directory outside the server data directory. Backup can run
while the server is serving requests, exchanging metadata or saving private work.

```bash
uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  backup --output /private-backups/ExampleCheckpoint

uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  verify --backup /private-backups/ExampleCheckpoint
```

The directory contains `replica.db` and `receipt.json`. The receipt binds the
coherent SQLite snapshot's checksum, length, package capabilities/ancestry and
table counts. Verification independently imports accepted immutable history,
checks references and confirms retained private records. Unknown schema objects,
incomplete dependencies, corruption or another authority fail closed. A receipt
is a damage check, not cryptographic authentication of a backup's creator.
Keep the complete backup together and use a separately protected backup medium.
It is never put into `.cairndex/replica/objects` or exchanged to peers.

Connected editors send private drafts automatically. Keep them open until their
server requests succeed, then check the backup's draft counts and inspect recovered
drafts before relying on it. **Text that only exists in an offline browser, an
unreceived request or another device is not in this snapshot.** Retain that browser
profile and reconnect it deliberately; the command cannot capture a closed or
disconnected browser's local storage. Saving a draft and saving authored metadata
are different actions.

## Prepare, inspect and activate

Preparation creates a new private recovery set without changing the live binding.
It reads available package artifacts and optionally adds a verified private backup.
For another device, select its existing copy of the same capable package and its
own private server data directory. Register/open it normally after activation;
pair to its server separately if needed.

```bash
uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  prepare --backup /private-backups/ExampleCheckpoint

# Omitting --backup reconstructs only available shared history
uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  review --recovery <recovery-id>

uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  inspect --recovery <recovery-id> drafts
```

Review reports `prepared` or `blocked`, exact counts, events available only from
the backup, a fresh private author, pending/invalid artifact counts, queued-job
policy and any surviving original work absent from the candidate. `inspect`
supports `drafts`, `jobs`, `events`, `catalog` and protocol-one `bundles`, with
`--after`/`--limit` pagination. `--source previous` inspects a preserved valid
original checkpoint. These optional outputs contain private metadata; do not
publish them. A newer original edit/draft/job/resume record missing from the chosen
backup blocks activation. Make a new backup of the valid original and prepare
again; the command never silently discards that work.

Finish **Libraries → Release** for this library, or stop its server/sidecar, before
activation. A live server lock rejects activation until requests, jobs, exchange
and media have drained. Provide the exact receipt hash from review:

```bash
uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  activate --recovery <recovery-id> --receipt <review-hash>
```

Choose **Reopen** or start the server and open/register the same library. The
binding selects the new generation; old stores and the backup remain intact.
Never replace `replica.db` in place or copy a live DB to create another author.
The app exposes restored metadata, **Recover private draft**, conflict/history
review and **Saved operations** through its existing catalog workflow.

Recovering a draft keeps its original bases. It does not authorize an overwrite
of metadata that arrived later. Pending jobs appear as failed with a recovery
review message. Inspect their exact intent and, while released, explicitly retry
one using the `intent_receipt` printed by `inspect ... jobs`:

```bash
uv run python -m cairndex.replicas.recovery_cli \
  --library /media/ExampleReplica --data-dir /private-data/cairndex \
  retry-job --job <operation-id> --intent-receipt <intent-hash>
```

Reopen lets the normal worker execute it. Already committed operations replay
their exact receipt, including known original-device events delivered after the
backup. A stale conflict choice still fails and requires a fresh review. Ordinary
clean restarts retain their existing job-resumption behavior.

Before activation, `cancel --recovery <id> --receipt <hash>` preserves the set and
marks it cancelled; it uses the same private exclusion lock. An active recovery
cannot be cancelled. Repeated activation with the same review is idempotent.
It validates the current active database and reports its current inventory; a
missing or damaged database requires a new recovery. Activation also independently
checks candidate readiness and surviving private work against the reviewed bytes.
If preparation/backup is interrupted before its receipt exists, that incomplete
set cannot activate; repeat into a new set. Interrupted activation can retry the
same review if its complete target is unchanged. A partial/changed target requires
a new preparation, preserving the interrupted directory. Unknown schema requires
an appropriate reader; do not delete tables or remove capabilities to get past it.

If a generation binding is missing while restoration directories survive, ordinary
startup refuses to guess which store was active. Preserve the entire old server
data directory. A first activation interrupted before binding can retry its exact
review when only that unchanged generation exists. Otherwise recover a verified
private backup into a **separate new server data directory** and bind/register the
library there. This does not reconcile newer private work in the retained damaged
server directory; keep it available for separate inspection rather than deleting it.

## Private-state policy

| State | Backup and recovery behavior |
| --- | --- |
| `events`, local/published flags, immutable old identities | Included exactly; unpublished events remain in the outbox; no event-ID rewriting |
| Revisions, linked parts, parents/frontier, cohorts, guards, conflict holds | Included and validated against independent history; rejected alternatives remain retained |
| Catalog rows, placements, references, path/unique/claim indices | Included; verified by rebuilding relationships from the saved valid display |
| `drafts`, observed bases, `draft_receipts` | Included exactly; no automatic submission or resurrection of dismissed generations |
| `catalog_jobs`, retry identities/results, `recovery_receipts`, `recovery_authors` | Included; old authors remain private retry lineage; pending restored jobs require explicit retry |
| `inbox`, validation state, source receipts, blocked/exchange status | Included; new package discovery retries available artifacts without clearing fences |
| `local_media` | Included in backup; availability, generation, probe and error observations reset for device revalidation in candidate |
| `local_progress`, `local_cursors` | Included; stable IDs retained; progress applies only when the observed source generation still matches |
| `cache/`, HLS, temporary `recovery-*` branch projections | Rebuildable and excluded; source inputs and retained immutable history are the authority |
| `discovery_runs`, `discovery_entries`, `discovery_missing`, `discovery_baselines` | Included; restored running work fails for deliberate retry, baselines reset and walks restart |
| `discovery_identities`, `discovery_candidates`, `discovery_reviews` | Included with original bodies, source evidence, selections and causal receipts; pending reviews require explicit revalidation |
| Transport discovery iterators | Restarted; bounded exchange rediscovers immutable objects idempotently |
| Private bindings/locks | Rebuilt for the selected destination; old generations remain separate, and missing bound stores require explicit recovery |
| Registry, tokens, passphrase configuration, endpoint preferences | Separate server backup/rebinding responsibility; never transplanted as new-device credentials |
| Legacy conversion archive, legacy resume/auth/journals, source/trash files | Separate original recovery set/media backup responsibility; never replayed or altered here |
| Unknown private root artifacts or schema objects | Stop for classification/upgrade rather than silently omit |

Missing media never deletes catalog identities. Copied media commonly gets another
device/inode generation: old progress remains retained privately but does not
automatically resume those bytes. Cross-device resume transport and content-version
qualification are separate. No backup can recover unique unexchanged work absent
from all surviving stores and backups. Local synthetic delivery and process-exit
tests do not qualify provider sync, power loss, Windows or NAS behavior.

[Manual Update recovery](replica-discovery.md#private-work-and-recovery) preserves
prepared discovery intent. Superseded suggestions remain available as private
evidence; backup validation rejects inconsistent identities and preview references.

## Synthetic acceptance

From `apps/server`, the same acceptance test exercises the source sidecar or a
built executable. It starts authenticated disposable servers, saves metadata and a
private draft over HTTP, takes a live backup, restores another device, and repairs
a damaged released original without overwriting it:

```bash
uv run pytest tests/test_replica_recovery_binary.py -q
CAIRNDEX_RECOVERY_TEST_BINARY=/absolute/path/to/cairndex-sidecar \
  uv run pytest tests/test_replica_recovery_binary.py -q
```

The recovery/API suites additionally cover two restored authors, delayed original
work, explicit job retries, partial delivery, schema compatibility, source-bound
resume, changed reviews, lost bindings and abrupt process exits. The browser
scenario in `e2e/replica-recovery.spec.ts` recovers a received draft in a fresh
browser and retains competing edits after the original device returns.
