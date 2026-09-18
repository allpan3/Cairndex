# File replacement and Undo

Imports copy uploaded bytes, including copies from another directory of the same
library. The server does not read or remove a client source path. Library and
deployment write gates apply to import, Trash and Undo.

## Copy-import destination identity

Ordinary copies and Keep Both use independent catalog identities and do not
inherit the source's bundle membership. Skip writes nothing. An explicit
copy-import Replace of a regular file retains the cataloged **destination's**
`AssetFile.id`, bundle, ordering, file note/origin, bundle notes/rating/tags/
collections, cover/primary selections, external subtitle links, moments and
playback position/cursor. This also applies when source and destination are the
same path, and when the import does not request cataloging.

Replace preserves the destination's authored metadata; it does not transfer
metadata from a separately cataloged source. Moment coordinates, cover-frame
selection and playback position are retained without attempting to retime them
for a different edit of the media. An unlinked destination has no metadata to
retain. Uploads cannot replace directories or symlink entries.

## Copy-import bytes and derived media

The complete upload is staged before the original moves. Publication uses a
same-filesystem hard link followed by staging cleanup, so a newcomer at the
destination cannot be overwritten. Replace probes hard-link support using staged
bytes before moving the original. Unsupported storage returns a structured
refusal and leaves the original in place. A later publication or rollback failure
can still leave the original recoverable in Trash. The journal
references a separate Trash operation before the backup move. That Trash entry
holds the old bytes with no catalog-file ownership; the active destination retains its row.
Empty Trash removes the backup, disables its Undo, and does not delete the active
file or its metadata. Put back refuses an occupied path. If the active file is
moved elsewhere first, Put back restores the backup bytes as an unlinked file.

Replace and Undo refresh size, timestamp, filesystem observation and quick
fingerprint. They clear full-hash/probe/MIME results; thumbnails, previews,
contact sheets, storyboards, moment derivatives and converted external subtitles
validate their source fingerprint. Browser cover/image URLs change with the
source generation. Existing HLS sessions using the replaced video or burned
subtitle are closed so new playback cannot reuse old encoded segments.
Embedded subtitle stream records are regenerated for the new container. Undo
restores the original embedded track IDs and labels from the journal.

## Copy-import cancellation, recovery and Undo

Cancellation or disconnection during upload discards partial staging and leaves
the destination untouched. A publication failure restores the original when the
path remains vacant and filesystem permissions allow it. Interrupted imports use
the committed staging observation to distinguish published bytes from an untouched
old destination; interrupted Undo resumes its journaled inverse. Ambiguous external changes are refused
rather than overwritten or assigned a guessed identity.

Undo stashes the replacement bytes in recoverable Trash, restores the original
bytes and keeps retained destination metadata, including edits made after Replace.
For an originally unlinked destination, a row created for the incoming copy moves
with that copy to Trash; the original bytes return unlinked. Newer replacements
must be undone first. A completed Undo cannot execute twice.
Pre-existing import receipts retain their original Undo semantics; there is no
catalog migration or API schema change.

## Rename/Move Replace

Explicit in-app Rename/Move carries the source file's ID, bundle membership,
notes/origin, rating, covers, subtitle references, moments and playback references
with it. Replacing a destination never transfers or merges its metadata into the
source. The displaced destination retains its own ID, metadata and bytes in
recoverable Trash. An unlinked source stays unlinked; it does not inherit the
linked destination's bundle. Directory replacement moves the whole directory,
including its cataloged children; it does not merge directory contents.

For example, moving a mountain photo over a beach photo keeps the mountain
photo in its original bundle with its original rating and notes. The beach
photo and its metadata are recoverable from Trash. Undo returns both photos to
their original paths, retaining subsequent metadata edits. Put back requires a
vacant original path; Empty Trash permanently removes the displaced file and
its catalog row, and disables the corresponding Replace Undo.

New replacement moves record `relocation_protocol: 1`. Parent intent and linked
Trash receipts commit together before displacement. Recovery finishes an observed
move, or restores the displaced file when the source never moved and the target
remains vacant. A batch retains successful moves and reports failed paths. Undo
and Put back record their inverse intent before moving bytes; a restart or retry
can finish a partially applied inverse. Changed or occupied paths are refused,
not overwritten or assigned guessed identities. Older receipts keep their
historical recovery and Undo semantics; there is no journal migration.

Unchanged bytes retain their identity-bound derived caches and subtitle records.
Path-bound HLS sessions close before either file moves so an encoder cannot reuse
the vacated path for a different source. Skip, Keep Both and cancellation retain
their existing behavior. File-manager imports remain copy-only.

## Boundary and verification

Synthetic backend tests cover metadata, cancellation, failed publication,
interruption/restart, repeated/out-of-order Undo, Trash emptying and derivative
refresh. Real-backend browser tests cover copy, Skip, Keep Both, same-path Replace,
changed-image Replace, explicit Rename/Move collisions and the visible Undo
button. Rename/Move regressions cover both metadata sets, linked/unlinked
combinations, directory replacement, partial batches, occupied paths, direct
Put back and separate-process exits during displacement, movement and Undo. These
are supplemented by [bounded real NAS and Mac SMB checks](nas-verification.md).
They do not establish power-loss durability or OS drag delivery. Desktop OS
integration remains incomplete and paused.

Filesystem identity observations are conservative recovery evidence, not full
content verification. Cross-device moves use the existing copy/marker fallback;
an interruption without sufficient identity/marker evidence needs review. The
tested NAS-local filesystem supports hard links; the tested Mac SMB mount
refuses copy imports safely while same-share Rename/Move/Trash/Undo work. Other
mounts, cross-device recovery, hostile concurrent filesystem mutation and
power-loss durability remain unqualified. Copy-import publication requires
filesystem hard-link support.

The tested Mac SMB mount also rejects exclusive rename and file cloning for a
vacant target. An occupied-target error alone does not prove either can publish
a file. Ordinary rename can overwrite a concurrent arrival, and exclusive-create
copying exposes partial final bytes; neither is a supported fallback. See the
[capability matrix](nas-verification.md#mounted-smb-copy-publication). Mac-hosted
SMB compatibility remains required. The verified NAS-hosted topology is a
separate deployment scenario, not a substitute for this requirement.
