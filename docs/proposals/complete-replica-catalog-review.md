# Complete synthetic replica catalog review

Offline authored metadata needs causal history across every family and complete
relationship operations. Protocol-two synthetic catalogs preserve all authored
cells and stable IDs, merge independent fields, retain conflicting branches and
prepare explicit structural choices. Reversible developer conversion verifies a
complete disposable legacy checkpoint before exposing a candidate package.

Implementation checkpoint: `43b2690e` on `fix/library-ownership-lifecycle`.

## Scope

- Versioned capability gates and bounded linked payloads for complete seeds and edits
- Indexed private SQLite projection, ownership/reference constraints, complete
  transfers/deletion cascades, collection covers and same-ID branch recovery
- Durable preview/save/recovery jobs, receipts, cancellation and restart handling
- Shared bundle-first catalog UI, reference pickers, exact numeric/JSON input,
  notes, hierarchy controls, conflict/history review and recoverable private drafts
- Disposable legacy/plans/auth archives, exact round trips and rollback exports
  preserving every new event, rejected branch, draft, job and receipt

Normal saves and imports touch affected indexed state. Explicit branch recovery
reconstructs history privately in a background job. Restoring a transferred file
repairs necessary live span/subtitle ownership while retaining independent comments;
restoring an ancestor cover includes its necessary descendant membership.

## Validation

| Gate | Result |
| --- | --- |
| Full backend | 1,434 passed, one skipped: host FFmpeg lacks zscale |
| Focused complete catalog and HTTP coverage | 95 tests included in the backend suite |
| Isolated prototype | 55 passed |
| Frontend unit suite | 1,154 passed |
| Full browser suite | 150 passed |
| Backend/frontend lint, formatting and types | Passed |
| Frontend build and generated OpenAPI reproducibility | Passed |
| ARM development sidecar and packaged smoke | Passed |
| Two independent frozen sidecars | Complete import, disjoint saves/exchange and reviewed recovery passed |
| Docker smoke | Attempted; both configured local daemon sockets unavailable |

Browser tests use invented metadata and controlled artifact copies between real
HTTP processes. Crash tests terminate subprocesses around seed/save commits. These
are application/protocol evidence, not actual-provider or power-loss qualification.

## Boundaries

Real-library conversion remains disabled. No source operation, owner-library access,
publication, deployment or installed-app replacement is part of this group. Private
store clone/restore tooling, cross-device resume transport, source writes, compaction
and representative NAS/large-library measurements remain separate work. Native UI,
full `.app` packaging, Windows and actual providers were not requalified.

The source-only implementation commit passed staged-content and message privacy
hooks. The complete branch publication scan remains blocked by the cumulative
8 MiB new-blob limit. No history rewrite or gate bypass is included.

## Documentation

README, STATUS, product brief, ADR-0029, architecture, data model, development,
deployment, filter language, migration contract, catalog reference, changelog and
OpenAPI/frontend API artifacts describe the current capability and its limits.
