# Plan 6 — A folder as one item inside a bundle

> Status: **owner-approved design, not yet built** (design 2026-07-28, questions
> settled 2026-08-28). Supersedes
> [ADR-0024](../adr/0024-directory-groups-in-bundles.md), which was accepted and
> reopened before any of it shipped.
>
> The deferral this document was written under — "post-v0.1.0" — has expired:
> v0.1.0 shipped on 2026-07-28. It also referred to a tracking PR (#39) that no
> longer exists; the 2026-08-09 repository recreation dropped every open PR, and
> the work lives on branch `feat/folder-as-bundle-member` with no PR open. Per
> repository rules, opening one is the owner's call.

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
| **Explicit user-created groups** ([ADR-0024](../adr/0024-directory-groups-in-bundles.md)) | No answer to "where in the UI do I create a group?" that did not invent a new noun — neither bundle, collection, nor folder, with its own rules and gestures. |
| **Sub-bundles** (a bundle with a parent) | Workable, and heavier: see §6. |

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

## 4. Settled questions

The six questions §4 opened on 2026-07-28 are answered below, against the code
rather than from the sketch. None of them changed the design; two of them
(cover fallback, deletion) landed somewhere better than the answer the plan
guessed at, because the codebase already had the machinery.

### 4.1 Reversibility — two menu items, no undo machinery

The one the plan called "most worth designing up front" turns out to be the
cheapest, and for a structural reason worth stating: **the feature stores no
contents.** Only *which directories are entities* is recorded, so collapsing is
one row inserted and expanding is one row deleted. File rows, `AssetFile.id`s,
ratings, tags, notes and playback progress are untouched by both directions —
there is nothing to undo, because nothing was destroyed.

So reversibility is two context-menu items, not a journal:

- **"Expand folder into the bundle"** on the folder row — deletes the entity row.
- **"Collapse into a folder"** on a file row, or on a multi-selection whose
  members share one `directory_path` — inserts it.

The second one is worth more than reversibility. It gives the feature an entry
point outside the grouping dialog, on rows that already carry context menus, and
so answers ADR-0024's killer objection a second time: there is no "where do I
create one?" problem when the gesture lives on the thing it applies to and
invents no new noun.

### 4.2 Two routes to one file — collapse is bundle-scoped

The constraint is stronger than the plan assumed. `UniqueConstraint("relative_path")`
on `asset_files` ([models.py:283](../../apps/server/src/cairndex/persistence/models.py#L288))
makes a physical file linked *at most once library-wide*, so "two routes" can
never mean two rows. The only real case is a file whose `directory_path` falls
under an entity directory while its `bundle_id` points at a different bundle.

The rule: **a directory member collapses its own bundle's files and nothing
else.** An entity directory in bundle B hides B's files under that path; a
sibling filed into bundle C keeps its row in C and is not touched. The folder
row's count is therefore "files from this bundle in this folder", which is what
a member of B can honestly claim. Where the two diverge, the File Browser
handoff shows the folder as it actually is on disk — so the fuller truth is one
click away and never has to be summarized wrongly on the row.

No prohibition is needed, and the plan's guess ("a file inside an entity folder
cannot also be linked individually") is dropped: it would have to be enforced on
every path that assigns a `bundle_id`, to prevent a state that is merely
unusual rather than incorrect.

### 4.3 Cover fallback — a query, not a disk read

The plan's "obvious answer" was to read the first image inside from disk. Not
needed, and it would have been a filesystem walk in a request handler, which
AGENTS.md forbids. Because contents stay indexed (§2), the fallback is a query:
the first image among *this bundle's* files under the entity directory, in the
bundle's own file order, using the existing index on `asset_files.directory_path`.

That also makes the fallback cover a real `AssetFile` with a real id, so it goes
through the existing thumbnail cache instead of needing a second, folder-shaped
path through it. `cover_file_id` still never points at a folder — a folder is
not the cover; this is only what the grid draws when the bundle has nothing else.

### 4.4 Scan semantics — the one place the scanner must learn the concept

Two halves, and only the first needs new scanner behavior.

**Growth.** A file added to an entity directory should join the bundle that
directory belongs to, rather than be staged as its own provisional bundle under
ADR-0009. This is the behavior that makes the feature hold its value: the folder
goes on meaning "this folder", so an album stays one row as it grows instead of
sprouting a provisional bundle per drop. It is also the only point where the
scanner must consult the entity table.

**Renames (ADR-0006).** Move repair preserves `AssetFile.id` and rewrites
`relative_path`, which re-derives `directory_path` through the existing
`@validates` hook — so a renamed folder's files repair themselves, and only the
entity row is left stale. After repair: if every file formerly under entity path
`P` now sits under one new path `P'`, rewrite the row to `P'`. If they scattered
to several directories, the folder is not a folder anymore — delete the row and
let the files show individually. That is a visible, harmless failure, and it is
the right one, because the alternative is a row pointing at a path that no
longer exists.

Nothing else in the scanner changes: it keeps walking inside an entity directory
exactly as before, and the "flattening it back on the next pass" risk the plan
worried about cannot arise, because collapse is computed at read time from
`directory_path` and never written into membership.

### 4.5 Ordering — the entity row shares the file order's key space

The folder occupies one position among the bundle's file rows, so it needs a
`sequence` in the same integer space as `AssetFile.sequence`. The existing
reorder endpoint takes `FileReorder.ordered_ids`; it grows to accept entity-row
ids mixed in with file ids and resolve each against whichever table owns it.
Entity rows carry their own ULIDs, so the two id spaces cannot collide.

### 4.6 Deletion and write mode — one folder operation, not N file operations

Already answered by the write-mode layer. `file_ops/trash.py` models a trashed
entry with `is_directory` and moves a directory into the trash with a single
rename ([trash.py:100](../../apps/server/src/cairndex/file_ops/trash.py#L100)),
so the folder-level operation exists at the filesystem layer today.

One journaled operation per directory, then: one rename out, one rename back on
restore, with the metadata side removing the entity row and the file rows under
it. Per-file journal entries would be slower and would also admit a state nobody
asked for — half a folder restored.

### 4.7 Storage

Falls out of the above. A new table, `bundle_directory_members`:

| column | note |
| --- | --- |
| `id` | ULID, shares the reorder id space with `asset_files.id` (§4.5) |
| `bundle_id` | FK, `ON DELETE CASCADE` |
| `directory_path` | library-relative, matched against `asset_files.directory_path` |
| `sequence` | position among the bundle's file rows (§4.5) |
| `created_at` | |

`UniqueConstraint("directory_path")`, mirroring `asset_files.relative_path`: a
directory is an entity for at most one bundle. No column stores contents, which
is what makes §4.1 free.

## 5. Still open

1. **Nested entity directories.** Whether an entity directory may sit inside
   another one, and if not, what rejects it. Leaning no — it buys nothing the
   owner asked for and multiplies the read-time collapse rule.
2. **Threshold value.** §2 puts a file-count threshold on *proposing* a
   directory member in the grouping dialog. The number wants a real library to
   pick it, and is cheap to change because it only proposes.

## 6. Alternative considered: sub-bundles

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

## 7. Status

Design approved by the owner. The six questions opened with it are settled (§4)
and cost the design no changes; two of them landed better than the plan guessed,
because the write-mode trash layer and the `directory_path` index already had
what they needed. What remains is build order.

**S1–S4 are built** (2026-08-28). The slices, smallest
first, each shippable alone:

| slice | scope |
| --- | --- |
| **S1** ✅ | `bundle_directory_members` (§4.7), collapse/expand services, three API endpoints, 12 tests. Backend only; no UI yet, so nothing user-visible changes. |
| **S2** ✅ | Bundle inspector: the folder row, its count, the two context-menu items (§4.1), the File Browser handoff, exclusion from the playlist. |
| **S3** ✅ | Grouping dialog proposes a directory member above the threshold (§2). Threshold still wants a real library (§5.2). |
| **S4** ✅ | Cover fallback (§4.3, needed no code), scanner growth + rename repair (§4.4), trash verified (§4.6). |

S1 and S2 are the feature; S3 is what the owner asked for by name; S4 is what
keeps it correct over time.

Two things S1 settled that the design had not:

- **A folder row covers its subtree**, not just the directory whose path it
  holds. Matching the exact directory only would leave a nested album's files
  loose in the bundle, which is the problem the feature exists to solve, and it
  would contradict the File Browser handoff — that shows the subtree.
- **Nesting is refused** for now (§5.1), by the service rather than the unique
  constraint, which only catches the same path twice. Refusing costs one error
  message and can be relaxed; allowing it and then forbidding it would need a
  migration and a rule for the rows already nested.

Three things S2 settled:

- **Opening a folder needs its own action.** `onLocateFile` navigates to a
  *file's parent* and highlights the entry, which for a folder shows everything
  except what is inside it. `onOpenFolderInBrowser` navigates *into* the
  directory, which is what §2's "hands off to the File Browser, at that folder"
  actually asks for. Caught by running it, not by a test.
- **The playlist rule has two cases, not one.** Playing the bundle skips a
  folder's contents, but opening one *of* them pages through that folder —
  filtering them out unconditionally would strand the viewer on a file its own
  playlist said did not exist.
- **The album grid keeps showing every photo.** The owner's complaint named the
  inspector and the grouping dialog; a grid of a thousand photos is what an album
  view should look like. Only the rail collapses.

**§4.5 is withdrawn, not pending.** Folder rows are not draggable, and that is a
decision rather than a gap. It was built on 2026-08-29 — the reorder endpoint
taking visible rows, a folder moving as a block with its files — and reverted
the same day at the owner's call: "I don't think this is significant."

Worth keeping the reason, because §4.5 reads like an obvious requirement and
will invite rebuilding. Two things it missed. The rail's drag gesture has **no
visible affordance** — no grip, only a grab cursor and a tooltip — so the work
added an invisible capability to one more row. And ordering inside a bundle
barely matters for the shape this feature is *for*: an album bundle is a folder
and a file or two, and where the folder sits among them changes nothing anyone
looks at. The inconsistency §4.5 names is real — one row that could not move
while its neighbours could — but it is not worth the surface.

If reordering ever does matter, the thing to fix first is the missing affordance
for *every* row, not the folder row alone.

**S3 corrected this document's §2.** "A directory contributing more than a
threshold of files is proposed as a folder member rather than enumerated" assumed
the dialog's problem was a bundle proposal listing a thousand files. It is not:
the suggester turns a thousand-photo folder into a *collection wrapping a thousand
single-photo bundles*, and those thousand rows are the complaint. Annotating a
bundle proposal could never fire, because a bundle proposal's files always come
from exactly one directory. The working answer, owner-confirmed 2026-08-28: above
the threshold the folder becomes **one bundle whose single member is the folder**.

The threshold counts **subjects, not files**, which is the whole of the rule. A
flat folder of 300 releases is 900 files but 300 subjects of three — a video, a
cover and a subtitle sharing a stem — and must stay 300 suggestions. An album is
300 subjects of one. A first attempt thresholded on file count and swallowed the
release shelf, which is §3's movie-folder lesson at scale; an existing
performance test caught it.

**S4 found two of §4's answers were already true.** The cover fallback (§4.3)
needed no code at all: `effective_cover_file` already walks the bundle's own
files, and a collapsed folder's files are still its files, so a folder-only
bundle has always had a cover. The disk read §4.3 proposed would have been a
filesystem walk in a request handler, which AGENTS.md forbids — it is good that
it was never needed. Trash and Put back (§4.6) likewise already work over a
folder member unchanged, because trashing keeps the bundle. Both are now pinned
by tests instead of assumed; the §4.3 one exists specifically to fail the day
something filters covered files out of a bundle's file list.

What S4 did build is §4.4, both halves: a file landing in an entity directory
joins that bundle rather than being staged for review, and a renamed folder's
row follows its files. §4.6's remaining item — moving a whole folder in **one**
journaled rename rather than one per file — is an optimisation of how ADR-0013
journals, not a correctness gap, and is deferred to its own slice.

**Owner testing, 2026-08-28, found two faults the synthetic fixtures missed.**
Both were about the shape the plan opens with — a work whose extras live in a
subfolder — and neither showed up until a real library was scanned.

- *A folder holding one video and an album subfolder was suggested as a
  collection*, so the video became one bundle and the album another, and the
  thing the owner was looking at had no single row. §1's requirement says it
  plainly — "every item in the folder to be in a bundle (**along with other
  files not in the folder**)" — and S3 only ever handled the folder-alone case.
  Such a folder is now **one bundle**: its own media, with each album subfolder
  as a folder row. Deliberately narrow: it merges only when the folder's own
  media is a single subject and *every* child is an album, so two videos beside a
  folder, or a subfolder holding its own film with sidecars, still read as a
  collection.
- *Convert to bundle destroyed the folder row.* Converting merges the
  descendants' files into one bundle, and a folder row says how some of those
  files are drawn — so dropping it un-collapsed the album at the exact moment the
  owner said "this folder is one bundle", which is the likeliest thing to do to a
  folder that has one.

The lesson worth keeping: every fixture written for S1–S3 put the album *alone*
in its folder, so the case the plan was written about was the one case never
tested. The shapes now covered are album-alone, album-with-siblings,
album-beside-two-subjects, and album-beside-another-work.

A third owner report, same session: **looking inside a proposed folder was a
one-way door.** The only way to see what a folder held was "List files", which
declined it, and nothing undid that — so the question the dialog exists to answer
("is this folder desirable as a folder?") could only be answered by destroying
the answer. Now two controls: a disclosure that lists the contents read-only and
touches nothing, and a decline that is a reversible flag rather than a delete.
Worth recording as a design rule for this feature: **a control that reveals must
not also decide.**

§5's remaining item is the threshold value, which wants a real library.
