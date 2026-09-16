# Copy-import Replace and Undo

Imports copy uploaded bytes, including copies from another directory of the same
library. The server does not read or remove a client source path. Library and
deployment write gates apply to import, Trash and Undo.

## Destination identity

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

## Bytes and derived media

The complete upload is staged before the original moves. Publication uses a
same-filesystem hard link followed by staging cleanup, so a newcomer at the
destination cannot be overwritten. Filesystems that refuse hard links reject
publication; failed rollback leaves the original recoverable in Trash. The journal
references a separate Trash operation before the backup move. That Trash entry holds the
old bytes with no catalog-file ownership; the active destination retains its row.
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

## Cancellation, recovery and Undo

Cancellation or disconnection during upload discards partial staging and leaves
the destination untouched. A publication failure restores the original when the
path remains vacant and filesystem permissions allow it. Interrupted imports use
the committed staging observation to distinguish published bytes from an untouched old destination; interrupted
Undo resumes its journaled inverse. Ambiguous external changes are refused
rather than overwritten or assigned a guessed identity.

Undo stashes the replacement bytes in recoverable Trash, restores the original
bytes and keeps retained destination metadata, including edits made after Replace.
For an originally unlinked destination, a row created for the incoming copy moves
with that copy to Trash; the original bytes return unlinked. Newer replacements
must be undone first. A completed Undo cannot execute twice.
Pre-existing import receipts retain their original Undo semantics; there is no
catalog migration or API schema change.

## Boundary and verification

Accepted [ADR-0013](adr/0013-library-write-mode.md) defines destination identity
retention. The copy-import path follows it. Rename/Move still carry the source
identity to the destination and trash the displaced row. When both are linked,
the source-identity rule in ADR-0013 §4 and destination-identity wording in §5
require a separate decision about their two sets of authored metadata. This
remaining disagreement is explicit in the [audit ledger](audit-status.md).

Synthetic backend tests cover metadata, cancellation, failed publication,
interruption/restart, repeated/out-of-order Undo, Trash emptying and derivative
refresh. Real-backend browser tests cover copy, Skip, Keep Both, same-path Replace,
changed-image Replace and the visible Undo button. These are local checks, not
NAS/power-loss qualification or OS drag-delivery evidence. Desktop OS integration
remains incomplete and paused.
