# Cloud metadata experiment

**Disposable prototype for proposed [ADR-0029](../../../../docs/adr/0029-cloud-metadata-replicas.md).
No production synchronization or migration is enabled.**

Run from `apps/server` using the existing development environment:

```bash
uv run python -m prototypes.cloud_metadata
uv run pytest prototypes/cloud_metadata -q
uv run ruff check prototypes/cloud_metadata
uv run ruff format --check prototypes/cloud_metadata
uv run mypy --strict prototypes/cloud_metadata
```

The demonstration takes no library path. The harness creates two marked temporary
roots, each with its own open SQLite connection, transport directories and an
empty media directory. It copies only synthetic transport files. Teardown removes
only those temporary roots. Tests use no network, cloud accounts or owner data.

- `protocol.py`: canonical manifest and payload, identity/hash/size/schema checks
- `merge.py`: causal field values, lifetime conflicts and atomic relationship units
- `replica.py`: private archive, outbox, drafts, transactional imports and failpoints
- `harness.py`: generated baseline and explicit file-delivery simulator
- `test_replica.py`: acceptance cases, including abrupt child-process exits

The miniature schema contains entities, titles, notes, half-star rating units,
relative paths, lifetime tombstones, membership edges, one ordered collection
forest and bundle member order. It is deliberately independent of production ORM
models. It does not implement the whole Cairndex schema, HTTP routes, filesystem
mutations, automatic scans, progress synchronization, a migration or a conflict UI.

Artifacts are limited to 1 MiB, 500 changed cells, 128 parents and 1,000 files per
transport directory. The evaluator reconstructs history in memory; it is a
correctness experiment, not a scalable importer. Accepted generations and drafts
are retained indefinitely; no garbage collector exists. A schema/operation-identity
alarm blocks new saves and has no automatic override. Recovery returns an exact
causal branch; a resolved field can be selectively reapplied. Post-deletion restore
as the same identity is not implemented; it requires the proposed explicit recovery
workflow, never an ordinary stale save.

The wheel includes only `src/cairndex`; the runtime Docker stage copies only
`/app/src`. Nothing in production imports this package. Generated databases,
artifacts and media are never tracked. See the [validation record](../../../../docs/proposals/cloud-metadata-validation.md)
for evidence and limits.
