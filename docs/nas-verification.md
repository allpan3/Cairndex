# NAS verification

The 2026-09-16 checkpoint qualifies a bounded deployment on a Linux NAS and a
Mac client. Runtime changes are `0d6a4b2f` and `ab8fed9b` on
`fix/library-ownership-lifecycle`. It does not qualify every NAS, SMB server,
network, media workload or failure mode.

## Isolation and deployment

The production image runs as a non-root user with a read-only root filesystem,
temporary `/tmp`, no-new-privileges, four CPU cores of quota and 3 GiB of memory.
The task uses separate container, network, port, registry and disposable library
storage. Production services and the installed desktop app are preserved.
Tracked runtime sources form the build context; image inspection checks for
local databases, credentials, dependency trees, caches and packaging residue.

Synthetic fixtures carry every source-write, metadata-edit and interruption
check. Representative media is mounted as individual read-only files under
synthetic names; no original metadata is attached to the test server. Even a
root write-open receives `EROFS`. Original-library accounting uses a separate,
network-disabled read-only mount and queries a stable private SQLite copy.

The final image passes the production Docker smoke gate: SPA/API serving,
non-root permissions, scanning, thumbnails, ranges, HLS, clean shutdown/lease
release and alternate UID. Separate container checks confirm structured refusal
for wholly read-only metadata and acceptance of protected sources with writable
metadata. These checks do not constitute public-exposure or release acceptance.

## File operations and recovery

Real HTTP operations on NAS-local storage verify independent copy identity,
copy Undo, destination-preserving copy Replace, source-preserving Move Replace,
Rename, Trash and Undo. Independent file-byte and SQLite checks verify both
identities and preservation of later metadata edits through replacement Undo.
The browser picker also completes Replace and visible Undo.

The tested Mac SMB mount rejects hard links. Copy-import and copy Replace
therefore return structured HTTP 409 without displacing original bytes. Ordinary
Rename, Move, Move Replace, Trash and Undo pass on this same-share topology.
SQLite uses rollback journal mode there and passes integrity checks. NAS-local
hard links succeed. Neither result can be generalized to another SMB server or
cross-device move.

An actual `SIGKILL` interrupts a Replace upload after partial staging. Restart
preserves original bytes, removes abandoned staging, leaves no pending journal
entries and passes SQLite integrity. The native client shows the outage, refuses
an unavailable reconnect, retains its intended server/library and reconnects
after restart. The non-root NAS process/regression selection passes 203 tests.
This is process-exit recovery evidence; power-loss durability, mount loss and
hostile concurrent filesystem mutation remain unqualified.

## Clients and gates

Two independent browser contexts on plain LAN HTTP verify saved metadata,
connected refresh, retained local drafts, explicit conflict review and resolution.
A fresh isolated production desktop app remembers and reconnects to the NAS.
Its edit appears in an independent browser; a browser edit visibly refreshes in
the native player. The fresh app and bundled server build successfully, strict
code-signature verification passes, and decoded synthetic video is visible.
All three synthetic playback paths also have native picture/seek/progression
evidence; timings and limits are in [performance](performance.md#nas-playback-checkpoint).

The backend full gate passes Ruff, formatting, mypy and 1,713 tests with one
existing skip. The frontend full gate passes lint, formatting, typecheck, 1,229
tests and production build; the existing chunk-size warning remains. All 17
affected real-backend browser tests pass, including an actual insecure-origin
metadata save. Rust source is unchanged; its full suites are not repeated for
these Python/TypeScript repairs. No API/schema migration is required.

Desktop OS drag integration remains **INCOMPLETE and paused**. Cloud providers,
multi-terabyte scale, hardware transcoding and broader platforms remain separate.

## Storage accounting method

Physical source bytes, indexed bytes, SQLite, backups, recoverable Trash and
derived cache are different populations. Record both apparent size and allocated
blocks; deduplicate allocated inodes when reconciling filesystem totals. Count
hidden/unindexed files explicitly and do not follow symlink escapes.

For an active original library, mount the source read-only, stream its inventory,
and copy the DB/WAL/SHM only when their size, modification time and inode remain
stable across copying. Query the private copy and verify integrity. Match indexed
relative paths to the physical inventory without hashing source media. Account
for missing rows, size mismatches and unindexed files separately:

`indexed − physical source = missing indexed bytes + size deltas − unindexed bytes`

The audited current discrepancy is fully accounted for by retained missing-file
records minus unindexed physical files; available indexed sizes match disk. The
database is small relative to recoverable Trash and derived media. No purge,
rescan, vacuum or source cleanup is implied. Exact prior per-file evidence is
unavailable, so the earlier aggregate discrepancy cannot be reconstructed
historically. Owner-specific inventories and numerical receipts remain private.
