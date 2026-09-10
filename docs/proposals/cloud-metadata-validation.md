# Cloud metadata proposal: validation record

**Proposal/prototype only, 2026-09-10.** [ADR-0029](../adr/0029-cloud-metadata-replicas.md)
is unratified. No production synchronization, migration or provider support is
implemented. The experiment uses two separate open SQLite connections and copies
only generated metadata artifacts between marked temporary directories.

## Executed evidence

| Acceptance area | Observed result |
| --- | --- |
| Both-open alternating saves | Twelve alternating saves converge without handoff |
| Offline independent edits | Title/note/rating on one entity and distinct membership edges combine |
| Overlapping edits | Different values remain explicit; equal concurrent values retain causal provenance |
| Resolution and recovery | Field choice keeps independent edits; full rejected causal branch remains accessible; opposite offline resolutions conflict |
| Unsaved input | Draft basis survives import; saving stale input exposes conflict; stale resolution review refuses |
| Delete/edit and delete/reference | Lifetime conflict requires explicit choice; choosing a field cannot silently resolve deletion; ordinary save cannot resurrect a tombstone |
| Hierarchy and order | Opposing valid forests require a whole-forest choice; independent renames survive; reorder/membership choice preserves valid structure |
| Cross-bundle transfer | A conflict in source order also blocks the related target unit, preventing partial double assignment |
| Duplicate/out-of-order delivery | Eight deterministic schedules converge; repeated and renamed artifacts deduplicate by content identity |
| Missing dependencies/partial files | Manifest-first, absent ancestry, truncated payload/manifest, corrupted bytes and wrong length retain good state until complete valid delivery |
| Abrupt save/publish/import/resolution exit | Eleven child-process failpoint cases use `os._exit(73)` without cleanup; restart preserves all-or-none transactions and retries the same event |
| Stale replica/retention | Reopened replica merges old offline work; removing transport files does not purge accepted history; missing authored transport is regenerated from the local archive |
| Identity/schema | Foreign library/epoch, pinned-genesis mismatch and operation fork refuse; incompatible schema retains drafts and blocks new saves |
| Media | Missing placeholder-like paths remain live metadata; path conflicts and local file absence do not mutate the other replica's source bytes; duplicate path identities require review |
| Idle/runtime classification | Polling and reading generate no authored events; progress-shaped payloads are rejected by the experiment schema |
| Format migration gate | Current manifest reader rejects the proposed distinct format discriminator on a synthetic marker without creating a database |

**55 prototype tests passed**, plus Ruff lint/format and strict mypy on seven
Python files. The executable synthetic demonstration passed. **74 existing tests
passed** across `test_ownership_lifecycle.py`, `test_ownership_api.py`,
`test_journal_mode.py` and `test_backup_restore_scripts.py`; the existing FastAPI
TestClient deprecation warning remains. The prototype suite completed in about
2–3 seconds locally; this measures only the small fixtures, not scale readiness.

Full product, browser, native, packaging and Docker gates were not repeated:
production code, APIs, UI and packaging configuration are unchanged. The prior
ownership task's package receipts are separate evidence, not provider validation.
The prototype is outside `src/cairndex`; the wheel's package selection and final
Docker runtime source copy exclude it. No generated DB, media or build output is
part of the change.

## What this does not prove

The miniature metadata schema is not a converter for the application database.
Missing media is simulated by ordinary absent files, not real File Provider
placeholders. Process exits test explicit durability boundaries on the local
filesystem; they do not simulate host power loss, disk controller failure or a
cloud client's crash. Tests drive a single writer per private DB and do not
establish production HTTP/client concurrency or native conflict UI behavior.

No cloud account, owner library, raw NAS database, installed app, host sleep or
network upload was used. Metadata file copies do not establish iCloud Drive,
OneDrive, Google Drive, Dropbox or Syncthing semantics. No encryption/authenticated
roster, protocol upgrade, chunked seed, same-ID restore after a settled deletion,
resume-hint transport or garbage collection is implemented. Typed values use a
small experiment schema; production must cover the full domain and all invariants.

## Real-provider qualification before claiming support

For each provider/OS combination, use separate disposable accounts/folders with
explicit upload authorization and two actual local replicas. Verify:

1. Both apps remain open through paused sync and genuinely offline edits; reconnect
   delivers all generations without losing concurrent versions.
2. Metadata files marked online-only, evicted or incompletely downloaded never
   replace the current projection; hydration is requested explicitly and failures
   remain visible. Test eviction during read, not only before startup.
3. Temp names, rename notifications, conflict filenames, interrupted upload,
   duplicate delivery and large batches behave safely. Complete hash/ancestry
   checks remain mandatory even when delivery normally appears atomic.
4. Restart app and provider clients during publish/import/resolution; restored
   folders and delayed replicas cannot cause implicit resurrection or epoch mixing.
5. Confirm source-media replacement/conflict/absence is reported independently of
   metadata. No automatic destructive source action is inferred from a tombstone.
6. Measure discovery latency, metadata file count limits, seed hydration, large
   histories and bounded import/UI responsiveness; document quotas and supported
   versions. Retention and backups must survive storage pressure.

Passing one provider does not qualify the others. Until these checks and the
complete migration round trip exist, the proposal remains design evidence only.
