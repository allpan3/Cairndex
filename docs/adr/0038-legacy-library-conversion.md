# ADR-0038: Owner-started conversion of legacy libraries

- Status: accepted by the product owner (2026-10-12)
- Date: 2026-10-12
- Amends: ADR-0035 (owner conversion is now an application operation)

## Context

ADR-0035 removed old `cairndex.library` packages from the application and left
their conversion to the owner, with `CONVERSION_AVAILABLE = False`. Libraries
that v0.2.1 and earlier versions created therefore cannot open. Their metadata
(bundles, tags, collections, notes, ratings, moments, subtitles and Smart
Collections) is in `.cairndex/library.db` next to the media.

A real library is often a multi-terabyte NAS folder. A complete copy of the
folder needs double the space and many hours, so "convert a separate copy" is
not practical for media. The metadata folder is small and can be kept intact.

## Decision

The owner starts conversion for one old library from the app. Conversion has
three explicit steps, and each step refuses to continue when its checks fail.

1. **Inspect** (read-only). The manifest must be `cairndex.library` version 1
   with the standard layout. The library database must pass SQLite integrity
   and foreign-key checks, and every table and column must belong to a known
   historical schema. A fresh ownership lease from another server refuses
   conversion; a stale or unreadable lease needs the owner's confirmation that
   no other server serves the library. The report gives counts of what converts
   and of what does not.
2. **Prepare** (private). Copy the quiescent database, WAL and rollback journal
   into private server storage. SQLite recovers and validates that copy. The
   original database is never opened in place. A normalized copy fills columns that older versions
   did not have with the defaults that their additive upgrades used. The
   existing format-three converter seeds immutable objects from that copy,
   reconstructs an independent private catalog, and exports it back to compare
   every authored cell. Nothing in the library folder changes.
3. **Activate** (owner confirmation of the exact review). The library database
   must be unchanged since preparation. The new package is staged in a hidden
   folder in the library root. The old `.cairndex` folder is renamed to
   `.cairndex-legacy-<attempt>`; its contents do not change. The staged folder
   then becomes `.cairndex`. The library is registered, or its registry row
   changes to the portable format. A private intent records each step, so an
   interrupted activation finishes or reverses on retry. Publication rechecks
   the original after staging. Linked staging paths and occupied names are refused.
   The no-replace rename checks vacancy atomically. A mounted SMB stat can stay
   positive after a completed rename. The known manifest is refreshed before
   checking the newly published or restored metadata format.

**Undo** reverses the two renames while the library is released. It keeps the
converted folder as `.cairndex-converted-<attempt>`. Edits made after conversion
stay in that folder; Undo does not merge them back.
The private working store is also retained. A repeated completed Undo does not
rewind later edits in the restored legacy library.

Library IDs, bundle and file IDs, relative paths, relationships and authored
values are kept. These do not convert, and stay only in the backup folder:
resume positions and last-opened times (ADR-0035 leaves Recently Used and
cross-device resume as separate work), pending grouping suggestions, derived
caches, the old passphrase hash (ADR-0035: no legacy passphrase import),
files in the old in-package trash and import staging folder, and tables and
columns that earlier versions stopped reading. The report counts each kind of
owner data among them, so the owner can decide before activation.

Media files are never read for conversion, moved, renamed or deleted. Old
versions of the app see a format they do not support and refuse the library,
so they cannot write to it after conversion.

## Alternatives

- **Copy the whole library and convert the copy.** Keeps every original byte
  in place, but needs double the storage and is slow on a NAS. Rejected by the
  owner for real libraries; the owner can still convert a copy.
- **Convert automatically when an old library opens.** No review, and ADR-0035
  rejects automatic in-place upgrades. Rejected.
- **Keep the old app path for old libraries.** Two metadata models in one app.
  Rejected by ADR-0035.

## Consequences

`CONVERSION_AVAILABLE` becomes `True` for this owner-started path only. The
developer fixture path stays separate. A library that a NAS container serves
with an old version must be released there first, and that container needs the
new version before it serves the converted library. Power-loss durability of the
two renames is not established beyond fsync of the parent directory.
