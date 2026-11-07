# Portable source operations

Copying files in, and **Rename…**, **Copy to…**, **Move to…** and **Move to Trash**
on library items, need that library's **Write mode**. Turn it on in **Libraries**, on
the serving instance; nothing else switches it. The deployment must permit writes. A
protected library requires its passphrase when enabling writes.

Turning write mode on asks for confirmation and checks saved-login access for
a mounted macOS SMB share before reporting success. If macOS requires approval,
its request appears as part of enabling Write Mode; no separate Allow Access
step is needed. A live verified SMB session is reused. Name-validation and namespace
visibility errors retain that session. After explicit authorization, a transient
disconnect reuses a process-memory grant for that server/account/share. Write Mode
off, mount identity change, last account close and shutdown revoke the grant.
Authentication failure requires fresh saved-login access; background work does
not open a prompt. An unanswered interactive request is reused on retry. Turning it off takes effect at once
for an authorized session. A locked library asks for its passphrase. Released
libraries must be reopened before enabling writes. A read-only deployment keeps
the control visible and explains why it is blocked. Library **Settings…** opens
in its own dialog; closing it restores the list and its keyboard focus.

The File Browser and Unbundled list respond to write mode changes without a
restart. With write mode on, a file or folder's context menu holds **Rename…**,
**Copy to…**, **Move to…** and **Move to Trash**. **F2** or **Enter** renames a
single selected item, and so does a double-click on its name in the inspector.
**Delete** or **⌘⌫** asks to move the selection to the Trash. Each action asks
only what it needs (a name, a folder, or a confirmation for the Trash).
Naming stays in its editor until the server answers and the file views refresh;
active naming progress is visible in the file-activity card. A second editor
shares the same pending name request, and overlapping unfinished operations
refuse new intent until the existing operation is finished or cancelled. Earlier
unstarted Rename/New Folder collision rejections are retired when a corrected
request uses that location; interrupted mutations remain protected. Copies and moves run as
background tasks. Turning write mode off removes these actions.
Existing directory-size and source-safety limits still apply. Interrupted writes
retain their intent and show permission, read-only, full-storage or saved-login
failures specifically. Private job results retain numeric storage error codes
and the failed phase, without exception text or source paths. If macOS blocks
the saved network login, the library opens **Network Share Access** with **Allow Access…**. Dismissing
the dialog leaves a small control to reopen it. Authorize it, then
choose **Try Again** for the stopped task. Successful metadata exchange does not
hide that request; authorization alone never applies the source operation.

Inside an open bundle, file menus also provide **Rename…** and **Move to Trash**
under the same Write Mode gate. F2 or double-clicking the file inspector’s name
starts renaming; Delete or ⌘⌫ requests Trash. Enter continues to open the selected
media. The source operation preserves the file ID, and Trash retains conditional
Undo. **Locate in File Browser** navigates without changing files or membership.

In File Browser, **New Folder** in the toolbar, context menu or desktop File
menu inserts an inline row with **Untitled** selected. Type a name and press
Enter or click outside to create it in the current directory; Escape cancels
without creating a folder. Invalid or occupied names stay editable with a small
inline error. An occupied name says **This name is already in use.**, with no Retry
or recovery card. Rename uses the same behavior in the browser and inspector.
New Folder requires Write Mode and a server that advertises `source_mkdir`. Existing names are refused without replacement. Undo is available
while the folder still matches the recorded empty tree; adding files prevents
Undo from removing them. Creating a folder does not create a bundle or collection.

![Write mode in two synthetic libraries](screenshots/library-write-mode.png)

Generated temporary paths are masked. Settings also fits a short window; its
[keyboard-accessible help](screenshots/library-settings-tooltip.png) stays visible
outside the scrolling body.

## Files from this computer

Dropping regular files on the window, or **Add Files…** in the sidebar's ⋯ library
menu, opens one dialog. What the files become depends on where they arrive:

| Where | Dialog | Result |
| --- | --- | --- |
| Bundle Browser, no bundle open | Add N files as a new bundle | One new bundle, in the open collection |
| A bundle card or inside an open bundle | Add N files to “Title” | The files join that bundle |
| File Browser | Copy N files to *folder* | Plain copies in the open folder |

The bundle name defaults to the stem the files share ("Harbor at dusk" for its
`.mp4` and `.srt`), else the largest file's name. In a collection, that collection
is pre-filled and others can be added, and the folder defaults to the one most of
the collection's bundles are in. Elsewhere the folder defaults to the one last used
for this library. Drops inside an open bundle, and **Add Files…** while it is
open, add to that bundle. Bundles have no single physical path. For an existing
bundle, the suggested folder is the parent of its first ordered file, or its
first directory member. One metadata read supplies this hint; it does not scan
storage or load every file. An empty bundle uses the last chosen library folder.
**Change…** browses existing library folders. A manual choice takes precedence
over the suggestion, and Copy waits for a suggestion or an explicit choice.
With write mode off, the dialog's next step is **Open Libraries…**. Opening the
dialog changes no source files, and the originals stay where they are.

The browser build can only copy: a browser drop delivers a file's contents, not its
location. Move from the desktop app needs native drop paths and is a separate step.

## Background tasks

