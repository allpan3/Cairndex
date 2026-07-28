# Plan 6 — A folder as one item inside a bundle

> Status: planning document (2026-07-28), **owner-approved design, deferred to
> post-v0.1.0**. Supersedes [ADR-0021](../adr/0021-directory-groups-in-bundles.md),
> which was accepted and reopened before any of it shipped. Nothing here is
> built. Tracked by an open PR that is deliberately **not** to be merged until
> the work is done.

## 1. The problem

Owner, 2026-07-28:

> In the filesystem my expectation is to have a folder that contains a lot of
> files, e.g. a photo album. I want every item in the folder to be in a bundle
> (along with other files not in the folder). Clearly, it won't be manageable if
> the 1000 photos show up individually (e.g., all show up in the group
> suggestion dialog, and in the bundle inspector).

A bundle must hold a thousand files without listing a thousand rows — in the
inspector, and in the grouping-suggestion dialog.

## 2. The design

**A bundle member may be a directory.** It occupies one row, wherever it sits in
the bundle's order, and behaves as a single thing.

- **Opening it hands off to the File Browser**, at that folder. From there,
  double-clicking a file opens it in the player with next/previous navigation —
  functionality that already exists and needs no new viewer mode.
- **Its files stay out of the parent's playlist.** "Play this bundle" plays the
  bundle's own media, not the thousand photos inside a folder member. The
  owner's analogy is subtitles: present in a bundle without being something you
  play through.
- **A folder is never the cover, and carries no rating.** Both were explicitly
  dropped — a folder is a container, not a work.
- **A folder is always a real filesystem folder.** There is no way to gather
  scattered files into one, which is what keeps the concept explainable: a
  folder is a folder.

### Contents stay indexed

The one amendment to the owner's sketch, accepted in discussion. The files
inside an entity folder remain ordinary `AssetFile` rows belonging to the
bundle. Only *which directories are entities* is stored; membership is
unchanged, and files whose `directory_path` matches simply collapse under the
folder row and drop out of the playlist.

Without this, everything inside loses search, tags, ratings, missing-file
detection, and **playback resume** — and the owner's own example is "an album
for a bunch of short videos", where resume matters. Indexing keeps the library
whole underneath a simpler surface, and satisfies the original requirement
literally: *every item in the folder is in the bundle*.

### Where the decision is made

**In the grouping-suggestion dialog** — the place the user already confirms what
a bundle is. A directory contributing more than a threshold of files is proposed
as a folder member rather than enumerated; the user accepts or declines with the
rest of the proposal.

This is what makes the design work where its predecessors failed. The threshold
decides only what to **propose**, never what to do, so it can be wrong cheaply:
a movie folder suggested as an entity costs one decline, where a wrong automatic
collapse would hide a bundle's content.

## 3. Why the earlier attempts failed

Recorded because each was killed by a specific, reusable argument.

| attempt | why it died |
| --- | --- |
| **Automatic grouping by folder** | A movie folder is film + subtitles + poster + cover: several files, one directory, and not an album. |
| **Automatic grouping by folder + media kind** | An album is often short videos *and* images together — screen captures, contact sheets. Mixed kinds, still one album. |
| **Explicit user-created groups** ([ADR-0021](../adr/0021-directory-groups-in-bundles.md)) | No answer to "where in the UI do I create a group?" that did not invent a new noun — neither bundle, collection, nor folder, with its own rules and gestures. |
| **Sub-bundles** (a bundle with a parent) | Workable, and heavier: see §5. |

The first two are the same lesson twice. An album and a movie folder are
indistinguishable from file properties, because the difference is not in the
files — it is what the folder *means*, and only the person who filed it there
knows. No heuristic can close that gap, which is why the threshold in §2 only
ever proposes.

**A withdrawn objection.** An early reading held that a folder inside a bundle
collided with `product-brief.md:67/124`. It does not: those forbid bundle
*identity* depending on a folder, not a bundle *containing* one. The misreading
steered two rounds of design away from the simplest answer, and is recorded so
it is not made again.

## 4. Open questions

None blocking; all judged fixable at reasonable cost by the owner.

1. **Reversibility.** The threshold will sometimes be wrong. "Expand this folder
   into the bundle" and its inverse must exist, or a bad scan decision is
   permanent. This is the one most worth designing up front.
2. **Two routes to one file.** `UniqueConstraint("relative_path")` guarantees a
   file is linked once. A folder member plus a separately linked file from
   inside it puts that file in the bundle by two routes. Needs a rule — most
   likely: a file inside an entity folder cannot also be linked individually.
3. **Cover fallback.** A bundle whose only member is a folder has no cover and
   would render blank in the grid. Obvious answer: the first image inside, read
   from disk.
4. **Scan semantics.** The scanner must keep walking inside an entity folder
   (contents stay indexed) without flattening it back into the bundle on the
   next pass. Interacts with ADR-0006 move repair.
5. **Ordering.** A folder member occupies one position among the bundle's files
   and should be reorderable like any other row.
6. **Deletion and write mode.** Trashing a bundle containing a folder member —
   per-file journal entries under ADR-0013, or one folder-level operation?

## 5. Alternative considered: sub-bundles

The owner first proposed nesting bundles: a sub-bundle with a parent, not
browsable at top level, not eligible for collections, entered rather than played
through. Then reconsidered it as "kind of messy".

It was a real contender — it reuses an existing noun and existing creation
flows, and an album arguably wants a bundle's title, cover and ordering. Two
costs decided it:

- **Exclusion becomes an invariant.** **12 modules** touch `AssetBundle` —
  browse, counts, search indexing, the filter compiler behind Smart Collections,
  grouping, manual bundling, scanning, file operations. A sub-bundle must be
  invisible in every one, and a missed case is a bug the user finds. It would
  need a single enforced "top-level bundles" predicate at a shared query seam,
  which may not exist yet.
- **A directory member has no such problem.** It is not a bundle, so it cannot
  leak into any listing of bundles. The entire class of bug disappears rather
  than being defended against.

Nesting also brought depth limits, promotion/demotion, and cover inheritance —
all of which fall away when the member is a folder.

## 6. Status

Design approved by the owner; implementation deferred to post-v0.1.0. The
tracking PR stays open as the home for this work, and this document is where the
open questions in §4 should be answered as they are settled.
