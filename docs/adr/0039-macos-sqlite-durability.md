# ADR-0039: SQLite durability on macOS

- Status: accepted by the product owner, 2026-10-18
- Date: 2026-10-18
- Amends: ADR-0002's macOS synchronous setting

## Context

An unclean macOS VM stop prompted an audit of SQLite durability. The private
replica store already used WAL with `synchronous=FULL`, but SQLite's default
`fullfsync=OFF` meant it used ordinary `fsync`. On macOS that does not request
a device-cache flush. The audit does not establish the cause of the damage.
The ORM library and registry connections also used `synchronous=NORMAL`,
which can lose recent WAL commits after an OS crash or power loss.

## Decision

Every SQLite writer on macOS uses `synchronous=FULL`, `fullfsync=ON` and
`checkpoint_fullfsync=ON`. `persistence/sqlite_durability.py` owns the platform
condition. Engine connect hooks and raw writer connections apply it before
writing. Writable attached schemas receive their own synchronous setting.
This includes private catalogs, the registry, library and plans databases,
backup destinations, conversion copies and recovery candidates. The registry
backup/restore shell helpers import the same standard-library module, from
the checkout or installed server, including when they use the system Python.

Linux and Docker keep their existing settings. Private stores and raw writers
use FULL; ORM main databases use NORMAL. Journal-mode selection is unchanged.
Format-three working databases stay private and local under ADR-0035. The
retained library engine uses rollback journaling on network mounts under
ADR-0021; this change never enables WAL on SMB.

SQLite requests `F_FULLFSYNC` where supported. If the filesystem rejects it,
SQLite falls back to `fsync`; a failing fallback remains a SQLite I/O error.
`fullfsync` already covers checkpoints, but both flags are explicit so the
checkpoint policy remains clear.

## Cost and limits

The synthetic measurements and VM qualification are in [STATUS](../STATUS.md).
`devtools.benchmark_sqlite_durability` compares both previous synchronous
policies with the new policy, alternating run order. It times one-row rating
edits, 32-row discovery and 200-row legacy scan batches, and 1 MiB WAL
checkpoints. It creates and removes its own temporary databases.

Keep the same durability for scans and interactive edits. Batching amortizes
the flush cost without a weaker transaction policy. These storage timings
exclude application and media work. Success in a VM or on one SMB server
does not establish physical power-loss safety; the hypervisor, host, network
server and storage must honour flush requests. FULL with rollback journaling
also has weaker power-loss guarantees than WAL FULL or rollback EXTRA.
Non-SQLite file publication and directory sync are outside this change.

## Alternatives

- Enabling only the two fullfsync flags leaves NORMAL WAL commits without a
  per-commit sync. Rejected for macOS writers.
- Keeping scans at NORMAL makes their last committed batches less durable.
  Retain the existing batches and measure their cost first.
- Changing Linux's synchronous policy would change a separate deployment's
  performance. Keep that out of this macOS fix.

## References

- [SQLite fullfsync](https://sqlite.org/pragma.html#pragma_fullfsync),
  [checkpoint_fullfsync](https://sqlite.org/pragma.html#pragma_checkpoint_fullfsync)
  and [synchronous](https://sqlite.org/pragma.html#pragma_synchronous).
- SQLite's Unix VFS `full_fsync` in
  [os_unix.c](https://sqlite.org/src/file/src/os_unix.c) implements the fallback.
