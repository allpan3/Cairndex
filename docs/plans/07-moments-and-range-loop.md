# Plan 7 — Moments, and the range loop they carry

> Status: **built, awaiting the owner's pass in the app** (design 2026-08-29, all
> four flagged decisions kept as written; S1–S5 built the same day). Branch:
> `feat/moments`.
>
> The two consequential decisions are recorded as
> [ADR-0025](../adr/0025-moment-tag-propagation.md) (one-way tag
> propagation) and [ADR-0026](../adr/0026-armed-range-loop.md) (the armed range loop).
>
> **One departure from the design, made while building it:** an unmarked video
> shows *nothing* in a pane with no playhead. §5.1 planned an empty state
> everywhere, which would have put a permanent "press B while playing" hint — and
> its height — on every video bundle's rail, in a pane where `B` does nothing.
> The invitation now appears only in the viewer's docked rail, where it can be
> taken up; a bundle that *has* moments shows them in both.
>
> **Also fixed on the way, found by the new e2e:** `ContextMenu` dismissed
> itself. Clicking a row's `⋯` near the edge of a scrollable rail focuses it, the
> browser scrolls it into view in the same dispatch, and the scroll listener
> closed the menu that click had just opened. Scroll/resize dismissal now arms a
> frame later, so the opening gesture's own scrolling does not count. Every rail
> row deep enough to need scrolling had the same fragility.

> **Terminology (owner, 2026-08-29, extended 2026-08-30):** **Moments**, and the
> player's span picker is a **Range**; looping between its ends is the **Range
> loop**. The rename goes all the way down — table, model, routes, hooks, CSS —
> rather than stopping at the labels: the owner deleted the moments they had, so
> there was nothing to migrate, and the feature has not shipped in a release, so
> there was no API to break. A library that opened the branch before the rename
> has its two `key_moment*` tables dropped on the next open.

## 1. The problem

Owner, 2026-08-29:

> I want a way to create and save "moments" for videos, which can be a frame
> or a range. It will show up in the bundle inspector. We can add tags or
> comments for each moment. The tags are the same as the bundle tags, and any
> moment's tag will become bundle's tag as well. The interface needs to be
> clean and compact.
>
> And related to this, we can also enable A/B looping as part of this feature. We
> already have range functionality implemented. The infrastructure should be the
> same.

Two asks that are one feature. A moment that is a *range* is an loop pair, so
"save a moment" and "save an range loop" are the same act, and looping a saved
moment is the loop replay [plan 1](01-web-media-player-and-viewer.md) §2 has been
holding open since 2026-07-11.

## 2. The design

**A moment is one instant, or one span, inside one video file, with an
optional comment and any number of tags.** Nothing about it is derived: the owner
marked it deliberately, and it survives everything the file survives.

- **A frame or a range, in one row shape.** `end_s IS NULL` means a frame. A
  range carries both ends. Not a `kind` enum with two always-present columns:
  that admits `start == end`, which is neither a frame nor a legal range, and it
  would need `MIN_CLIP_SECONDS` to adjudicate.
- **Ordered by time, never by hand.** A moment list is a timeline; a manual order
  would be a second truth with no gesture asking for it. Ascending `start_s`,
  tie-broken by `id`.
- **Tags are the library's tags.** The same vocabulary, the same picker, the same
  hierarchy and groups — a moment's tags are rows in `tags`, exactly as a
  bundle's are.
- **A moment's tag becomes the bundle's tag, on assignment, additively.** See
  §4.1: this is the one consequential semantic in the feature.
- **Metadata only.** Marking, tagging, commenting, and deleting a moment write
  rows in the library DB and touch no file and no filesystem, so none of it needs
  the write-mode gate (ADR-0013).

### The range loop is a saved moment, armed

Today's clip range already holds the span and already loops it —
`useClipRange`/`useClipPlayback`, shipped M11. Two things are missing, and both
are small:

