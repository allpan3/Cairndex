# ADR-0042: A file copy publishes its own version

- Status: accepted by owner; implemented; owner-NAS qualification pending
- Date: 2026-11-09
- Amends: ADR-0036's copy contract; keeps ADR-0041

## Decision

A file Copy no longer writes a second, independent output. The copy's own
source version — the upload, which was hashed as it arrived, or the operation's
snapshot of a library file — is moved into the output stage and published by
the existing no-replace rename. Nothing is kept beside the published file.

Directory copies, Replace's displaced destination, Restore a Copy and Undo keep
the independent-copy contract of ADR-0036.

An owner action in Trash, **Delete Kept Copies…**, permanently deletes the
second copies that earlier versions kept for completed copies. It needs write
mode and a confirmation, skips any version an unfinished operation refers to,
and checks each file's type and size just before deleting it. It deletes only
Cairndex's private files under `.cairndex/source-operations/`, never library
media, so it is not a journaled source operation.

## Why

Every copy read and wrote each byte over the share twice and kept one complete
duplicate in the hidden operation directory, with no expiry and no action that
could remove it. On the disposable test share in the build VM, a synthetic
1 GiB copy took 7–10 s to transfer and another 7–8 s to save. Server-side copy
(`copyfile`) took 3 s, but re-reading the result to check its hash took
10–12 s, so it was no faster. A library with a history of large copies can hold
tens of gigabytes of these duplicates.

Nothing needs the duplicate. Undo of a copy snapshots the published output
before removing it. A file sent from another computer is still there, and a
library file copied within the library is still at its source path.

## Consequences

- A copy's publication no longer re-hashes the bytes. Instead, review records
  the version's inode, size and modification time (`version_stamp`), and
  application refuses a version whose stamp changed. This detects an observable
  external write, as the digest check did; neither proves that no writer
  concealed a change.
- Restore a Copy of a copy's output refuses with a clear message, because no
  separate version exists. Restore a Copy of Replace's displaced version is
  unchanged.
- One upload serves one completed copy. A second copy from the same upload is
  refused; the client already gives every copy its own upload.
- An interrupted publication can resume after the move: it hashes the staged
  file once and continues only when the digest matches the recorded evidence.
- Reviews prepared before this change have no stamp and still use the
  independent copy when they are applied.
- Copy-based Rename and Trash versions from before ADR-0041 are not touched by
  Delete Kept Copies. Undo of those operations still needs them.
