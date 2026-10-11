# Portable source operations

File Browser provides **Copy, Rename and Move** and **Trash and Undo**. Each opens file
operations and recovery for the selected library. Enable file operations on that serving
instance first. The deployment must permit writes. A protected library requires its
passphrase when enabling writes.

Select a regular file or directory and choose an action. Enter a library-relative
destination for Copy, Rename or Move. **Copy files…** receives files through the file
picker; the originals stay in place. Prepare the operation, inspect its saved review,
then choose **Apply reviewed operation**. An occupied destination offers Replace, Skip
or Keep Both. Keep Both selects a vacant suffix during preparation and checks that
absence again during application. It cannot overwrite a new arrival.

Saved operations have stable identities. A retry uses the same paths, collision choice
and review. Changed input requires a new operation. Interrupted operations retain their
intent, independent content versions and any captured originals. Completed versions from
interrupted work also support a separate recovery copy. Retry is explicit. Cancellation
stops preparation and application before capture; after capture, recovery must finish
the saved operation. Release and write-mode revocation stop admission and are checked
between byte blocks.

## Identity and recovery

| Action | Catalog identity |
| --- | --- |
| Copy to a vacant path | New file and provisional bundle |
| Copy Replace | Destination file ID and authored metadata remain |
| Rename or Move | Source file ID remains |
| Move Replace | Source ID moves; displaced bytes and metadata remain recoverable |
| Trash | Source is retained outside browsing; authored deletion history remains |
| Undo | Conditional inverse; unrelated later metadata remains |
| Restore copy | Independent file and provisional bundle at a vacant path |

Completed versions appear under **Trash and retained versions**. Undo requires the
recorded output bytes, affected metadata revisions and destination conditions. Later
changes to those conditions stop Undo. A separate recovery copy can be made at a vacant
path. Source versions have no automatic expiry or permanent-delete UI. Storage grows
with retained operations. Back up `.cairndex/source-operations/` along with source files
and `.cairndex/replica/`.

## Delivery and limits

Immutable receipts name the exact catalog event and retained versions. Metadata,
receipts and media can arrive separately. Incomplete delivery waits. A received receipt
never repeats the physical rename, replacement or deletion. Concurrent content and
reference edits require Metadata review. `catalog_source_edit` events require a source-
operation-aware reader; an older strict reader refuses them.

Private journals and uploads are included in private recovery validation. Source
versions stay in the library and are not included in private database snapshots.
Recovered unfinished operations require exact Retry after Reopen.

The current implementation accepts regular files and directories with at most 128
visible entries and 128 catalog identities per affected tree. A review also has a
4,096-unit and bounded-byte metadata limit. Nested and empty directories are retained.
Larger operations require smaller source selections. Symlinks, hidden paths, cross-
filesystem operations and unsupported no-replace storage primitives are refused. The
destination parent directory must exist. Replace requires matching file or directory
types. Source and destination trees must not overlap. The default operation budget is
128 GiB, counting independent versions, captured originals, output copies and retained
uploads. Insufficient storage stops work without discarding retained originals. Two
source workers serve the process; source copying does not run in HTTP exchange handlers.

Namespace changes by an external process can race with path checks. Parent identity
checks detect observed changes, but cannot exclude an external rename between the final
check and a filesystem call. External processes must not move library directories during
application. An already-open file can still be changed after capture; its independent
version remains the recovery source. Local synthetic tests do not qualify NAS storage,
providers or power-loss behavior.

On positively identified macOS SMB mounts, portable publication uses signed,
encrypted SMB3 and the corresponding saved login without an interactive prompt.
No-replace requests preserve occupied names. Private server identity supports
capture and exact retry when mounted inode numbers change. Delayed mounted
visibility stops after a bounded wait and retains the operation for Retry. Source
and retained-version timestamps are preserved; only owned incomplete staging can
receive an explicit timestamp. See [ADR-0037](adr/0037-portable-mounted-smb.md) and
[storage qualification](storage-qualification.md) for current evidence and limits.

See [ADR-0036](adr/0036-portable-source-operations.md) and [current status](STATUS.md).
