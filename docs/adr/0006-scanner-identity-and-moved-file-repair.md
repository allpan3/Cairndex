# ADR-0006: Scanner identity and moved-file repair

- Status: accepted
- Date: 2026-06-27
- Branch/PR: `feat/collections-and-file-view`

## Context

When a linked file is moved or renamed on disk, the previous scanner saw the old
path disappear (→ marked `missing`) and the new path appear (→ a brand-new
bundle). The user lost the bundle's collections, tags, rating, note,
cover/primary selection, and subtitle links, and ended up with a duplicate
bundle. `AGENTS.md` §5.3 calls for high-confidence moved-file repair that
preserves the `AssetFile` row (and therefore everything hanging off its bundle),
without full-hashing on the scan path (§5.1, §11) and without auto-merging
ambiguous or duplicate files.

## Decisions

### 1. Capture cheap filesystem identity during scans

`AssetFile` gains `filesystem_device`, `filesystem_inode`, and
`identity_available`. They come from the `stat()` the scanner already does
(`st_dev`/`st_ino`). Because network filesystems may expose unsigned 64-bit
identifiers while SQLite `INTEGER` is signed 64-bit, the scanner stores the same
bits in signed two's-complement form. Equality remains exact without changing
the schema. `identity_available` is false when either source value is zero
(some network filesystems report unstable/zero inodes), so untrusted identity
never drives a repair on its own. No extra I/O, no hashing.

### 2. Two-pass scan: update, then repair, then create

The scan now:

1. walks the root, updating same-path rows in place (a same-path content edit is
   an update, never a move);
2. computes the set of *appeared* paths and *disappeared* rows, and matches them
   1:1 for repair;
3. creates new bundles only for appeared paths that were **not** repaired.

Creation is deferred to after the full walk so repair can see every appeared and
disappeared path. The cost: a mid-walk cancellation commits same-path updates but
no new bundles (creation is atomic-after-walk), and the scan keeps one
lightweight record per appeared path in memory (same order of magnitude as the
existing "all rows for this root" map). Acceptable at single-owner scale; revisit
with chunked repair if libraries get large enough to matter.

### 3. High-confidence matching, unambiguous only

A disappeared row matches an appeared path when **either** the trusted
filesystem identity is identical (strongest — survives content edits such as a
re-annotated PDF on the same volume) **or** the quick fingerprint (`size:mtime_ns`)
*and* the basename are identical. A repair is applied only when an appeared path
has exactly one candidate row **and** that row is the candidate of exactly one
appeared path. This rejects ambiguous moves and means a *copy* is never merged: a
copy's original is still present, so it is not a disappeared row and offers no
candidate. Full/sampled hashing is intentionally not used on the scan path.

### 4. Access-time staleness check

`media.playback.resolve_file_path` (used by streaming, thumbnails, subtitles, and
file-content serving) re-checks existence at access time; if the file has
vanished it marks the row `missing` and returns a clear error. Automatic repair
is left to the next scan/rescan.

### 5. Explicit repair of an already-linked replacement

If the automatic scan match fails, the appeared path becomes its own linked row.
Later scans update that row and therefore no longer treat it as an appeared path;
rescanning alone cannot reconsider the move. Missing Files exposes an explicit
relink only when all of these remain true at request time:

- the old row is still missing and its old path is still absent;
- exactly one missing row and exactly one available row share the same media
  kind and quick fingerprint (`size:mtime_ns`);
- re-statting the available path yields that same fingerprint.

The owner action permits a changed basename because it is an explicit choice,
not an automatic scan guess. Apply deletes the duplicate available row, updates
the original row to the live path, and preserves the original `AssetFile.id`,
bundle metadata, file-level metadata, relational references, and the newest
playback progress. It never modifies either filesystem path. Zero or multiple
matches produce no action; arbitrary-path and content-changed repair remain
future workflows.

## Consequences

- Same-volume moves/renames preserve `AssetFile.id`, the bundle, and all
  metadata; no duplicate bundle, no lost organization.
- A rename whose network-filesystem identity changes can be explicitly repaired
  after the conservative automatic match misses it, provided the quick
  fingerprint is still unique. Cross-filesystem move *plus* edit may still lack
  a candidate because its content signals changed. Duplicate detection remains
  out of scope.
- New nullable identity columns are backfilled lazily by the next scan.