1. **Loop must survive a pause.** The picking session ends on *any* pause by
   deliberate decision (owner, 2026-08-16: the span is something you play, not a
   mode that quietly redefines the play button). An range loop is the opposite — it
   stays until you turn it off. So `useClipPlayback` gains a third mode:
   `off` / `session` (today, unchanged) / `armed`.
2. **A saved moment can arm it.** A range moment's row in the inspector has a
   loop button: it loads that span into the live clip range and arms it. That is
   the whole of "saved range loops", with no second model.

While armed, the seek band, the lit Loop control, and the clip bar are all on
screen, so the mode is visible rather than quiet — which is the distinction the
2026-08-16 decision actually drew (see §4.2). Armed enforces only the out-point:
seeking *before* the in-point is not yanked back, because watching the run-up
into a marked span is a real thing to want.

## 3. Storage

One table and one association table, both mirroring shapes the library already
has.

```python
class Moment(Base):
    __tablename__ = "moments"
    id: UlidPk
    bundle_id: FK asset_bundles.id ON DELETE CASCADE, indexed
    file_id:   FK asset_files.id   ON DELETE CASCADE, indexed
    start_s:   float
    end_s:     float | None   # NULL = a frame
    comment:   str | None     # Text
    created_at / updated_at / version

moment_tags = Table(
    "moment_tags",
    moment_id  FK moments.id ON DELETE CASCADE, primary_key
    tag_id     FK tags.id        ON DELETE CASCADE, primary_key
    Index("ix_moment_tags_tag_id", "tag_id")   # like asset_bundle_tags
)
```

`CheckConstraint("end_s IS NULL OR end_s > start_s")` and
`CheckConstraint("start_s >= 0")`.

**Why both `bundle_id` and `file_id`.** `file_id` is the truth — a moment is
inside a video. `bundle_id` is carried so the inspector reads a bundle's moments
in one indexed query, and so the tag-propagation target is on the row.
`PlaybackProgress` is the precedent, and it also supplies the maintenance: the
existing `before_flush` listener that repoints `playback_progress.bundle_id` when
a file is reparented gains `moments` alongside it, so a file moved between
bundles takes its moments with it.

**Bootstrap.** A new table, so it joins `_ADDITIVE_CONTENT_TABLES` in
`persistence/engine.py` and a library that predates the feature gains an empty
one — which is the correct starting state. No additive columns, no backfill, no
migration chain (there is none).

**Lifecycle, all of it free.** Deleting a bundle or forgetting a missing file
cascades. Moved-file repair preserves `AssetFile.id`, so a renamed file keeps its
moments. Trashing repoints the file row rather than deleting it, so a restore
brings the moments back with it. Each of those gets a test rather than a comment.

## 4. Decisions taken

### 4.1 Propagation is one-way: assignment adds, nothing un-adds

Adding a tag to a moment adds it to the moment's bundle. Removing it from the
moment does **not** remove it from the bundle, and neither does deleting the
moment.

The alternative — bundle tags as the *derived union* of own tags and moment tags —
was priced and rejected. It would mean every tag read, every tag count, every
filter compilation, and every Smart Collection learning about a second source,
for a fact that is a one-line write on assignment.

One-way is also the honest semantic. A propagated tag and a directly-assigned one
are the same row in `asset_bundle_tags`; there is no way to tell them apart, so
un-propagating would sometimes remove a tag the owner set on the bundle by hand.
And the bundle-level claim outlives its evidence: a bundle that contained
something at 1:23 still contained it after the marker is tidied away. The union
matches **Paste Tags**, which already adds without replacing, and the way out is
already built — *Remove from This Bundle* on the pill.

This is the decision most worth arguing with, so it gets an ADR rather than a
comment.

### 4.2 Armed range loop, and the 2026-08-16 decision it extends

On 2026-08-16 the owner rejected a range mode that redefined the play button:
Space had to stay ordinary playback. An armed range loop *does* confine Space —
which is an extension of that decision, not a contradiction of it, on the reading
that what was rejected was the **quiet** redefinition: a mode you could be in
without knowing, because a marked span looked identical whether or not it was
governing playback.