**Copy** closes its dialog at once. The work runs
as a compact activity card at the bottom right, visible with the sidebar closed.
It floats over the browser without moving the toolbar or reducing the grid
height. It shows completed-file counts, received bytes, transfer percentage, speed and the current
transfer, verification or saving phase. Transfer completion does not mean final
publication has finished. Source work has its own per-library queue, so copying does not hold the metadata
exchange lock. Metadata commits still validate their causal bases. **×** stops a task: files not yet applied are cancelled, a file
already being applied finishes, and **Continue** resumes the rest. A task that ends
cleanly leaves a message with **Undo** at the foot of the window. Undo is one new
journaled operation per changed item. A plain copy, move, rename or trash has an
exact inverse. Copies that were then bundled cannot use it, because bundling
changed their metadata after they landed, so their Undo moves them to the Trash
and removes a bundle the task made. A bundling task whose Replace kept an older
version offers no Undo; Trash's **Restore a Copy** brings that version back.

Each file is still its own saved operation with its own review. The task prepares
each review and accepts it unchanged: the click that named the files, the action
and the destination is the approval. An occupied name stops that file in the
activity panel with **New name**, **Keep Both**, **Replace** or **Skip**.
Rename and New Folder instead reject an occupied name in their inline editor.
Keep Both selects a vacant suffix during preparation and checks that absence again during application, so it
cannot overwrite a new arrival. Replace keeps the displaced file as a recoverable
version. The chosen answer becomes a new operation over the same received bytes,
and it is accepted the same way.

Unstarted naming collisions from earlier versions stay in the private journal
but do not appear as recovery tasks. Actual stopped operations from a reload,
another window or an earlier version show their name, reason and available actions directly in the activity card. No separate
Review dialog is needed. **Cancel** persists in the operation journal; it does not
return after reload. An operation that already changed files must finish recovery
and cannot be dismissed as cancelled. Changing a collision choice or name cancels
the old intent before preparing the new one.

Saved operations have stable identities. A retry uses the same paths, collision choice
and review. Changed input requires a new operation. Interrupted operations retain their
intent and their recorded original objects or independent content versions. Completed versions from
interrupted work also support a separate recovery copy. Retry is explicit. Cancellation
stops preparation and application before capture; after capture, recovery must finish
the saved operation. Release and write-mode revocation stop admission and are checked
between byte blocks.

File selection accepts at most 128 regular files, each no larger than 128 GiB.
Folder drops are refused. Copying does not link a dropped file in place or infer
its host location. Existing library files can enter manual bundling directly
from File Browser without Update; reviewed Update also discovers them. **Stop**
ends an upload or preparation and cancels that file's unapplied operation. A copy
that is already being applied finishes, and the files after it do not start. Files
that were never sent stay listed for another try. Native Reveal, Open and drag-out
need a verified local mapping; picker and dropped byte copies do not.

![Two synthetic files dropped in the Bundle Browser](screenshots/desktop-file-copies.png)

Synthetic browser example: two dropped files about to become one bundle. All names
and file contents in this example are generated.

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

**Trash** in the sidebar lists trashed items with **Put Back**, and versions that
Replace displaced with **Restore a Copy**, which puts the version beside the current
file under a Keep Both name. Trash shows while write mode is on, or while it holds
anything. Each of its actions is a journaled operation. Undo requires the
recorded output bytes, affected metadata revisions and destination conditions. Later
changes to those conditions stop Undo. A separate recovery copy can be made at a vacant
path for copy-based recovery. **Empty Trash…** loads the complete receipt list
and asks for confirmation before permanently deleting retained originals. Cancel
leaves them intact. Older copy-based Trash and Replace recovery versions remain;
they cannot be deleted through this action. There is no automatic expiry. Back up `.cairndex/source-operations/` along with source files
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

Uploads coalesce incoming fragments into bounded 4 MiB writes. Preparation uses
that completed upload as the retained source version instead of copying it again.
Publication still creates and hashes an independent output, verifies its digest
against the received bytes and uses no-replace publication. Later output edits
cannot change the retained upload. An unsuccessful retry of a completed upload
leaves its original ready evidence intact. Progress commits are limited to four
per second plus phase completion; permission and cancellation checks still run
between every copy block. Recovery does not use progress counts as checkpoints. Interrupted operations
prepared by the previous copier keep their original retained-version identity.

A synthetic 64 MiB local worker-pipeline comparison measured 2.48–2.80 seconds
before these changes and 0.39–0.45 seconds after, including upload, preparation
and application. This excludes HTTP/UI scheduling and real authorization work.
On a disposable macOS SMB mount, a separate 32 MiB transfer-loop test measured
45–57 MiB/s with 8 KiB fragments and 174–182 MiB/s after batching; 64 KiB
fragments measured 141–148 and 157–164 MiB/s respectively. Both retained exact
bytes, bounded writes and fsync. This component test excludes journaling,
publication, HTTP and authorization. It ran over VM forwarding with synthetic
data, not the owner's NAS. Full SMB pipeline qualification stopped at a
publication identity check on the disposable share; that check remains intact.
These results do not establish Finder parity or full-app SMB throughput.

On servers advertising `source_original`, same-volume Rename, Move and Trash
relocate the original without reading its content. Put Back and Undo return that
object only while its observations, metadata and destination still match. These
operations preserve filesystem identity and attributes but are not backups: an
external writer can change the retained original. A directory relocation includes
hidden and untracked children without recursively copying them, with at most
1,024 affected catalog identities. Permanent directory deletion checks a bounded
metadata inventory (at most 4,096 entries and depth 64); the review-byte bound
may impose a lower limit. It refuses linked, special or cross-device descendants.
Deletion time depends on entry count and storage; it is not guaranteed instant.

Copy, Replace and older operations accept regular files and directories with at most 128
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
application. An already-open file can still be changed after capture. Copy and Replace retain
an independent recovery version; original relocation does not. Local synthetic tests do not qualify NAS storage,
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