Armed is not quiet. The clip bar is open, the Loop control is lit, the seek band
is drawn, and one click on the same control turns it off. Disarms on file change,
on closing the clip bar, and on clearing the marks.

Flagged explicitly because it is the owner's call to reverse. The fallback, if
they want the old boundary held exactly: range loop confines only playback that was
*started* from the loop control, and Space outside it stays unconfined — which is
today's session behaviour, and means an range loop cannot survive a pause.

### 4.3 The hover picture: a storyboard tile, then a pre-cut clip

**As planned.** Each row shows a small frame from the storyboard sheet that
already exists for every scanned video, cropped client-side by `StoryboardTile` —
the same component the seek-bar hover tooltip uses. No new endpoint, no new
cache, no ffmpeg run on the request path. A video with no storyboard yet shows
the row without a thumb and says nothing about it.

**As built (revised 2026-08-30, twice).** The thumbnail column went away — at 48px
a row, a stack of them made the rail bulky for a picture you only want while
deciding which moment a row is — and became a hover preview above the row. A
range then wanted to *move*, and that took two attempts:

1. **A GIF generated on the hover.** Rejected: the build is the wait, and it is
   in front of the picture rather than behind it.
2. **Streaming the original and seeking to the in-point.** Correct and
   cache-free, and still too slow, for two reasons that only measurement
   separated. Roughly 340ms of a ~400ms wait was two of our own constants (an
   arm delay before anything loaded, then a fade after it was already playing);
   the rest is inherent to the approach — an accurate seek makes the decoder run
   forward from the preceding keyframe, measured at 14ms landing just after one
   and 123ms landing just before the next on a 1080p/30fps file, and worse as
   resolution and GOP length grow. It also showed the *wrong frame* while
   loading: the storyboard grid is sampled every 2 to 30 seconds, so the tile
   for an in-point is usually from before the range starts.

**So: two pre-made artifacts** (`media/moment_previews.py`), 480px, cached under
`.cairndex/cache/moment-previews/`.

**A poster frame** — one frame decoded at the marked instant — for *every* moment.
This is what fixed the wrong-frame half, and it is the whole of the fix for a
frame moment, which had nothing but the stale tile and no second act to correct
it. Queued when the moment is saved, because it is the picture rather than the
motion and one frame is a keyframe seek and a JPEG; roughly 1KB each.

**A clip of the span** for a range, muted and faststart, keyed by the source's
quick fingerprint *and* the span. It plays from byte 0 — no header round trip, no
seek, no decode-forward — and its own first frame is the in-point too, so nothing
in the stack ever shows the wrong frame. Measured on the same 1080p source: 385ms
to first moving frame streaming, 181ms from the clip. Cut lazily on first hover
(owner's choice), since a range has the streaming path to fall back on.

The two share a moment id, so their cache paths differ *before* the extension:
`derived_cache` derives the fingerprint sidecar and the lock with `with_suffix`,
so `{id}.mp4` and `{id}.jpg` would both resolve to `{id}.fingerprint`. That was
the first shape of this code, and it meant the clip's fingerprint overwrote the
poster's — so every range moment's poster failed `is_current` forever, fell back
to the stale tile on every hover, and silently re-encoded itself each time. A
frame moment, having one artifact, looked perfectly fine, which is how it got
through a round of testing.

The difference from attempt 1 is *when* it runs, not *what* it makes. The route
answers 404 until the cut lands and the request is what queues it, so the client
keeps the streaming path meanwhile and no hover ever waits on ffmpeg. That also
makes the cache disposable in the way every other derived artifact is: empty
`.cairndex/cache/` and previews still work, just at the streaming speed, and the
clips come back as rows are hovered.

MP4 rather than the GIF originally asked for: 8-84KB per five-second span against
megabytes, no 256-colour dithering, and no length cap forced by size.

Both are served `immutable` for a year, so the URLs carry the moment's `version`.
The server rebuilds when a span moves, but the URL is not content-addressed, and
without the version the *browser* would hold the picture of where the span used
to be. Not reachable from the UI — re-marking makes a new moment — but `PATCH`
can move one.

### 4.4 One tag picker, not two

`TagEditor` is currently bound to a bundle: it calls `useBundleTags` and
`useSetBundleTags` directly. Its picker is the expensive part — search with
pinyin, group filters, foldable hierarchy, the shown Enter target, create-with-
`/`, copy/paste — and a moment needs every bit of it.

So the picker is extracted as `TagPicker`, driven by `{ assigned, onSetTags }`,
and `TagEditor` becomes the bundle-bound wrapper over it. A moment's tags are a
second thin wrapper. This is the largest piece of frontend work in the plan and
the only refactor of existing code; without it the second copy diverges by the
second week.

### 4.5 Where the section sits

Inspector order becomes: cover, title, Rating/Files/Size/Date Added, Notes, Tags,
Collections, **Moments**, Files.

Last of the content sections and directly above the file rail, because the two
lists then sit together and the moments read as "inside the videos" that the rail
below enumerates. A bundle with no video shows no section at all.

### 4.6 Duplicates are allowed, but `B` will not make one by accident

Two moments may share an instant — different comments, different tags — so there
is no unique constraint. But pressing the capture key twice at one frame is a
slip, not an intent: when a frame moment already exists within one frame of the
playhead, capture selects that row instead of adding a second, and says so.

## 5. Surfaces

### 5.1 Bundle inspector — the Moments section

One line per moment when it has nothing else to say; it grows only for the tags
and the comment it actually has.

```
KEY MOMENTS  3                                              [+]

┌────┐  0:12.400 → 0:17.900   5.5s                    ▶  ⟳  ⋯
│thmb│  [establishing] [+]
└────┘  the comment, if there is one

┌────┐  1:23.480                                      ▶     ⋯
│thmb│  [+]
└────┘
```

- **Timecode** in `M:SS.mmm`, the same `formatClipTime` the clip bar prints, so a
  moment and the marks that made it read identically. A range shows both ends and
  its length.
- **Actions on the right**, where the file rail keeps its actions, revealed on
  hover/focus: play from here (`▶`), arm the loop (`⟳`, ranges only), and a menu
  (edit comment, replace the span with the current marks, delete).
- **Tags** are chips with a bare `+`, not the `+ Tag` button the bundle uses —
  the section header already says what these are.
- **The comment** is one clamped line; clicking it opens the same auto-growing
  textarea the note boxes use, committed on blur.
- **Grouped by file** with a quiet file-name subheading, but only when the bundle
  has more than one video with moments. One video means no subheading.
- **`+` in the header appears only in the viewer's docked inspector**, where
  there is a playhead to capture. In the shell rail the header shows the count
  alone, and the empty state says how to make one.
- **Empty state**: *"No moments. Press `B` while playing to mark one, or mark
  a range in the clip bar and save it."*

### 5.2 Viewer

- **`B` captures at the playhead.** With a span marked in the clip bar it saves
  the *span*; otherwise it saves a *frame*. One key, and the clip bar is already
  the range editor. A toast confirms with the timecode, through the existing
  `mv-toast` anchor.
- **Clip bar gains `★ Save Moment`**, beside `Save GIF…`, saving the marked span.
- **`⟳ Loop` becomes the arm toggle** (§2, §4.2). `Play Range` (`\`) is
  unchanged: play once, stop at Out.
- **Settings menu** gains *Loop range* next to *Loop file*, disabled with an
  explaining title when nothing is marked. Discoverability, and where plan 1 said
  the toggle would live.
- **Seek-bar markers**: a tick per frame moment, a thin band per range, in a
  colour distinct from the amber clip band. Non-interactive for now
  (`pointer-events: none`) — the track's own `pointerdown` scrubs, and a
  click-target competing with it is a separate design problem. The existing hover
  tooltip gains the moment's comment when the hovered time falls inside one.

Navigation keys between moments (`Alt+←/→`) are deliberately **not** in this
plan; the rail is the way to jump. Cheap to add if the owner wants them.

## 6. API

Bundle-scoped, like directory members and for the same reason: the inspector
reads them by bundle, and the bundle is the route scope everywhere else. `file_id`
is validated as a member of the bundle. No write-mode gate.

```
GET    /api/v1/libraries/{lib}/bundles/{id}/moments
POST   /api/v1/libraries/{lib}/bundles/{id}/moments            201
PATCH  /api/v1/libraries/{lib}/bundles/{id}/moments/{mid}      If-Match
PUT    /api/v1/libraries/{lib}/bundles/{id}/moments/{mid}/tags
DELETE /api/v1/libraries/{lib}/bundles/{id}/moments/{mid}      204
```

`MomentRead` carries `tag_ids` **inline**, unlike the bundle's separate
`/tags` endpoint. A list of moments each fetching its own tags is N+1 on the
inspector's hot path, and the inspector is docked beside a playing video.

The tags `PUT` answers with the bundle's resulting tag ids as well as the
moment's, so the bundle's chips update from the same answer that changed them
rather than from a later refetch that can disagree — the reasoning
`reorder_bundles` already uses.

Server-side validation is `start_s >= 0` and `end_s > start_s`. Clamping to the
file's duration stays with the client, which knows the duration exactly and
already has `clampRange`; the server would be reading `tech_metadata` to
second-guess it.

**No filter-language change.** Because moment tags propagate (§4.1), every
existing tag filter, tag count, and Smart Collection already finds these bundles.
A `moment_count`/`has_moments` filter field is a later want, not this plan.

## 7. Slices

Each is buildable, testable, and reviewable on its own.

| # | Slice | Contents |
|---|-------|----------|
| S1 ✅ | Backend | model + table bootstrap, service, schemas, routes, propagation, tests, OpenAPI + `schema.d.ts` regen |
| S2 ✅ | Inspector section | `TagPicker` extraction, the Moments list, comment editing, delete, empty state |
| S3 ✅ | Viewer capture | `B`, `★ Save Moment`, toast, duplicate guard, seek-bar markers |
| S4 ✅ | range loop | `armed` mode in `useClipPlayback`, Loop as arm toggle, settings-menu entry, arm-from-a-row |
| S5 ✅ | Docs | ADR-0026 for the armed loop, plan 1 rows, STATUS, Playwright flow. The propagation ADR, the data-model and architecture entries, and the changelog landed with S1 — a schema is documented in the slice that adds it |

## 8. Tests

**Backend.** Table created in a pre-existing library; create rejects a `file_id`
outside the bundle; frame vs range round-trip; `end_s > start_s` enforced;
assigning a moment tag adds it to the bundle; propagation is a union, not a
replace; removing a moment tag leaves the bundle tag; deleting a moment leaves
the bundle tags; cascade on file delete and on bundle delete; `bundle_id` follows
a reparented file; ordering by `start_s`; `If-Match` conflict on `PATCH`.

**Frontend.** `useClipPlayback` in `armed`: a pause does not disarm, the
out-point wraps, a seek before the in-point is left alone; `session` behaviour
unchanged. `B` saves a frame with no marks and a span with marks; the duplicate
guard selects instead of adding. The section renders frame and range rows in time
order, groups by file only when it must, and shows the empty state. `TagPicker`
drives a moment and a bundle from the same component. A propagated chip appears on
the bundle without a manual refresh.

**E2E.** Open the viewer, mark a range, save it, see it in the docked inspector,
tag it, see the tag on the bundle, arm the loop, watch the playhead wrap.

## 9. Still open

- **Unbundled and unindexed files.** A moment needs an `AssetFile` row, so an
  unindexed File Browser path cannot have one — the same limit clips already
  carry. An *unbundled* file does have a row, and could show moments in the
  `FileInspector`; out of scope here, and noted rather than half-built.
- **Export from a moment.** `Save GIF…` already takes the clip bar's span, so
  loading a moment into the marks and exporting works today by two steps. A
  direct *Export this moment* is one menu entry away and deliberately not in S1–S5.
- **Moments on the Android/TV client.** Read-only display is the obvious first
  step there; plan 2 owns it.
