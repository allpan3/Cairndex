# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project follows [Semantic Versioning](https://semver.org/) from 0.1.0
onward. Entries under `Unreleased` ship in the next tagged release.

## [Unreleased]

### Added

- **Moments — save the frames and spans that matter inside a video.** Press
  <kbd>B</kbd> while watching to mark the frame you are on; with a range marked in
  the clip bar, it saves the range instead. Saved moments appear in the Bundle
  Inspector as **one line each** — the start time, a range's length, and its tags
  all on that line — and as ticks and thin bands on the seek track, with the hover
  tooltip naming whichever one you are over. Hovering a row shows the frame above
  it, in the shell and inside the player alike. Clicking one plays from there,
  from the viewer or from the shell, which opens the viewer already at that
  instant.

  Saving one opens the rail and puts the cursor straight in its comment box: what
  you want to write down is freshest at the instant you mark it. **A range's
  hover preview plays the span**, from a small clip of just that span, cut once in
  the background and cached. It starts on the frame you marked and loops there,
  and on this machine it is moving about a fifth of a second after the pointer
  settles. The first hover of a moment is the slow one — it streams the original
  while the cut is made — and every hover after it reads the clip. Emptying
  `.cairndex/cache/` costs you that first hover again and nothing else.

  **The still is the frame you marked**, for a span and an instant alike, decoded
  when you save the moment. It used to be a storyboard tile, which is sampled
  every 2 to 30 seconds and holds the frame from the *start* of the interval your
  mark fell in — so the first thing you saw was reliably not the frame you chose,
  and on a long video not even inside the range.

  The preview also carries the comment in full, which the row itself can only
  clamp to one line, and it grows away from the row so it never covers the row's
  own controls.

  A moment's tags are the library's own tags, through the same picker the bundle
  uses. **Tagging a moment also tags its bundle**, so a marked moment is
  browsable, filterable, and countable without anything new to learn. Removing the
  tag from the moment, or deleting the moment, leaves the bundle's tag alone —
  the way out is *Remove from This Bundle* on the pill, as it always was. See
  [ADR-0025](docs/adr/0025-moment-tag-propagation.md).

  Pressing <kbd>B</kbd> twice at the same frame offers the moment already there
  rather than saving a second one. Adjusting a saved span reuses the range bar
  rather than a second range editor: mark it there, then **Update to Range Marks**
  on the row.

- **range looping.** A saved range *is* an loop pair, so its row in the inspector has
  a loop button, and the range bar's **Loop** is now that same switch. While it is
  on, playback stays inside the span and repeats — <kbd>Space</kbd> included — and
  pausing to look at something no longer ends it. One click on the lit control
  turns it off, and so does changing file or closing the clip bar. Seeking to
  before the in-point is left alone, so the run-up into a span is still watchable.
  Also reachable from the settings menu and the viewer's right-click menu, both
  beside *Loop file*.

  **Play Range** is unchanged and still the one-shot: play the span once, stop at
  the out-point, and any pause ends it. See
  [ADR-0026](docs/adr/0026-armed-range-loop.md) for why the loop is a visibly armed
  mode rather than a preference.

- **Open a folder in the inspector to see its files nested under it.** A
  disclosure on the right of the folder row — where a file keeps its cover and
  play actions — reveals the files it stands for, indented beneath it, with the
  row itself staying put. Looking inside changes nothing about the bundle.

  The folder row carries no icon and no leading control, so it starts in the
  same column as every other row in the rail.

  Previously the only way to see inside was *Expand folder into the bundle*,
  which deletes the folder row and flattens its files into the list — so the
  folder appeared to be gone, and the way back (**Collapse** on any of those
  files) was on a different row under a different name. That action is still
  there for when you want the folder to stop being one member; it is no longer
  the only way to look.

- **Look inside a suggested folder before deciding it should be one.** A folder
  row in the review dialog gets a disclosure: open it and the files it stands
  for are listed, read-only, changing nothing about the plan. Deciding whether a
  folder *should* be a folder previously meant flattening it to find out.

  And flattening is no longer one-way. **List files** and **Keep as folder** are
  now the two ends of one toggle: the row stays either way, saying which state it
  is in, and applying honours whichever you left it on. The folder row sits where
  its files begin, so listing them turns it into a header directly above them —
  with the control that folds them back beside them, rather than stranded below
  seventy-odd rows looking like an empty folder.

- **A collapsed folder keeps working as the folder changes.** Two things a scan
  used to get wrong about one. A photo dropped into a folder that a bundle shows
  as one row now **joins that bundle**, instead of arriving as its own
  suggestion to review — so an album stays one row as you add to it. And
  **renaming the folder on disk keeps it collapsed**: move repair already
  followed the files, but the row naming the directory was left pointing at
  somewhere gone, which quietly un-collapsed the album on the next scan. A file
  nested inside the folder votes for the folder's new location, not its own
  parent's.

  If a folder's files genuinely scatter to different places, it is not a folder
  anymore: the row is dropped and its files list individually. Visible and
  harmless, which is the right failure — the alternative is a row pointing at
  nothing.

- **Suggest grouping proposes a photo folder as one bundle, not a thousand.**
  A folder of a thousand photos used to arrive in the review dialog as a
  collection wrapping **a thousand single-photo bundle suggestions** — a
  thousand rows to read before you could accept anything. Above a threshold the
  suggester now proposes it as one bundle whose single member is the folder, and
  applying it creates that folder row for real. One row instead of a thousand.

  It counts **subjects, not files**, which is the whole of the rule. A folder of
  300 releases is 900 files but only 300 subjects — each a video with a cover and
  a subtitle sharing its stem — and stays 300 separate suggestions. An album is
  300 photos that share nothing with each other. A single stray sidecar does not
  disqualify an album, and a movie folder is never swallowed.

  In the review dialog the folder is a single row — `🗁 album · Folder · 30
  files` — with **List files** beside it. The threshold only ever decides what to
  *propose*: a folder suggested wrongly is one click to decline, after which its
  files list individually as before, and accepting the suggestion turns the row
  into a real folder member on the bundle.

- **A folder can sit in a bundle as one row.** A bundle that holds an album of a
  thousand photos filled the inspector rail with a thousand rows, which is not a
  list anyone can use. One of a bundle's directories can now stand in for its
  files as a single row: right-click any file and choose **Collapse “…” into One
  Row**, or right-click the folder row and **Expand “…” into the Bundle** to put
  it back. Both are metadata-only and instant.

  The folder row sits where its contents were, so collapsing does not reorder the
  bundle, and the heading still counts every file the bundle holds — `Files in
  bundle (1002 · 1 folder)` — because collapsing changes what is drawn, not what
  is in the bundle. Nothing is lost either way: the files never stop being
  members, and keep their ratings, tags, notes and playback positions throughout.

  A folder carries no cover star and no play button, because a folder is a
  container rather than a work. Double-click it (or press Enter) to open it in
  the File Browser, which already pages through a folder in the viewer — so
  there is no new viewer mode to learn. **Playing the bundle skips a folder's
  contents**: "play this bundle" means its own media, not the thousand photos
  inside. Opening one of those photos directly still pages through that folder.

- **Bundle notes can be dragged into a new order.** The stack could be added to
  and removed from but never rearranged, so a note that belonged first had to be
  retyped there. Each box grows a grip under its remove button, both revealed on
  hover, and only where there is more than one note to move; the arrow keys do
  the same move from the keyboard once the grip has focus. The pair shares one
  column at the right edge, and that column got *narrower* in the process: 18px
  where the remove button alone used to reserve 26, so every note line is a
  little longer than it was before there was anything to drag. A note keeps its own box height when it
  lands, rather than inheriting whatever height used to be in that position.

- **Clicking the Collections heading folds the tree instead of hiding it.**
  It hid every collection, which is the one thing that gesture could do that
  nobody wants — those rows are the sidebar's main content. It now folds the
  tree down to the top level and unfolds it again, and a collection's own
  right-click menu offers the same for its branch: **Expand All / Collapse All
  Subcollections**, on collections that have something under them.

- **Adding a file offers the bundle it belongs to.** Both routes into the library
  put the file on disk and stopped there — it was in the library but invisible to
  the Bundle Browser until the next scan staged it, and bundling was a separate
  trip through Unbundled. The destination folder is the strongest signal about
  which bundle a file joins, so both routes now use it:

  - `File ▸ Add Files to Library…` asks which bundle alongside where. Nothing is
    preselected, there is an explicit **Don't add to a bundle** row rather than an
    implied one, and the confirm button names the bundle it will file into, so
    joining one cannot happen unnoticed. Choosing a bundle in one folder and then
    browsing to another drops the choice, since it belonged to the folder you
    left. *Move to…* is unchanged — it shares the dialog but not the question.
  - **The File Browser's drag-in and Add Files Here** report the import in a
    toast that now carries the offer beside Undo. Undo reverses the whole batch,
    not only the last file, because each import is its own journal operation.
    This covers both ways files arrive there — a browser upload and the desktop
    shell's own Finder drop are separate machinery end to end, and the offer has
    to be asked for on each.

  **New Bundle sits beside the add-to action on every import**, because a file
  arriving in the library is at least as likely to *be* a bundle as to join one,
  and a suggester can only ever propose the second. It opens the same dialog the
  File Browser's Create Bundle… does, with a title proposed from the filename.

  An offer, never an action: the file has already landed where it was told to,
  and everything is metadata-only from there. Two cases decline to *name* a
  bundle — a weak match, and **a folder holding several bundles that the path
  cannot choose between** (two bundles in one folder score identically, and
  naming one would dress a coin flip as a recommendation). Neither goes quiet:
  both degrade to **Add to Bundle**, which opens every candidate ranked plus a
  search over all confirmed bundles. Answering "Don't add to a bundle" in the
  destination picker leads to the same toast, since that is a *not yet* rather
  than a no. So an import always offers both ways to bundle what just landed.

- **Forget a file that is gone.** A file deleted outside Cairndex could only be
  dismissed by deleting the whole bundle around it — which dissolved the
  grouping, scattered the surviving files back into Unbundled, and (until the
  fix below) left the dead file behind anyway. **Forget Missing File** on a
  file's own menu drops just that record; **Forget Missing Files** on a bundle
  card drops every dead member and keeps the bundle, unless they were all it
  had. Metadata-only: there is nothing on disk left to touch, and repair is
  still the answer when a file *moved* rather than went.

  A file that is gone no longer offers "Remove from Bundle" beside it. Removing
  it drops the record too, so the two were one action under two names, and only
  one of the names said so.

- **The destination picker stops flashing on every click.** Stepping into a folder
  fetched a listing under a new cache key, so the list was replaced by "Loading…"
  and the dialog visibly blinked each time. It now holds the previous listing
  while the next arrives — dimmed, with its rows disabled, because those rows
  belong to the folder you just left while the breadcrumb already reads the new
  one, and clicking one would navigate somewhere that need not exist.

  **The File Browser itself does the same**, where the stakes are higher: its
  rows feed Rename, Move to… and Move to Trash, so a click landing on a held row
  could have targeted a file from the folder just left. There the held listing is
  dimmed, marked `aria-busy`, made inert in CSS *and* guarded in the click,
  double-click and context-menu handlers — belt and braces, because a CSS-only
  guard depends on a stylesheet having loaded. Band-select and arrow keys are
  suspended for the same window. Affordances keyed on the *path* rather than a
  row — dropping files in, New Folder, the background menu — stay live, since the
  path is already the folder being navigated to.

  Still opt-in per caller rather than a default on the shared listing hook: any
  caller holding a stale listing has to guard against acting on it, and that
  guard is specific to what its rows do. The remaining pickers need no change —
  the collection picker reads one non-navigable query, and the bundle-drop
  destination wraps this same directory picker.

- **Fixed: a bundle chosen in the destination picker could be silently dropped.**
  The rule is "forget the choice when you leave the folder", but it was
  implemented as "forget it when the id is no longer in the fetched suggestion
  list" — a correctness rule keyed on a network state. It held only because
  TanStack retains data across a refetch; any render where that list was
  momentarily empty for the *same* folder would have discarded an explicit choice
  and imported the file unbundled. The choice is now keyed on the folder it was
  made in, and remembers its own title so the confirm button says what it will do
  even before the list arrives.

- **New Collection from Folder…**, on a File Browser folder's context menu. Name
  it (the folder's own name is the default), choose which collection it sits
  inside from a **foldable, searchable tree**, and every bundle in that folder
  **and below** is filed into it. The tree rather than a dropdown because a
  library's collection list has no natural limit: depth is only legible while you
  can close what you are not looking at. Searching flattens the tree, so a match
  is never hidden inside a folded branch, and folds survive the search. The
  dialog says how many that is before you press the button, because the same
  click may file two bundles or two hundred and only the folder knows which.

  Collections stay logical: the folder is read to decide membership and nothing
  on disk moves. Provisional scan-staged bundles are left out — browse hides them
  from collections anyway, so filing them would add rows that cannot be seen. The
  whole thing is one request, since a collection that exists but never received
  its members is a worse outcome than one that was never created.

  A folder's context menu now opens **without write mode**, which it did not
  before: it previously held nothing that worked read-only, and this and Copy
  Path both do. The entries that touch the filesystem stay gated.

- **Locate in File Browser, on a bundle.** The File Browser could jump to a
  file's owning bundle, but nothing went the other way: finding where a bundle
  actually lives on disk meant reading its path and navigating by hand. A
  bundle's context menu now opens the folder its own file sits in, with that file
  highlighted. Like *Locate in Bundle Browser* — and unlike Open in Default App
  and Reveal in Finder, which it sits above — this navigates inside Cairndex, so
  it works in a browser too.

- **⌘↩ reveals the selection in Finder, ⇧↩ opens it in its default app**, and
  both are in the menu bar under `File` — greyed out when there is nothing they
  could act on, so the answer is visible before the keystroke.

  What they act on follows the surface you are looking at: the File Browser's
  selected entry, or in the Bundle Browser the file selected inside an open
  bundle, else the selected bundle's own playback file. A selection left behind
  in a pane that is off screen is never what opens.

- **A library this Mac is already serving no longer has to be "located".** Open
  in Default App and Reveal in Finder need a local path for the library, and the
  desktop app only had one if you had pointed at the folder yourself — so both
  actions were missing from every menu for a library the app was actively
  reading from (owner, 2026-08-23). That ceremony exists for a *remote* server,
  whose path (`/volume1/media`) means nothing here; it was never needed for the
  local server, which reports a path on this Mac. The app now adopts that path
  by itself, after checking the folder's own `.cairndex` marker names the same
  library — so it is verified, not merely trusted. Remote servers still ask,
  because there a local *copy* of the library would pass the same check while
  pointing at the wrong files.

  Where they cannot work at all — a plain browser, or a genuinely remote server
  — the menu-bar items are what say so. The context menus stay as they were,
  simply leaving the pair out: no greyed rows were added there.

- **Tags and tag groups can be made from the All Tags page.** It could rename,
  nest and delete what already existed, but there was no way to *create* a tag
  there at all — the only route was typing one into a bundle's tag picker — and
  tag groups could not be created, renamed, deleted, or have anything put in
  them from the UI, despite the API having supported all four since the taxonomy
  went in. The page now covers the whole lifecycle:

  - **New Tag** in the toolbar creates a top-level tag, reading `/` as a
    hierarchy divider, so `Studio/Series` makes both in one pass and reuses
    either if it is already there. Created while a group panel is open, the tag
    joins that group — otherwise "new tag" in a group would make something the
    panel cannot show.
  - **New Child Tag** on a tag's context menu creates beneath that tag, and
    unfolds it so the new child is visible rather than hidden in a folded branch.
  - The side rail's **Tag Groups** header has a **+** for a new group, and each
    group row right-clicks to **Rename Group** or **Delete Group**. Deleting one
    is metadata-only and says so: the tags stay, only the grouping goes.
  - A tag joins or leaves a group from its own context menu (**Add to …** /
    **Remove from …**), or by being **dragged onto a group row** — which is
    membership, not nesting, so the tag keeps its parent. A row it already holds
    offers no drop cue.
  - **Expand all** / **Collapse all** opens or folds every tag with children in
    the current panel, which is the only practical way through a deep hierarchy
    one chevron at a time.
  - Right-clicking the page's blank space offers **New Tag** and the same fold
    toggle — "here" being the open panel, so in a group panel the new tag joins
    that group. Right-clicking a tag still gets the tag's own menu.

- **HDR video no longer transcodes to a flat, washed-out picture.** A transcode
  ended in 8-bit BT.709 with no colour conversion, so an HDR source's PQ or HLG
  code values were read as ordinary gamma — correct for SDR, wrong for
  everything graded brighter than it. HDR10 and HLG sources are now tone mapped
  properly on the way through, and the **Playback** row says so. Where the
  ffmpeg in use cannot do it — the filter needed is missing from some builds,
  including Homebrew's — the source is left alone and the row says *that*,
  because a flat picture with a stated cause is worth much more than a flat
  picture without one. `CAIRNDEX_FFMPEG_TONEMAP=off` switches it off.

  Two things deliberately left alone. **Dolby Vision is not converted**: profile
  8.1 would tone map correctly but profile 5 carries a different colour encoding
  entirely and would come out green and magenta — worse than flat — and the two
  cannot be told apart from what is recorded today. It says so rather than
  guessing. And **4K is the case to watch**: the conversion runs through a
  high-precision intermediate, and measured here a 4K source converts at only
  1.4x real time where the same source capped to 1080p manages 10x. Picking a
  quality below the source's own height from the player's settings menu makes it
  comfortable again, because the downscale happens first, on purpose.

- **Adding files to the library no longer means standing in the right folder
  first.** `File ▸ Add Files to Library…` (⇧⌘A) picks files and then asks where
  they should go, so it works from the Bundle Browser and the viewer, not just
  the File Browser. Collisions raise the same Replace / Skip / Keep both prompt
  as a drag-in, and each copy keeps its own Undo.

  The destination dialog can **create a folder**, because deciding where a file
  should go is often the moment you notice the folder does not exist yet; the new
  folder becomes the destination straight away. Move to… is unchanged.

  On the web the same command is **Add files** in the sidebar's **⋯** menu beside
  Update, which is renamed from "library maintenance" to **library actions** — it
  was already the home for library-scoped things that do not earn a button, and
  adding files is not maintenance. It sits above a divider, because everything
  else in there runs in the background while this one opens a dialog. It appears
  only in write mode.

  The collision prompt gained a **Skip**. It offered Cancel, Replace and Keep
  both — and Cancel abandons every file still queued, so with several files
  picked there was no way to say "not this one, carry on". Skip leaves that file
  alone and continues; Cancel stops and copies nothing further. The dialog now
  says which is which, since the buttons alone did not.

  **Dragging a file that is already in the library into it is refused**, with a
  message pointing at Move to… instead. Copying it in would be silent whenever
  the destination folder differed, and worse when it did not: answering Replace
  moves the original to Trash, so a bundle containing that file loses it while
  identical bytes land at the same path untracked. Only the drag-in can be
  guarded — the Add Files picker receives bytes with no path, deliberately, so
  neither the app nor the server can tell where they came from.

  The File Browser's existing button is renamed **Add Files Here**, because that
  is what it does — it copies into the folder on screen without asking, which is
  the faster path when you are already there.

||||||| parent of 20aaecee (feat(transcode): HDR sources are tone mapped instead of coming out flat)
- **The marked span is something you play, with `\` or Play Range.** The clip
  strip had grown an action and a mode that only meant anything together —
  "From In" and "Range" — so they are now one control. **Play Range** jumps to
  the in-point and runs to the out-point, `⟳ Loop` repeats it instead of
  stopping, and pressing it again restarts, which is what checking a mark
  actually needs. The button shows while the span is running.
- **Ordinary play now ignores the marks.** Range used to be a standing mode, so
  Space meant one thing with a clip marked and another without. Space is plain
  playback again: it never jumps to the in-point and never stops at the
  out-point, and pausing ends a running span so resuming is unconfined. Only
  Play Range confines anything, and only while it runs. (range-loop replay, when
  it lands, will drive the same span from playback settings.)

- **The watermark can be your own image instead of words.** Settings → Exports
  offers Text or Image; choosing Image takes a PNG, JPEG, WebP, or GIF, with a
  transparent PNG working best. The picture is fitted inside both a height and
  a width bound rather than scaled by one of them, because the two shapes
  people actually use pull in opposite directions — a square badge scaled to a
  fixed width becomes enormously tall, and a long wordmark scaled to a fixed
  height runs off the frame. It scales with the export like the text does, so
  one logo suits a 480 px GIF and a 4K snapshot alike, and it keeps the same
  soft shadow, which is what stops a white logo vanishing into a white frame.
  Chosen images are stored on this machine, resized to at most 1024 px on the
  longest side and re-encoded as PNG so transparency survives; SVG is not
  accepted, being a document that can carry scripts rather than a picture.
  Switching between Text and Image keeps both answers, so neither has to be
  retyped or re-picked.
- **Exports can carry a watermark, and it says what you tell it to.**
  Settings → Exports has an off-by-default switch and a text field; with it on,
  the mark is stamped on snapshots and GIFs in the bottom-right corner and on
  contact sheets at the top right of their header. Only the exported copy is
  marked — nothing in the library is touched. The mark scales with the export
  rather than with the source, so it reads the same on a 480 px GIF as on a
  full-resolution snapshot, and it is drawn in white over a soft shadow because
  a frame can be a snowfield or a night sky and neither a light nor a dark mark
  reads on both. Leaving the text empty stamps nothing. The setting is local to
  the machine, like the export folder beside it, and the Exports page is now
  reachable in a browser instead of only in the desktop app — a watermark
  applies wherever an export can be started, even though the folder choice
  above it is still desktop-only.
- **A span of a video can be marked in the player and saved as a GIF.** The
  clip button (or `[` and `]`) marks the two ends at the playhead; the seek bar
  carries the selection in the context of the whole file, and a magnified track
  in the clip bar covers just the selection plus a margin, so the same pointer
  movement spans frames instead of minutes. Each end has one-second and
  one-frame steppers, and every adjustment — stepper or handle drag — scrubs the
  video to the end being moved, because a frame you cannot see cannot be placed
  accurately. **Set In** / **Set Out** put an end at the playhead, and
  when that would land past the other end the whole clip moves and keeps its
  length rather than collapsing — the length is already decided, the click only
  says where it sits. Save GIF… asks for the output width and frame rate,
  showing the pixel size and frame count it will actually produce, then encodes
  server-side (≤30 s, ≤1920 px) and downloads, or saves through the native
  dialog in the desktop app.
- **Export sizes are chosen on a scrolling wheel rather than a row of buttons.**
  A row had to fit every choice side by side, so it held three or four; a wheel
  scrolls, so the ladders are as long as they should be — fifteen GIF widths,
  ten sheet widths, and five grids. GIF frame rates run 5–50 (the ceiling was
  15), and each says what it will really play at: a GIF stores frame delays in
  whole centiseconds, so 15 fps plays at 14.3 and the wheel says so rather than
  leaving it to be discovered. Rates the source cannot meaningfully supply are
  left off — though a 24 fps source can still reach 25, which fits it far better
  than 20 does. The GIF and snapshot wheels end at the source's own width,
  marked `native`, since scaling either up adds nothing. Contact-sheet widths
  now run 800–6144 px (they were three fixed values), and grids 4×4 through 8×8,
  defaulting to 5×5.
- **Snapshots can be saved at a chosen size.** `S` and the camera button are
  unchanged — one press, at the source's own resolution, because the common case
  is grabbing a frame rather than configuring one. A new **Save Snapshot As…**
  on the viewer's right-click menu asks for a width first, from 320 px up to the
  source's own, and says the pixel size the PNG will have. Nothing above the
  source is offered, since scaling a still up adds nothing; the wheel opens one
  rung below native, which is "smaller than the original, but not tiny". Unlike
  a GIF this is a canvas draw rather than an encode, so it needs no server, has
  no size cap of its own, and is saved the moment it is asked for.
- **How much of a filename has to match is now a dial, not three named stops.**
  Grouping compares filename stems, and the sensitivity was `narrow` /
  `balanced` / `wide` — too few stops, and not points on one scale: `balanced`
  folded a trailing rendition tag while `wide` switched to an unrelated key, so
  "one step wider" meant two different things and could split as readily as
  merge. A folder now sits at a level, and each step compares one segment less
  of every name in it, up to a maximum that folder's own filenames decide. The
  default reproduces the old `balanced` exactly, so an existing library regroups
  nothing; a plan left open across the upgrade has its stored mode translated,
  with `wide` landing on that folder's maximum.
- **The review's row controls are one click, not two.** A `...` menu per row
  collected the bundle↔collection conversion and the addition's destination
  switch; both are now beside the name they act on. The row's own kind glyph
  *is* the convert control — one click, in the place the kind is already shown,
  labelled `Convert to collection` / `Convert to bundle` rather than the
  sentence-long menu items it replaced. Renaming stays a double-click on the
  title, which is what it always was. Each row also says how sure the suggester
  is in words that mean something — `confident` / `likely` / `guess`, where the
  first of those used to read `matched`, which did not say what had matched.
- **Narrow and Widen are visible again, on the folder they belong to.** They had
  moved into a row's overflow menu, where a folder-level control does not belong
  and where a folder-level *value* cannot be shown at all — the level was
  inferable only from which end was greyed out. Each folder's row now states it
  as text ("stem 2 of 6") beside plain `Narrow` and `Widen` buttons, with
  `Reset` when there is something to reset to. Every tooltip says what the
  button does to the filename match and then what that does to the bundles, and
  each end of the dial explains why it stops. A collection suggestion for a
  folder is that folder's header, so it carries the dial and is set off from the
  rows beneath it; a leaf folder that is one bundle carries its own.
- **Long grouping plans can now be folded without changing the plan.** Each
  collection can hide its descendant proposals and each bundle can hide its
  file list, with Collapse all / Expand all controls beside selection. Reviews
  still open fully expanded, and folding is presentation-only: selection
  counts, placement, drag-and-drop, and the accepted bundle ids are unchanged.
- **A multi-file import can now be stopped from the sidebar.** Browser uploads
  abort their in-flight request, while the desktop shell carries the same stop
  across IPC into the Rust reader streaming the current file; both stop the
  large file already underway instead of only suppressing the next one. Import
  rows share the background-job area and its waiting/stopping language without
  hiding simultaneous jobs, show the current filename and batch count, and
  finish with an honest partial summary. Files whose requests already completed
  stay imported and individually undoable; skipped and never-attempted files are
  counted separately. A server-side disconnect regression test fixes the safety
  premise in place: Starlette's mid-body disconnect removes the staging `.part`
  and fails that file's journal entry.
- **Files can be dropped onto the Bundle Inspector to add them to that bundle.**
  The whole sidebar is now the same write-gated import-and-link target as the
  bundle card, with the same hover treatment and the same destination picker
  defaulting to the bundle’s folder. The docked inspector in the media viewer
  closes the viewer before opening that picker so the next step is visible.
- **Any running job can now be stopped from the sidebar.** Scan, metadata,
  thumbnails and storyboards all show a stop control on the row they are running
  on. The server could already cancel a job; nothing in the app ever asked it
  to, so a run you no longer wanted had to be waited out or the server killed.
  Stopping is prompt rather than eventual: a job spending minutes inside a
  single ffmpeg call — one storyboard file over a network share is about half a
  minute — stops there instead of at the next checkpoint behind it.

### Changed

- **The side panels' scrollbars lie over the content instead of beside it.** The
  sidebar and the inspector used the platform scrollbar: sixteen pixels wide,
  appearing the moment content outgrew the window and shoving everything
  sideways to make room. They now draw their own — a thin translucent thumb,
  visible on hover, draggable, and costing the panel **no width at all**, so
  nothing moves when it comes and goes.

  A native scrollbar cannot do this: it paints in the gutter, outside the
  content box, so it always costs width. Reserving that permanently only trades
  the jump for a constant loss, and `overflow: overlay`, which would have done
  it in one line, has been removed from Chromium.

- **Every scrollbar in the app is half-transparent now**, not just the two side
  panels: the grid, the File Browser, dialogs, menus, pickers and the note boxes
  all share one pair of colour tokens. The widths still differ where a layout
  depends on them — a note box's bar is 5px because its row controls are placed
  to sit exactly beside it — but nothing frames a panel in a solid bar any more.

- **What the owner is waiting for runs first.** One worker runs one job at a
  time, so a storyboard pass — a sweep over every video in the library — held
  the queue against everything behind it: pressing Update during one queued a
  scan that could not start until the prefetch had finished. Jobs are now
  claimed in order of what they are for (scan, then metadata and thumbnails,
  then storyboards) and stay first-come within each kind. That alone would not
  help the case that prompted it, since the long job is already running, so a
  running pass also *stands aside* at its next checkpoint when more urgent work
  is waiting, and goes back to the queue to resume afterwards. Standing aside is
  neither a cancellation nor a failure: the job keeps its identity, reports
  itself as waiting, and picks up where a fresh sweep leaves off — every
  library-wide pass skips work that is already current.

- **A grouping suggestion no longer says how sure it is.** Every bundle row
  carried a confidence band in words — confident / likely / guess — and it was
  wrong often enough that stating certainty was the misleading part. What
  remains is the evidence rather than the confidence: a row grouped from its
  folder rather than from matching names is still flagged, still says so in the
  suggester's own words, and is still counted above the list.

- **A file that was never bundled is never "missing".** Unbundled is the pending
  zone — a scan stages every file it finds there, and bundling is what registers
  a file in the library. So a staged file deleted outside Cairndex was reported
  as a loss it made no sense to report: Missing Files filled with files the owner
  had deleted on purpose, and the sidebar badge counted them, which for a library
  used partly as a file browser is a permanent warning about nothing (owner,
  2026-08-24).

  Missing Files and its badge now cover **registered bundles only**, and a scan
  drops the staging rows of files it can prove are gone. Two things have to hold
  before anything is dropped, both read off that scan:

  - **it read every directory it tried.** A listing that fails is a mount that
    dropped, not a folder that emptied — and that failure used to be discarded.
  - **the file's own filesystem is still the one mounted where it was.** A
    dropped SMB mount takes its mountpoint directory with it, so a vanished
    folder proves nothing by itself; but the ancestor that survives is then on
    the outer filesystem, whose device id is not the one the file was last seen
    on. An unmounted mountpoint left behind as an empty folder fails the same
    check.

  Nothing waits, counts scans, or keeps a timestamp: proof is what licenses the
  delete, and where it is missing the row simply stays. A **registered** bundle's
  missing file is never touched, nor is any staged row carrying something the
  owner made — a tag, rating, note, source, collection, watch position, chosen
  cover frame, or a cover/subtitle reference. Those stay, and Forget clears them
  by hand.

  The scan-complete message says how many it dropped — *"Scan complete: 0 linked
  files are missing. Forgot 2 unbundled files that are gone."* — and says nothing
  about forgetting when there was nothing to forget.

- **The layout buttons have icons that mean something.** Card and Justified were
  `▦` and `▥` — box-drawing glyphs that are near indistinguishable at 15px and
  say nothing about the layout they select. Each is now a drawn icon: **Card** is
  a single card, cover above and title below; **Justified** is rows of unequal
  widths flush to both edges; **List** is a thumbnail beside its line of text. No
  two share a silhouette, which matters more than any one of them being clever —
  they sit in one segmented control at 15px. The File Browser's two share them,
  so the same control means the same thing on both surfaces.

- **The "Grid" layout is now called "Card".** Both it and Justified are grids;
  what distinguishes this one is that every item is a card of one fixed shape.
  The stored preference value is unchanged, so nothing needs migrating.

- **The card-size slider reaches further at both ends** — 140–640 px instead of
  80–360. The smallest cards were too small to read and the largest not large
  enough to look at. Justified rows also aim higher within that range (0.7 of the
  slider value rather than 0.6): the two layouts are judged separately, and
  Justified was the one still reading small, having no title block under each
  tile to give it weight. A zoom saved outside the range is clamped on read,
  since a value the slider cannot express would leave the thumb at one end
  showing cards from somewhere else.

- **Snapshot and GIF watermarks sit closer to the corner.** The inset was wide
  enough that the mark read as floating in the bottom-right rather than sitting
  in it; it is now near 1% of the export's width — a corner inset rather than a
  margin. Contact sheets are unchanged: their mark takes the header's own
  padding, so it stays level with the metadata rows.
- **A contact sheet's watermark sits at the top of its header, not adrift below
  it.** The mark derived its inset from its own size rather than using the
  header's padding, so it started lower than the metadata rows beside it. Worse,
  a picture mark is scaled to the sheet's _width_, which knows nothing of how
  tall the header is — a tall logo overflowed the band, and since the frame grid
  is drawn afterwards, the grid painted over the overflow and shaved the mark's
  bottom off. A mark is now fitted to the band that holds it and shares the
  header's own padding, so it lines up with the first metadata row and can never
  be clipped by whatever is drawn next.
- **The contact sheet's fixed Cairndex brand block is retired.** Every sheet
  carried a blue-accented `EXPORTED FROM CAIRNDEX` lockup in its header whether
  or not the owner wanted one; that is replaced by the opt-in watermark above,
  which is off by default. A sheet exported without one now has no branding at
  all, and its metadata rows spread into the width the block used to occupy.
  The header's height is unchanged — it was always set by the three metadata
  rows, not by what sat beside them.
- **"Scan new files" now scans, and only scans.** It sat in the same menu as
  "Suggest grouping" and did that item's work too, ending a scan by opening the
  grouping review dialog nobody had asked for. The scan job takes a
  `suggest_grouping` flag (`POST …/jobs/scan?suggest_grouping=false`), which the
  menu item sends and the combined ⟳ Update does not, so Update is unchanged.
- **A newly created library indexes itself.** A folder that had only just become
  a library held nothing, so every view was empty and playback had no metadata
  to decide from until the owner found two menu items. Creating one now enqueues
  discovery and then metadata, reported in the sidebar like any other job.
  Deliberately not the full Update: no grouping pass, so no review dialog opens
  over a library just added, and no storyboards, which stay a deliberate action.
  Registering a library that already exists is untouched — it arrives with its
  own database, and re-reading a multi-terabyte tree unasked is what ⟳ Update is
  for.
- **Export artifacts now reach the desktop shell as raw bytes rather than as
  JSON.** `save_export_file` took its bytes as a JSON number array, which turned
  a few-megabyte artifact into tens of megabytes serialized on the main thread —
  acceptable while the seam had no callers, not once a real export used it. The
  bytes travel as Tauri's raw IPC body with the suggested name in a
  percent-encoded header; the destination still comes only from the OS dialog.
  Contact sheets and snapshots take the same path.
- **A bundle is named by the shortest prefix its files share.** A release video
  and its cover carry the release's own identifier, so a folder holding
  `n0203 - a long title.mp4` and `n0203.jpg` is now "n0203" rather than the
  video's whole filename. Sidecars join the comparison whenever there is at most
  one video; with several videos they are still excluded, because a cover named
  for the folder would drag the shared prefix shorter than the thing it names.
  Files sharing no prefix are still named after the video.
- **The folder's Split/Merge actions name the current matching mode and can
  reset to balanced.** The mode used to sit beside the old icon pair and nowhere
  else, so moving those into the row menu left it inferable only from which end
  was greyed out — and balanced, previously a directly selectable state, was
  unreachable from either end.
- **Grouping review shows each suggestion's confidence instead of filtering by
  it.** A two-tab All / "Needs a look" filter meant a *mis*-scored row — one the
  suggester was sure about and wrong about — was not merely unflagged but
  actively hidden from the view that claimed to show what needed deciding, and
  the rows that remained carried no signal at all. Every row now states its own
  band (matched / likely / guessed), the guessed ones keep their warm edge and
  reason, the toolbar counts them, and nothing is hidden.
- **Bundle and collection can always be converted into each other.** The client
  used to withhold the conversion from a single-subject bundle already inside a
  collection for its own folder — which is exactly the row an owner reaches for
  it on, a folder holding one release today that should be a collection. The
  server's bound is now whether the conversion renames anything rather than
  where the row sits, so a folder-named bundle becomes a folder-named collection
  holding a release named after itself, and only the conversion that would
  change no name is refused. A row whose edits are all unavailable now opens an
  empty menu saying so, rather than rendering no menu button at all.

- **Runs of identical suggestions collapse to one line, and the review can be
  driven from the keyboard.** A folder of numbered clips produced a row each,
  all treated identically by the suggester; three or more in a row now read as
  "SET-025-01 … SET-025-04 · 4 bundles, same shape · each 2 files · video,
  image", with one checkbox for the run and "Show all 4" when one needs a closer
  look. Suggestions the suggester is unsure about are never folded away, and
  they break a run rather than hiding inside it. The tree is also a single tab
  stop now: arrows move between rows, left and right fold, space accepts or
  skips the focused row, and Cmd/Ctrl+Enter applies without reaching for the
  footer.
- **A grouping row's controls are named rather than glyphs.** They were four
  icon-only buttons — a refresh glyph, an ungroup glyph, and a `>< <>` pair —
  rendered after variable-length text, so they landed at a different x on every
  row and were discoverable only by hovering for a tooltip. Every one of them now
  either says what it does or sits where its meaning is already shown; the
  tooltip machinery that existed to caption them is gone with them. See the two
  entries above for where each ended up.
- **The grouping review's chrome stopped competing with its contents.** The
  three-line preamble folds behind a one-line summary, the dialog holds a fixed
  height so folding a row no longer slides the footer under the pointer,
  notices occupy a reserved line rather than pushing the list down mid-click,
  and Accept names what it will do — "Accept 3 bundles + 1 addition" — with the
  skipped rows spelled out beside it rather than left unexplained.
- **The grouping review now leads with what needs deciding.** The suggester
  already scores its own certainty, so the toolbar counts the suggestions it is
  unsure about and can filter to just those; a flagged row carries a warm left
  edge and says why it was grouped. Filtering is view-only — selection and
  Accept still cover the whole plan. Bundle rows state what they contain
  ("3 files · video, subtitle, image") with the file list one click away rather
  than open by default, and a nested row's placement control drops its printed
  destination, which only ever repeated the row it is drawn inside. Root rows
  keep the full label, every control keeps its accessible name, and a file drag
  reveals every list so nothing becomes an invisible drop target.
- **Grouping destinations now use a collection tree instead of a repeated-path
  dropdown.** The proposal row shows only its direct destination, while the
  bounded picker mirrors the collection hierarchy with indentation and
  independently foldable branches. Search keeps pinyin matching and adds only
  the direct parent needed to disambiguate a result; full paths remain available
  to assistive technology and as tooltips without consuming every visible row.
- **Job progress moved to the bottom of the sidebar, beside the file-transfer
  indicator, and survives a page refresh.** It used to sit under the Update
  button that started it and vanish on reload, which is misleading twice over:
  these jobs outlive that button — a storyboard pass keeps running after Update
  reports done — and the work continues whether or not the page that started it
  is still open. **Every running job is now shown, not just the newest**, since
  scan, probe, thumbnail and storyboard jobs overlap and a single slot hid
  whichever lost.
- **Release notes come from the changelog rather than the pull-request list.**
  GitHub's generated notes describe a release only when every change arrived as
  a PR; v0.1.1 was mostly merged directly onto `main` after the repository was
  recreated, so they named one PR for a release carrying a feature, eleven fixes
  and a breaking change, and the notes had to be rewritten by hand. The release
  body is now the install/licensing preamble plus that version's own changelog
  section, extracted by `infra/release_notes.py`. A missing section fails the
  release job — the procedure already said to move `Unreleased` under the new
  version before tagging, and this is what makes forgetting it visible while it
  can still be fixed.

- **Storyboard generation no longer decodes every frame of every video.** The
  sampling filter it used (`fps=1/n`) forces ffmpeg to decode a video linearly
  from start to finish, so generating trickplay sheets cost a full decode per
  file and a full read of every video in the library — which is why an owner's
  run over a library on a network share took as long as it did. Sampling now
  decodes **only keyframes** (`-skip_frame nokey`). Measured on 5-minute 720p
  fixtures: **2.9× faster** on an H.264 source keyed every 2s (producing the
  identical 150 tiles), **6.2×** on one keyed every 10s, and **13.4×** on HEVC —
  the harder the video is to decode, the more this saves, and it holds the whole
  library's read down to one sequential pass per file. Seeking to each cue
  instead was measured too and rejected: storyboard cues are spaced about as far
  apart as a keyframe, so each seek re-reads a group its neighbours already read
  and the whole run came out *3× slower* than the full decode it replaced.
  (Contact sheets sample far more sparsely and correctly still seek.) **On a
  library over a network share, expect the run to finish at the share's read
  speed rather than in a fraction of the old time**: skipping the decode does
  not skip the read — ffmpeg still streams each file once — so the transfer is
  now the whole cost, where before it was hidden behind decoding.
- **A storyboard cue now states the time of the frame it is actually showing.**
  Tiles land on the keyframe at or before each sample point, so a cue can cover
  an uneven slice of the timeline — the VTT says which slice rather than
  claiming an exact grid it did not sample. Scrubbing is therefore only as fine
  as the source's keyframes: a video keyed every 10s gets a tile every 10s where
  it would previously have had one every 2s. Sheets get correspondingly smaller.
  A video whose keyframes cannot describe it at all — a single-keyframe encode —
  still gets one full decode rather than a one-tile storyboard. Set
  `CAIRNDEX_STORYBOARD_SAMPLING=exact` to decode in full everywhere, which is
  only worth it for a local library.
- **Storyboard cache format v3.** Existing sheets stay in place but are ignored,
  as with any format change; one Update/storyboards run regenerates them. The
  sampling mode is part of the cache key too, so switching it retires cached
  sheets rather than leaving a library holding a mix of two qualities.

- **Every inspector section folds.** Notes, Tags, Collections, Moments and Files
  each get a heading you can click to fold them away — anywhere on the row, with
  the chevron on the right appearing only under the pointer, so a rail of
  headings reads as labels rather than as controls. The single-line facts above
  them stay put. What is folded is remembered across bundles and across the
  shell's rail and the viewer's docked one, because it is a view preference
  rather than something about a bundle.

- **The range track zooms.** With the pointer over the magnified track, the wheel
  zooms it around the cursor and ⌥-wheel pans it — and scrolling counts as using
  the player, so the controls no longer fade out from under the pointer
  mid-adjustment. **Anywhere else over the media, the wheel is the volume**, in
  the same 5% steps the arrow keys use; the range track takes the wheel first,
  and panes that scroll keep it — so a minute-long span can be
  worked at frame scale instead of a tenth of a second per pixel. Double-click
  puts it back to fitting the selection, and a hand-set window that the selection
  has left re-fits itself rather than stranding you on empty timeline.

### Fixed

- **Desktop distributions now carry and verify their complete license notices.**
  `LICENSE` no longer misstates the pinned FFmpeg build as GPL-2.0-or-later; its
  `--enable-gpl --enable-version3` configuration is GPL-3.0-or-later, matching
  the manifest and third-party notice. The app now embeds Cairndex's MIT license,
  the third-party notice, and complete GPLv3/LGPLv3 texts. CI checks the app;
  release builds also mount and check the DMG, then attach the four texts beside
  the artifact.

- **Marking and forgetting a moment no longer lag.** Forgetting one takes the row
  away on the click instead of a round trip later, and marking one puts the new
  row in from the answer the save already returned rather than throwing the list
  away and fetching it again. Marking also stopped refreshing the bundle's tags
  and the tag and bundle counts — a moment saved without tags cannot have changed
  any of them, and on a large library those were the slow part.
- **A saved moment appears in the rail straight away.** Marking one wrote it
  correctly but the row did not show up until the app was reloaded, because the
  frame being decoded for its preview was holding the save itself invisible for as
  long as that took. The preview is now built well clear of the save.
- **The viewer's controls no longer disappear from under the pointer.** Resting
  the cursor on a control while you read it let the chrome idle out after a couple
  of seconds — and hiding it also makes it unclickable, so the next click passed
  straight through to the picture and was spent bringing the controls back. It
  read as the first click on **Save Moment** doing nothing and the second one
  working, and was true of every button down there. A pointer sitting on a control
  now counts as someone about to use it.
- **Tagging a moment is as quick as tagging a bundle.** The pill now appears on
  the click rather than a round trip and three refetches later — the same
  optimistic write the bundle's own tag picker has always had.

- **A moment row shows one tag in full, and `+N` for the rest.** It used to clip
  the second one against the edge of its region, which read as a rendering fault
  rather than as "there is more"; the count opens the picker, where they all are.

- **The range bar's actions fit on one line.** Squeezed into the column beside
  the In/Out steppers they had barely half the bar's width, so **Save GIF…**
  wrapped onto a second line below **Save Moment** — which made the two look out
  of order. They span the bar now.

- **A moment row lines up.** The timecode, the tags and the actions were a mix of
  baseline-aligned text and centred icons at three different heights: a CJK tag
  pill is taller than a Latin one, and the `⋯` glyph sat low in its box. Every
  item in the row is now the same height and shares one centre line.

- **A moment row uses the whole width it has.** The tag region shared the free
  space with an invisible spacer, so it gave up half the row — visible as a gap
  on the right, and as an add button that disappeared long before the row was
  actually full. The add button is also round now, with the `+` centred in it,
  and appears with the row's other controls rather than sitting there always.

- **The range bar no longer claims a 30-second limit.** There is none on a range
  or on a moment; it is the GIF export that is bounded, and it now says so by
  greying out **Save GIF…** with the reason in its tooltip, rather than by a
  "max 30 s" notice beside the length that read as a limit on the marks.

- **The docked inspector's bottom is reachable again.** The player's control bar
  is absolutely positioned and spanned the whole window, so it lay *over* the
  lower part of the inspector docked beside it — anything low enough in that pane
  could not be clicked or hovered at all. The top bar already stopped at the rail;
  now the control bar does too.

- **A right-click menu no longer dismisses itself.** Opening one from a control
  near the edge of a scrolling panel — the inspector's rails, most of all — could
  close it instantly: clicking the button scrolls it into view, and any scroll
  dismissed the menu. The dismissal now starts a frame later, so the gesture that
  opens a menu is allowed to scroll.

- **A moment's thumbnail no longer covers the whole window.** The frame beside
  each saved moment is a storyboard tile, and it was borrowing the hover preview's
  filling style — which is `position: absolute; inset: 0`. That fills a positioned
  card, but the inspector row has no positioned ancestor, so the tile escaped to
  the viewport and drew a full-window video frame over the app: the inspector
  looked like it had not opened, and clicks fell through to the grid behind it, so
  a single click on a bundle could land as a double-click and open the player. It
  only happened for a bundle that had a moment *and* a generated storyboard.
  The tile now brings its own style and its own containing block, and
  `StoryboardTile` no longer hard-codes one consumer's class.

- **The click after dismissing a right-click menu no longer opens what it lands
  on.** Dismissing a menu is deliberately invisible to the app — the click stops
  at the menu rather than also acting on whatever is underneath. But it was not
  invisible to the browser's click counter, so the *next* click arrived as the
  second half of a double-click: on a bundle card that meant one click opened the
  media viewer, and on the viewer's stage it meant one click closed it. A control
  clicked right after a dismissal could also look dead, because its click was the
  swallowed one. Genuine double-clicks are unaffected.

- **A folder row goes when its last file leaves the bundle.** Removing files
  from a bundle one at a time used to leave the folder behind reading "Folder ·
  0 files" — a row standing for nothing, with no way to fill it. Trashing is
  unaffected and deliberately so: a trashed file is still a member, so a folder
  entirely in the trash keeps its row and Put back finds it there.

- **Suggestion rows at the same level line up again.** A collection row carried
  4px of horizontal padding that a bundle row did not, so two suggestions at the
  same depth sat 4px apart and read as parent and child. The padding is what
  gives the folder-header background and the drop highlight room to breathe, so
  it stays — pulled back out with a matching negative margin, the same way the
  amber "needs a look" bar already cancels its own.

  While checking that, a second one: the amber bar hangs 6px into the left
  margin, and only nested rows had room for it — on a **top-level** row it was
  simply not drawn, which is the row most likely to be read first. The tree now
  reserves the space.

- **A work with an album subfolder is one bundle, and converting no longer
  loses it.** Two owner-reported faults in the folder suggestion, found by
  running it on a real library.

  A folder holding a video and a subfolder of images was suggested as a
  *collection* — the video one bundle, the images another — so the thing being
  looked at had no single row at all. It is now one bundle: the video, and the
  subfolder as a folder row beside it. That is the original ask stated exactly
  ("every item in the folder in a bundle, along with other files not in the
  folder"), and it had been missed. Merging is deliberately narrow: it happens
  only when the folder's own media is one subject and every subfolder is an
  album, so two videos beside a folder, or a subfolder holding its own film with
  sidecars, still read as a collection.

  **Convert to bundle** then destroyed the folder row it had just been given.
  Converting merges the descendants' files into one bundle, and the folder row
  is a statement about how some of those files are drawn — so it now comes
  along, which matters most for exactly the action people take on a folder that
  has one.

  The dialog also draws a folder row *after* the loose files rather than before,
  which is where the bundle inspector puts it once applied. The two surfaces were
  showing the same bundle in two orders.

- **Two jobs on screen no longer share one progress row.** Pressing Update while
  a storyboard pass was running left a single row whose label, count and bar each
  belonged to a different job every half second. Both flows were reporting into
  one slot, on the assumption that one maintenance flow runs at a time — which
  the Update flow breaks itself, since it hands metadata and storyboards to
  background watchers and returns. Each job now keeps its own row. Enqueuing also
  wakes the queue list, which stops polling while it is empty: until it did,
  anything the client was not itself watching — a second job, work started from
  another window, a reload mid-run — showed nothing at all.

  Update reads **Waiting…** while its scan is still queued, rather than claiming
  to be updating: a scan jumps the queue now, but the job already running keeps
  the worker until its next checkpoint.

- **Creating a bundle no longer slows down as the library grows.** It took about
  five seconds on the owner's library (2026-08-26). Almost none of that was the
  bundle: every FTS search-index maintenance trigger located a bundle's row with
  `WHERE bundle_id = ?`, and `bundle_id` is `UNINDEXED` in an FTS5 table, which
  supports no secondary indexes — so each one scanned the whole index. A single
  create fires around ten of them (a file moving between bundles reindexes both).

  Measured on a synthetic 60k-bundle library: one create cost **94 ms** with the
  triggers and **6 ms** without, and the scan alone was 8.5 ms against 0.0 ms for
  the same delete keyed by rowid. Every trigger now keys on the bundle's own
  integer rowid, which the FTS row shares: **94 ms → 21 ms**, and the remaining
  cost is flat in library size rather than linear (15 ms at 4 bundles, 7 ms at
  60k). On the first open after this change the index is rebuilt once — about
  0.5 s for 60k bundles — because rowids assigned by the old scheme bear no
  relation to their bundles.

  The module's own comment blamed "a correlated view" for trigger cost, which is
  what sent this investigation the wrong way at first; the view side measures
  2.1 ms. That comment has been corrected in place.

- **Bundle suggestions no longer read the whole file table to find a folder.**
  Every candidate lookup behind the bundling dialogs matched `relative_path LIKE
  'folder/%'`, and SQLite cannot use an index for `LIKE` under its default
  case-insensitive rules — nor with the `ESCAPE` clause that spelling carried,
  which disables the optimization outright. So each distinct folder in the
  selection cost one full read of `asset_files`, paid on dialog open, and paid in
  full even when the folder matched nothing. On a synthetic 100k-file library
  that was 5.0 ms per folder against 0.06 ms for the indexed form — and far worse
  on network-mounted storage, where the difference is a whole-table read versus a
  few index pages.

  Both directions now resolve through the existing `asset_files.directory_path`
  index: an equality probe per enclosing folder, and a half-open range per
  subtree. A test asserts the query plan names that index, because a regression
  here does not necessarily show up as a scan of `asset_files` — the planner may
  drive from `asset_bundles` instead and test each bundle's files, which is
  equally slow and reads as innocent.

- **A file added below a bundle's folder now finds that bundle.** Folder locality
  was an exact-match test, so a file landing in a subfolder of where a bundle
  lives earned no locality credit at all and surfaced only if the filenames
  happened to overlap. Suggestions now walk up to three enclosing folders,
  scoring closer folders higher, with the folder distance named in the reason
  ("same folder", "parent folder", "2 folders up"). The library root is
  deliberately excluded: it encloses every path, so matching on it is evidence of
  nothing.

- **A bundle that is gone empties the inspector instead of describing it.** After
  a Forget — or a scan dropping a staged row — the right-hand panel kept the
  bundle it had been showing: title, file rows, missing badge and all, for
  something no longer in the library (owner, 2026-08-24). A detail request that
  comes back "not found" is now a normal answer rather than an error, so the
  panel says *"That bundle is no longer in the library."* — still distinct from
  "Loading…", which is what an unloaded bundle says. Forgetting a bundle's last
  file also clears the selection and closes its album view, the way deleting a
  bundle already did.

- **Deleting a bundle that holds a missing file no longer leaves the file
  behind as a new card.** Dissolving a bundle returns each of its files to
  Unbundled as a fresh one-file bundle — which it was doing for *missing* files
  too, so the card you deleted came straight back under a new id, in Missing
  Files, and took a second delete to shift. A missing file has nothing on disk
  to fall back with, so it now goes with the bundle. Removing a missing file
  from a bundle drops it the same way, and takes the bundle with it if that was
  its last file, rather than leaving an empty one to sit in Unbundled.

- **Open in Default App and Reveal in Finder are on every bundle card, whatever
  format its file is.** Both were absent from a card's menu whenever the web
  viewer could not stage that card's file — a present file in a format Cairndex
  cannot show, and every card in the Missing Files view — because the menu read
  the *playback* path, which the server fills only for a file the viewer can
  play. Handing a file Cairndex cannot show to an application that can is one of
  the better reasons to want Finder, so that was exactly backwards; and rows
  that vanish read as features that were never built, which is how this started
  (owner, 2026-08-23). ⌘↩ and ⇧↩ resolved a selected bundle through the same
  field, so they had the same hole.

  A bundle summary now carries the file it stands for **on disk** — its playback
  cursor, else the source of the cover you are looking at, else its first file —
  and the menu and the shortcuts read that. Whether Cairndex can play something
  no longer has any bearing on whether the OS can be handed it. Nothing about
  playback moved: the `resume_*` fields still describe only what can be played,
  and the viewer, hover previews and card metadata still read those.

  A file that genuinely is not there still refuses, and now says why instead of
  disappearing: the shell resolves the path against the real filesystem when the
  action runs, so a missing file answers that it does not exist at its mapped
  location, and an unmounted volume asks to be reconnected. That check is
  deliberately not the library's own `missing` flag — a snapshot from the last
  scan, which would refuse a file that has since come back.

- **Opening the Random tab is no longer the slowest thing in the app.** A page
  of the bundle grid summarized one bundle at a time — a query per row, so a
  100-row page cost 100 extra round trips on top of the two that fetched it.
  That is the shape this library cannot afford: the owner's library is on an SMB
  share at ~36 ms a round trip, where **statements are the cost, not
  milliseconds** (the 2026-08-13 finding, which fixed the grouping code and
  should have been read as a constraint on the whole read path). Every view paid
  it, but Random paid it worst: its rows are scattered across the table by
  design, so not one of those per-row lookups lands on a page an earlier row
  already warmed, and it is the one view a session cannot arrive at pre-warmed.

  A page now loads its files, watch progress and cursor selections once, so it
  costs **four statements regardless of how many bundles are on it**. Measured
  read-only against the owner's library: **56 statements and 145–185 ms → 4
  statements and 13 ms**, warm; cold, at the 36 ms round trip the share
  actually charges, the same page goes from roughly 3.7 s of waiting to 0.15 s.
  Continue Watching had the same per-row load and gets the same fix. A test pins
  the statement count so it cannot creep back a row at a time.

- **⌘H hides the desktop app.** It did nothing, because the shell builds its
  whole menu bar from the shared keymap table and that table's App menu had no
  **Hide** item — and on macOS the Hide item *is* where ⌘H comes from. The App
  menu now carries the standard trio: Hide Cairndex (⌘H), Hide Others (⌘⌥H) and
  Show All. Their accelerators belong to the OS rather than the table, so the
  test that stops an app shortcut shadowing a built-in one knows about them now
  too.

- **The Justified layout's rows are the size they claim to be, and its last row
  no longer towers over the rest.** Two faults in one packing rule. It always
  broke a row *after* the tile that overflowed it, so a wide cover arriving at
  the end dragged the whole row down — measured at 74–100% of the target height,
  every row under it, which is why the view read as too small however far the
  size slider went. It now breaks on whichever side of the target is closer, and
  measured on the same content lands within 10% of it. And a short last row was
  allowed 1.3× the target while full rows undershot, so the final row — a single
  bundle, often — could be nearly twice the height of the row above it. It is
  now capped at that row's own height, and simply stops short of the right edge
  the way a justified gallery should.

- **Covers no longer sit in a black frame.** Two separate causes, one per
  layout. The **Card** layout's cover frame was 1.61:1 — not a shape any camera
  produces — because its height was whatever remained after the title block, so
  the frame's real proportions depended on the meta's font metrics and the card's
  border. It is now exactly **16:9**, declared in CSS rather than arrived at by
  arithmetic, so a 16:9 cover fills it and only a genuinely different cover
  letterboxes. The **Justified** layout shaped each tile from the file under the
  playback cursor, which is the file that *plays*, not the one the cover comes
  from — those follow different rules, so a chosen cover or an image leading a
  video bundle put the cover in bars. Tiles now take the shape of their own
  cover, which the browse response reports as `cover_width`/`cover_height`.

- **A toolbar action no longer sits in the middle of the row.** Random's
  **Shuffle** button occupied the sort control's slot — for a good reason, since
  Random has no sort — which put it between the search box and the layout
  buttons. The residents (filter, search, sort, layout, zoom) are furniture whose
  positions are worth learning, so an action appearing among them shifts the lot.
  Actions now sit immediately left of the residents, which is where the File
  Browser's **Add Files Here** / **New Folder** and Trash's **Empty Trash…**
  already were.

- **A collection can be renamed again.** The inline rename box existed but
  nothing ever reopened it: it appeared once, on a row, in the seconds after
  that collection was created — so a collection named by accident, or named
  before the right name was obvious, was stuck with it. **Rename Collection** is
  now on a sidebar row's context menu and on a folder card's in the grid; both
  open the same box, unfolding the tree to reach it when the row is inside a
  folded branch. Only for one collection at a time, since renaming is a single
  name in a single box.

- **Right-clicking no longer leaves a highlighted word behind.** WebKit selects
  the word under the cursor when a context menu opens — Chromium does not — so in
  the desktop app every right-click on a card title, a sidebar row or a tag left
  a stray highlight, sometimes only the fragment of a word the cursor landed in.
  Nothing ever acted on it: those surfaces replace the native menu, and none of
  our menus has a Copy item. The selection is now dropped as the menu opens,
  everywhere in the app at once, and left alone inside a text field, where the
  caret and any selection are the point.

- **A bundle's note box can be dragged smaller again.** Bringing a tall note
  down takes several short drags of its grip, and the second one always sprang
  it back to full height: a drag is also a press and release on the same spot,
  so two in quick succession are a double-click as far as the browser is
  concerned — and double-clicking the grip means *fit to text*. The box simply
  read as un-shrinkable. A double-click now only fits when neither half of it
  moved the box, which is tracked as gestures rather than elapsed time because
  the double-click threshold is a system setting no timeout reliably outlasts.

- **The viewer's info panel no longer runs the full height of the window.** Its
  file list grew one row per file with nothing to stop it, so a bundle with two
  dozen files buried the metadata above it and covered the whole right side of
  the picture. The list is now capped at about half the player's height and
  scrolls inside that cap; the metadata stays where it was.

- **Dismissing the viewer's right-click menu no longer starts the video.** The
  click that closed the menu also landed on the player underneath, so cancelling
  a menu began playback — and because the menu opens at the cursor, the click
  before that one hit the menu itself and appeared to do nothing. The menu now
  keeps hold of the whole gesture that dismissed it, rather than only the part
  that arrived before it closed. It behaved in Chrome and misbehaved in the
  desktop app, which is what a timing-dependent fix looks like from the outside.

- **Placing a grouping suggestion inside an existing collection no longer draws
  that collection's parent a second time.** Choosing a destination materializes
  the destination's ancestry as read-only "Existing" rows, and it built that path
  from scratch every time — so a plan whose own top-level row is a folder called
  `Archive`, placed into the existing `Archive ▸ Talent`, grew a *second*
  top-level `Archive` beside the first, and the review appeared to be inventing a
  hierarchy it was already showing. The path now stops where the plan already
  speaks for the same collection: the row on screen is adopted as the branch head
  and pinned to that collection, staying editable — its title, its stem dial and
  its own placement are untouched — and only the levels below it are added. Apply
  was never wrong here (an unlinked collection suggestion resolves to the
  existing collection of the same name under the same parent, so both rows always
  led to the one collection); the tree was.

  Two smaller consequences of the pin. A row that stands for a collection is now
  **refused as a destination for itself** — it would have become its own parent,
  and a self-parented row leaves the tree altogether. And a pinned row keeps the
  title the owner typed: refreshing the structural snapshot from the live
  collection tree, which is right for an "Existing" row, would have quietly
  reverted a rename on an editable one.

- **Narrow and Widen no longer reset the folder they sit on.** The dial re-suggests
  one folder's grouping, and it did that by replacing every row for that folder —
  the folder's own row included. So renaming a collection suggestion, placing it
  inside an existing collection, and then nudging the dial silently undid both:
  the row came back with the folder's name and the suggester's parent, and the
  "Existing" path the placement had built was pruned for leading nowhere. The
  folder's row is kept now, and the re-suggested bundles hang under it. Only what
  is *inside* the collection is redone, which is all the dial ever claimed to do.

  Two folds of the same rule. A collection *inside* the folder — one the owner made
  with "convert to collection" from a bundle there — is still grouping, so the dial
  still redoes it. And a folder the suggester insists is a single bundle, made a
  collection by hand, keeps that collection: its one re-suggested bundle now goes
  inside the row instead of beside it, where it used to leave the row childless and
  delete it — so a control that could not regroup that folder at all was dissolving
  the conversion.

||||||| parent of 501947ef (fix(viewer): cancelling the right-click menu no longer plays the video)
- **A GIF export saved from the desktop app no longer fails with a 404.** The
  finished artifact is fetched through the shell's loopback media relay, the
  same way a contact sheet is, so that the bearer never has to travel in a URL —
  but the relay's route allowlist did not name it, so the shell answered its own
  404 before the request ever reached the server. Exactly the failure contact
  sheets shipped with in 2026-07, repeated by a route added since. The web app
  was unaffected, which is why it went unnoticed. Only the download is relayed;
  create, poll, and delete carry their own auth, and the relay still refuses
  anything but GET and HEAD.

- **A playback session that died no longer surrenders to the unplayable card.**
  When a session's segments stop resolving — the ordinary consequence of it
  being reaped after a long pause — the client is supposed to request a fresh
  decision and carry on. It stopped doing so in 2026-07, when failures began
  being classified by the element's `MediaError` so that a file the browser
  genuinely cannot decode would skip the retry budget. The two collided: an HLS
  element reports `MEDIA_ERR_SRC_NOT_SUPPORTED` for a segment that 404s just as
  it does for a codec it refuses, so a dead session was read as a bad file and
  went straight to the card. An HLS failure now goes to the bounded re-attach
  budget first, and only the engine — which alone saw whether hls.js called the
  fatal a media error or a network one — can refuse outright. Direct playback is
  untouched, which is the case that classification was written for.

- **A video the browser cannot decode is now converted instead of refused.** The
  playback decision compared the source's container and codec *family* against
  what the client advertised, and nothing else — so a 10-bit source passed,
  because every capability probe string a browser answers (`avc1.640028`,
  `hvc1.1.6.L93.B0`) describes an 8-bit profile. High 10 H.264 is the worst
  case: no browser decodes it at all, and it arrived on the direct path and
  failed with "This video can't be played here." Colour depth and Dolby Vision
  now take part in the decision, clients advertise the depths they separately
  confirmed, and a source that fails either is transcoded — which is what the
  server was there to do. A client that does confirm 10-bit still plays it
  directly, and a 10-bit file in the wrong container still only pays for a
  remux.
- **Playback no longer waits for the metadata job to have run.** The decision
  reads codec, depth and duration off the file's row, and with none of them
  present it had to guess "play it directly" — so a freshly scanned library
  handed every file straight to the browser, and anything the browser could not
  decode failed until the owner found **Collect metadata**. A file whose
  metadata is missing or from an older probe is now probed on the way to the
  decision: one file, bounded, written back, and silent if it fails.
- **The File Browser can play a library that was never scanned.** A path with no
  index row skipped the decision entirely and fell through to a native read, so
  file-browser-only use could show only what the browser itself decodes. A bare
  path now gets the same decision and the same remux/transcode sessions, with an
  on-demand probe standing in for stored metadata. What still needs a row stays
  absent for an unindexed path: subtitles, storyboards, resume, and cover frames.
- **A contact sheet cut from the File Browser prints its real dimensions.** The
  listing carried codecs and duration but not width, height or frame rate, so
  the sheet's Details row read `— / —` where the same file cut from the Bundle
  Browser read the real numbers. The listing now carries all three (and colour
  depth, so hover preview judges direct playability the way the server does).
- **HEVC files tagged `hev1` now play directly instead of being converted.** The
  two HEVC tags differ only in where the stream's parameter sets are allowed to
  live, and Safari — so the desktop app — plays only `hvc1`. That single refusal
  was why such a file needed a server-side conversion at all, and everything that
  followed from one: an ffmpeg process, a session that could expire, the pauses
  and stalls when it did. The five bytes of header that distinguish the two tags
  are now rewritten as the file streams, which is byte-for-byte what the
  conversion produced — so the file plays directly, immediately, with nothing
  running on the server. A file whose parameter sets are *not* provably complete
  in its header is left alone and converted as before, because relabelling that
  one would break playback partway through.
- **A video left open no longer has its playback session deleted underneath it.**
  The server reaps a session with no playlist or segment fetch for 60 seconds —
  and a *paused* video fetches nothing, so leaving the viewer open was enough to
  lose it. Seeking past the buffered region then found a hole, and with the
  playlist gone too the player ended the stream and reported the duration as
  whatever had been buffered: 18:31 for a 68-minute video, with the controls
  dead. A held session is now kept warm for as long as the player holds it, and
  a touch that comes back "no such session" establishes a fresh one at the live
  playhead instead of waiting for playback to trip over the gap.
- **The info panel says how the video is actually playing.** A **Playback** row
  now reads Direct play, Remuxing or Transcoding, tags the latter two with an
  `HLS session` badge, and prints the server's own reason for choosing it
  underneath — "hevc video codec is not in client capabilities", say. The server
  had always decided this and always explained itself; none of it reached the
  screen, so the difference between a file streaming untouched and one burning an
  ffmpeg process behind it was invisible. That gap mattered more once `hev1` HEVC
  began playing directly, because the files that used to need a session mostly
  stopped needing one. To exercise the other path deliberately, pick a quality
  below the source's own height from the player's settings menu — the row flips
  to Transcoding while you watch.
- **A refused HEVC relabel now says why, in the Playback row.** "hev1 codec tag
  is not in client capabilities" was true and useless: it did not distinguish a
  file whose header cannot be relabelled from a client that would not take the
  result anyway, and both fell back to a session in silence. The reason now names
  which — "this client plays no HEVC tag progressively", or "its header carries
  no VPS, so the decoder needs them in-band". A third case is called out
  explicitly rather than left silent: a file whose container header disagrees
  with its probed codec tag, which is a defect here rather than a property of the
  file.
- **A clip range whose end sits on the file's own end now behaves.** Marking an
  in-point late in a video slides the span so its out-point lands on the
  duration — and from there the media ended itself before the range could act, so
  Loop never came round, the playhead parked at the far right, the viewer stepped
  on to the next file, and the next press of play restarted the whole video with
  the marked span silently ignored. `pause` and `ended` have distinct owners now:
  the pause the media performs at its own end belongs to the range, Loop comes
  round from it, and a non-looping span parks at the in-point so the next press
  replays the span.
- **A video that quietly stops now says so instead of freezing.** The load
  watchdog stops caring once metadata arrives, and after that the only thing
  that reaches the failure path is the media element's own `error` event — which
  a progressive read that simply dies never fires. The result was the last frame
  on screen with a live control bar, no message, no retry, and nothing being
  requested: play and seek appeared to do nothing at all. A stalled read is
  detected now and ends in the ordinary "Playback interrupted / Try again" card.
  It watches progressive sources only, counts bytes landing in *any* buffered
  range as progress, and ignores a gap left by a sleeping machine — each of
  which would otherwise interrupt playback that was actually fine. It shows the
  card straight away rather than reloading first: a stalled read is already dead,
  and reloading it churned the control bar through `3:32 / 0:00` three times
  before saying anything, which read as a worse freeze than the silence.
- **A failed recovery no longer swallows every error after it.** The flag that
  suppresses the burst of errors around one reload was cleared only when a new
  source arrived, and two of the ways a retry can end don't produce one — so
  after a single failed recovery the player would ignore every later failure,
  leaving a frozen frame with no card and no way back short of reopening the
  video.
- **The desktop app can play a File Browser video that needs converting.** The
  shell's media relay allowlists routes explicitly, and the path-scoped playback
  sessions added in the previous entry were not on the list, so it answered its
  own 404 before the server ever saw the request — working in a browser and
  failing in the app.
- **An unbundled video in the viewer shows its own details, not a bundle's.** A
  scan stages every new file into a provisional one-file bundle, so an unbundled
  file has a `bundle_id` like any other — and the viewer's docked pane took that
  as licence to show the Bundle Inspector, stating that the file was in a bundle
  when it was not. Only a *confirmed* bundle gets the bundle pane now; an
  unbundled file, and a File Browser path that was never indexed, get the file
  inspector instead. The toggle is named for whichever it will open, and it is
  no longer disabled for an unindexed path — that path has details too. The file
  inspector also reads real dimensions and frame rate for a File Browser row now
  that the listing carries them.
- **Two playback-position writes landing together no longer fail one of them.**
  The player saves progress periodically *and* on completion, which on a short
  file arrive at once — and the write was read-then-insert, so both found no row,
  both inserted, and the second hit the primary key and returned a 500. It is
  one `ON CONFLICT DO UPDATE` statement now, so whichever arrives second updates.
  Last-write-wins is unchanged.
- **A snapshot's filename no longer mangles the source's extension into its
  stem.** `clip.mp4` produced `clip_mp4.png`; it now produces `clip.png`,
  matching how GIF exports are named.
- **A collection's count now says what opening it will show.** The badge counted
  everything in the collection's whole subtree while the grid beside it listed only
  that collection's own bundles, so a parent read `1` next to an empty grid whenever
  its one bundle sat in a child — and moving a bundle from a parent into its own
  child left the parent's number motionless while the grid lost a card, which read
  as a count that refused to update. The badge now follows the grid: a collection's
  own bundles, or the subtree total when **Show subcollection contents** is on.
  Both figures come from the same request, so the toggle costs no round trip, and
  the collection inspector still shows the two side by side as it always did.
- **A drop that lands quickly after it starts no longer does nothing.** Dropping
  bundles on a collection re-read the dragged ids from React state, which a fast
  drag outruns — the app keeps a synchronous copy for exactly this reason and every
  other part of the drop path already used it. When the two disagreed the write was
  never sent at all: no card moved, no count changed, and nothing later corrected it
  because nothing had happened.
- **Holding ⌥ while dropping bundles on a collection copies them instead of
  moving them.** It was meant to already, and mostly moved. The app read the
  modifier off the drop event's `altKey`, which a native macOS drag does not
  reliably deliver: the window server owns the keyboard for the duration, and
  whether the flag reaches the page depends on the browser engine — Chrome passes
  it through, the desktop shell's WKWebView does not. That is a limit on web
  content, not on macOS; every native app tracks ⌥ mid-drag by reading the
  system's own event state. So the desktop shell now reads it the same way and the
  app asks the shell for the duration of each drag (ADR-0023), which is what makes
  ⌥ work mid-drag there at all. The browser build keeps using the drag events'
  own flags, and both fall back to the modifier state at `dragstart` — read before
  the drag takes the keyboard — so holding ⌥ *before* starting a drag works with
  no host at all. The default is move: a wrong move is one undo, while a wrong
  copy quietly duplicates membership. The cursor's copy badge follows the same
  answer, so it can no longer promise a copy the drop won't perform.
- **A collection opened after a drop shows what is in it, not what was.** Dropping
  bundles on a collection rewrote the cached listings it could work out and marked
  the rest stale — but a stale listing is still served the instant its view opens,
  refetching behind it, so any listing the rewrite quietly skipped showed its
  pre-drop contents while the count beside it had already moved. Listings the
  rewrite cannot prove — one carrying a filter or a search, an arrival with no
  cached card to draw, a drag whose memberships had not loaded yet, and
  Uncategorized or Untagged — are now dropped instead, so the next open fetches
  them. The grid on screen still refetches in place rather than blanking. A browse
  fetch already in flight when the drop lands is also cancelled: it used to answer
  afterwards with the pre-drop page, overwrite the rewrite, and take the reconciling
  refetch down with it as a duplicate request.
- **A sidebar count no longer includes bundles the listing beside it hides.** Both
  the per-collection and per-tag counts totted up membership rows without asking
  what was on the other end, so an unbundled file — which belongs to the Unbundled
  view and no other — was counted against every collection and tag it was filed
  into. Opening that collection showed one fewer than its own badge claimed. A tag
  carried only by unbundled files now reports 0 rather than dropping out of the
  picker.
- **Accepting a selection keeps the review open on what is left.** Reviewing a long
  plan happens in batches, and every accept used to end the dialog, so carrying on
  meant reopening it. Accepting now confirms the chosen bundles and immediately
  suggests again for whatever is still unbundled, saying what it accepted and how
  much is left. The rows the owner skipped stay skipped — a second accept must not
  be one click away from confirming exactly what was just declined. A conflict, or
  nothing left to suggest, still ends the review with its summary.
- **A folder states its destination once instead of on every row beneath it.** The
  placement pill repeated the same answer as many times as the folder had
  suggestions. Rows inside a folder now fade theirs out at rest and show it on
  hover or focus — faded rather than dropped, because it is the keyboard path for
  moving a single row out of its folder.
- **Superseded grouping plans are deleted rather than kept forever.** They were
  marked and never removed, accumulating one per regeneration with a full set of
  proposal and file rows each — 116 of them holding 5,455 rows for a 412-file
  library. Applied plans stay, since they record what was applied.
- **A folder holding thousands of releases no longer groups in quadratic time.**
  Sidecars were matched by scanning every candidate bundle for every sidecar, with
  a nested scan over each bundle's stems inside that — so one folder of 1,600
  subjects spent 10.2 million string comparisons and 4.3 seconds, and a folder of
  several thousand took minutes. Every group is keyed by exactly one stem, so
  matching is now a dictionary lookup per sidecar plus one per prefix of its own
  name: 1,600 subjects in 73 ms instead of 1,671, and growth is linear. Narrow and
  Widen re-run the whole suggester, so they carried the same cost per click.
- **The grouping phase of a scan reports what it is doing.** It was a single
  opaque call, so on a large library the progress bar animated for a long time
  under one unchanging label, which reads as a hang. Matching filenames and
  writing the suggestions are now separate steps, and the second counts its rows.
- **Accepting a selection no longer throws the plan away and builds a new one.**
  A partial accept used to close the plan, so carrying on meant generating a fresh
  one: two sequential round trips per accept — 942 ms then 851 ms on the owner's
  library — returning an entirely new set of proposal ids. Fold state is keyed on
  those ids, so every collapsed folder reset and the tree jumped under the cursor.

  A plan now closes when it has nothing left to review rather than when part of it
  was accepted. Accepting retires the rows it confirmed, plus any collection left
  holding nothing, and leaves the rest exactly where they were. One request instead
  of two (**1,793 ms → ~750 ms**), the surviving rows keep their ids, and nothing
  re-folds. Applying the *whole* plan is unchanged, including its documented
  idempotency.

- **A collapsed run's "Show all N" no longer floats off on its own.** It was pushed
  right with `margin-left: auto` in a row that wraps, and an auto margin on a
  wrapped flex item pins it to the right of an otherwise empty line — so once a row
  above it changed height the button appeared detached from every row. It now flows
  after the run's summary text and stays with its row at any width.
- **Converting a bundle into a collection forgets that folder's stem level.** The
  split it performs is per video subject, not by the dial's stem key — deliberately,
  since a dial wide enough to merge everything would otherwise make "convert to
  collection" produce a collection of one. But the dial was left reading its widest
  beside rows the widest would never have produced: a folder split in two under a
  setting saying those two match. The override is dropped, so the dial reads the
  default that the split actually corresponds to, and Narrow/Widen still work from
  there.
- **Widening a folder no longer dissolves its collection.** Once a folder's files
  all matched, the suggester collapsed the folder into a single bundle named after
  the folder. That did three wrong things at once: it destroyed a collection the
  owner wanted to keep, it duplicated the convert control that dissolves one
  deliberately, and it left the dial at its widest on a row that was no longer a
  folder — so converting back stranded the setting. Widening now keeps the folder
  as a collection and puts the matched files in one bundle *inside* it, named by the
  stem that matched them. Collapsing a folder into a bundle remains available as
  what it always was: the explicit convert control.

  The collapse is still right when the *suggester* finds a single group — no
  collection wrapper around one bundle — so the rule is now "a bundle takes its
  folder's name only if the owner did not widen it there".

- **The stem dial says what it is matching on, and its buttons stop moving.**
  `Narrow`/`Widen` sat beside a "stem 2 of 3" label and a `Reset` button that only
  appeared away from the default; the row is right-aligned, so the label's width
  changed with its numbers and `Reset` appearing slid both buttons sideways —
  under a cursor about to click one of them. The label and `Reset` are gone, leaving
  two fixed-width buttons that cannot move. `Narrow` walks back to the default.

  The label also said nothing: the top of the dial depends on the folder's own
  filenames — 2 to 15 across one real library — so "of 3" was an ordinal with no
  readable meaning. A plan now reports, per folder, the **stem it is actually
  matching on**, sliced out of one of that folder's filenames so the separators are
  the ones on disk (`STUDIO-025`, not the comparison key's `studio 025`). Adjusting
  a folder now says so: *"Genre/Studio now matches on names like “STUDIO-025” — 12
  bundles."*

- **Grouping plans moved out of the library, onto the server's own disk**
  (ADR-0022). A plan is a snapshot of a suggestion run — regenerable from the
  library at any moment, and by far its heaviest writer: ~1,100 rows rewritten
  whenever the input changes, and touched again on every rename, reparent, convert,
  Narrow and Widen. Sending that across a network share was the wrong shape of
  problem to keep optimizing. The three tables are now a SQLite database under the
  data directory, attached to every library connection as schema `plans`, so a
  query can still join a plan to the library rows it describes.

  | | before | after |
  | --- | --- | --- |
  | write a 340-proposal plan | 4,614 ms | **78 ms** |
  | prune superseded plans | 1,431 ms | **12 ms** |
  | one Narrow/Widen | ~1,000 ms | **66 ms** |

  The file lives beside `registry.db` — `~/Library/Application Support/dev.cairndex.app/local-server/plans/`
  in the packaged desktop app, `/data/plans/` under Docker, `apps/server/var/plans/`
  in development. **A plan lasts as long as the server that made it:** the directory
  is cleared at startup, so restarting means pressing Update again. That is a
  deliberate trade for simplicity — the file is keyed on a path, so it is orphaned by
  a moved library and by a symlinked mount that was offline when its digest was
  computed, not only by deregistration, and clearing wholesale collects all of it
  without a sweep or a grace period. What it costs is a review in progress across a
  restart. Deregistering a library still leaves its plans alone, so remove-and-re-add
  stays reversible within a run.

  A library upgrading hands its plans over on first open — copied out, then the
  in-library tables dropped, in that order and inside a savepoint, so an
  interruption leaves them where they were. A plan no longer travels with its
  library: carry the library elsewhere and Update writes a fresh one.

- **Superseded plans are actually pruned now.** Two bounds sized for the old cost
  had between them stopped the backlog draining: pruning ran only when a scan wrote
  a *new* plan — so the steady state, Update finding nothing changed and keeping the
  open plan, never pruned at all — and it deleted at most four per run. The owner's
  library had 135 plans holding 5.6 MB. Pruning now runs on every Update, and 135
  became 20 (the rest are applied plans, kept deliberately) inside a 2.7 s Update.
- **A scan walks the library once, in parallel, instead of twice in sequence.**
  Two things made discovery cost more than the whole rest of the scan on a library
  over a network share. It walked the entire tree a second time purely to count
  files for the progress bar — now the rows already present are the estimate, and a
  first scan says "unknown" and reports its running count rather than inventing a
  total. And each directory listing waited for the one before it, though those are
  round trips rather than work: sixteen at a time, with each file's `stat` taken by
  the worker that listed it, took the owner's scan from 7.1 s to 2.6 s and its walk
  from 6.3 s to 1.3 s.
- **Writing a grouping plan to a library on a network share went from over ten
  minutes to under five seconds.** Two causes, both invisible on local disk:

  SQLite's page cache defaults to 2 MiB, which is smaller than a modestly used
  library database. `grouping_proposals.parent_proposal_id` references its own
  table, so with foreign keys enforced SQLite seeks the primary-key index once per
  inserted row — while the inserts themselves evict exactly those index pages. Each
  re-read is then a network round trip. Raising the per-connection ceiling to
  32 MiB (a ceiling, not an allocation — SQLite grows it lazily) took that insert
  from over ten minutes to 5.2 s.

  And none of the grouping foreign keys had an index on the child column, so every
  `ON DELETE` cascade was a full table scan per deleted row. Indexing the three of
  them took the insert to 236 ms and pruning four superseded plans from 6.4 s to
  1.4 s. A test now binds every grouping foreign key to an index, so a later one
  added without cannot pass unnoticed.

  Both are general: they make every write to a network-hosted library faster, not
  just plans.

- **Update no longer rewrites a plan that would come out identical.** A plan is a
  snapshot of suggestions over the files not yet in a confirmed bundle; if nothing
  in the library has been touched since it was written, regenerating produces the
  same few hundred rows and supersedes the plan the owner was working through. On a
  library whose database sits on a network share that rewrite measured **seven
  minutes, every press of Update** — the cost is journaled page writes, not
  statement count. Now the open plan is kept, which also means selections and edits
  survive an Update. The test is "was anything modified since", not the scan's own
  summary: `ScanSummary.updated` counts every row *examined*, so it is non-zero for
  any library with files in it, and a timestamp also catches a bundle deleted or
  fast-added through the UI between scans.
- **A first scan no longer inserts one row at a time.** Every new file cost two
  INSERT round trips — `session.add(bundle); session.flush()` inside the loop, just
  so the file could learn its bundle's id, which is knowable before the insert.
  1,803 statements for 900 files became 5.
- **Superseded plans are pruned a few per run rather than all at once.** The delete
  cascades through proposals and their file rows, so clearing a long backlog in one
  go is itself minutes of writes on a network share. The backlog drains over the
  next few generations instead.
- **Suggesting a grouping no longer writes the plan one row at a time.** The plan
  was persisted with a flush inside its loop, purely to learn the id it was about
  to need for that row's files — but ids are ULIDs from a plain Python callable,
  so they are known before the insert. And because each row's files were linked by
  foreign key rather than through the relationship, serializing the response then
  fetched every row's files back in its own query. Between them that was 10,400
  SQL statements for a 3,600-suggestion plan; it is now four batched inserts and a
  handful of reads, and the plan appears in 1.6s instead of 4.2s. The same
  per-row flush is gone from the bundle↔collection conversion and the
  Narrow/Widen splice.
- **Editing a large grouping plan is no longer measured in seconds.** On a
  library of ~20,000 files a conversion took over ten seconds. Two independent
  causes. On the client, folding a collection or closing a file list *hid* the
  rows rather than unmounting them, so every render of the plan still built and
  reconciled them — with file lists closed by default that was every file in the
  plan, a third of ~94,000 DOM nodes at 2,800 suggestions; folding now unmounts,
  and a plan longer than 400 suggestions opens folded, which is how one is read
  anyway. On the server, every mutation read the whole plan twice because the
  open-plan check went through the eager loader that exists for serializing a
  response, and merging a collection then fetched each descendant's files in its
  own query. Measured on a synthetic 2,700-suggestion plan: opening 2.2s → 0.75s,
  a conversion 5.0s → 0.8s on the client, and 0.4s → 0.1s on the server.
- **An identically named video and cover no longer lose their name's last
  segment.** `_shared_stem_title` trimmed at the last delimiter even when every
  filename *was* the shared part, so a pair like `A - B - 4K.mp4` / `A - B - 4K.jpg`
  would have been titled "A - B". Latent until sidecars joined the comparison.
- **A library created before the latest grouping columns opens again.**
  `grouping_proposals.is_collection_context` reached the model and the startup
  backfill but never the additive-column list, so an existing library never
  gained it and the first proposal insert after a scan failed with
  "table grouping_proposals has no column named is_collection_context". A new
  test binds the model to that list and fails for any future column added to one
  and not the other.
- **A popover left open no longer desynchronises a checkbox from what will be
  applied.** Dismissing a picker stopped the click reaching React but not the
  browser, so on a controlled input the DOM toggled while application state did
  not: a grouping row could untick itself while staying selected, and Accept
  then confirmed a bundle the owner had watched themselves skip. The dismissing
  click is now fully swallowed, and a keyboard-activated one closes the popover
  instead of being ignored — before, any popover opened by keyboard swallowed
  every subsequent click in its dialog until Escape.
- **The grouping review's Cmd/Ctrl+Enter now applies only when Accept would.**
  It reproduced none of the button's conditions, so it applied a plan
  mid-rename, with nothing selected, on an already-applied plan, and again on
  key auto-repeat while the first apply was still in flight.
- **Folder actions no longer appear on a read-only existing-collection row**, and
  a stem mode this build does not recognise now offers no folder actions at all
  rather than a "Merge" that splits.
- **Narrowing the review to uncertain suggestions no longer changes what a
  collection checkbox does.** It displayed whole-subtree state while toggling
  only the visible rows, so it oscillated between checked and mixed, never
  reached unchecked, and silently moved hidden rows' selection. The filter also
  falls back to the whole plan once nothing is flagged, instead of leaving a
  blank list under a tab that was both pressed and disabled.
- **A rolled-up run keeps its folder's actions, can be folded back, and is a
  drop target during a file drag.** It previously hid the Split/Merge pair for
  exactly the over-fragmented folder that needed them, could be expanded but
  never re-collapsed, and rendered no rows at all mid-drag. Its expansion also
  survives an in-place re-suggestion now, because runs are keyed by content
  rather than by ids that regeneration reissues.
- **The grouping review's row menu is operable by keyboard**, with focus moving
  into it on open, arrows between items, and focus returning to the trigger on
  close; arrow navigation no longer stops when focus lands on a row control; and
  Collapse all is disabled on a plan with no collections rather than enabled and
  inert.

- **Nested grouping suggestions now apply to the intended collection path.**
  Collection rows are tri-state bulk selectors rather than accepted work, so an
  individually selected inner bundle carries its full ancestor path without
  selecting sibling bundles. Existing collection context is labeled, read-only,
  and resolved by stable id; if it disappeared or moved, apply reports a conflict
  instead of creating a duplicate at the top level. New bundles and collection
  suggestions can be placed explicitly with a keyboard-accessible selector or
  drag-and-drop, including back to the top level. The selector now lists only
  collections already persisted in the current library; speculative collection
  suggestions remain editable in the review tree but are never presented as
  settled destinations.
- **Clicking elsewhere in the Bundle Inspector now leaves the active note.**
  The desktop webview could keep a note textarea focused when a pointer press
  landed on non-interactive inspector content. The inspector now blurs that
  editor explicitly, which removes its text selection and commits the latest
  note through the existing blur-save path.
- **A bundle converted into a collection could fail when immediately accepted.**
  The conversion response could expose its new child proposal IDs before the
  request-finalizer commit made them visible to the next database session, and
  its ORM snapshot could reuse the pre-conversion proposal list. Conversion now
  commits and reloads the complete plan before responding; applying also commits
  before the client refreshes bundle and collection views.
- **Large storyboard runs no longer fail partway through with “Cannot operate on
  a closed database.”** The library pass held a streaming SQLite result open
  while each file could spend minutes in ffmpeg and each progress checkpoint
  committed the same session. Candidate rows are now fully buffered in bounded,
  keyset-paged batches, so no database cursor crosses an ffmpeg or checkpoint
  boundary.
- **Grouping suggestions no longer wait behind media metadata collection.** The
  scan job had already generated and persisted its plan, but Update withheld the
  review until every file finished ffprobe. Review now opens as soon as scan
  completes while metadata continues in the sidebar job area. Storyboards remain
  chained after a successful probe because they need duration metadata; a probe
  failure leaves grouping usable and does not start an ineligible storyboard
  pass.
- **Desktop Add Library no longer turns a successful registration into an
  apparent failure when the library list cannot refresh.** The confirmation now
  remains visible with an explicit “library was added” result, the committed Add
  action is replaced by Retry refresh, and a successful retry shows the new
  library without registering it again. A failed initial library-list request
  is reported as a load error with its own retry instead of “No libraries yet.”
  The active desktop API base also survives Vite hot-module replacement, so a
  development refresh continues to target the local sidecar or selected remote
  server instead of falling through Vite’s port-8000 proxy.
- **The Trash listing no longer waits on a recursive SMB filesystem walk.**
  Loading Trash previously statted every displayed entry and then walked and
  statted the entire trash tree again before returning any rows. File sizes are
  now captured in the operation journal and older linked entries use database
  metadata, so the listing itself performs no trash-filesystem reads. An exact
  total is omitted for legacy or directory deletions whose size was never
  recorded rather than delaying the screen or understating permanent deletion.
- **Moving a Bundle Inspector file to Trash now removes its row immediately.**
  The UI previously waited for the journaled move to finish and then for a
  second bundle-file request, exposing the full latency of a network-mounted
  library. Active bundle-file caches now update optimistically while the same
  recoverable server operation runs, and roll back if that operation fails.
- **Bundle Inspector file rows now offer Move to Trash in write mode.** The
  bundle album already exposed the journaled, recoverable deletion, but the
  same file's inspector menu omitted it. The write-gated action now travels
  through the shared inspector action context, so it is available in both the
  shell rail and the inspector docked beside the media viewer, and absent when
  write mode is off. A trashed member now immediately leaves the bundle’s file
  list, cover fallback and playback playlist; its hidden relationship remains
  intact so Put Back restores that same file to the same bundle.
- **A job whose server stopped mid-run stayed "running" forever.** Restarting
  the server — or a dev-mode reload — left the row in the sidebar as work in
  progress that had died an hour earlier, and it could not be dismissed:
  cancelling it did nothing because nothing was alive to notice, and it did not
  even stop a re-run from queueing a second copy. Those rows are now closed out
  as interrupted when the server starts, which is the moment it is knowable.
  Re-running is safe and cheap — every library-wide job skips work that is
  already current.
- **Waiting looked exactly like working.** A queued job rendered the same moving
  bar as a running one, so pressing Update twice gave two identical rows with no
  way to tell which was live. A queued job now says it is waiting, with a still
  bar; a job that has been asked to stop says that instead.
- **Cancelling a queued job left it queued.** It was flagged and then started
  anyway when a worker got to it. It ends immediately instead — nothing was
  running it to notice the flag.
- **An interrupted storyboard pass left its scratch directory behind.** Cleanup
  ran on the failure path, and a stop is not a failure, so every killed run
  leaked one. Cleanup moved to where it always happens, and a library pass now
  sweeps whatever earlier interruptions left.
- **A cancelled job stayed on screen until the page was refreshed**, reading as
  though the stop had not taken. The server had already dropped it; the app was
  holding the last snapshot on purpose, which is right for a *failure* — nobody
  asked for it, and that row carries the only account of it — and wrong for a
  stop someone requested. Failures still stay.
- **A maintenance error was reported at the top of the sidebar**, under the
  button that started the work, while the job it referred to was reported at the
  bottom with the transfer indicator. It now sits with the job rows: the message
  outlives the button, since a storyboard pass reports long after Update says it
  is done.
- **The Bundle Inspector docked beside a playing file is the shell's own.** It
  was already the same component, and behaved like a different pane: a narrower
  fixed width, its own border and background, a shorter right-click menu, and
  tag edits that finished with no sign they had. It was not forked but starved —
  the shell passed eleven handlers, the viewer passed a bundle id, so every
  action gated on one of them had nothing to render from. Those handlers are no
  longer props restated at two call sites; they are one object the shell
  provides and the inspector reads wherever it appears, so an action added later
  reaches both surfaces at once. The rail also takes its width from the same
  variable as the shell's, so resizing one resizes both. Four actions genuinely
  mean something different inside an open viewer and are resolved rather than
  dropped: Play steps within the playlist instead of stacking a second viewer;
  Locate, Add files and Filter by tag close the viewer first, because they take
  you somewhere in the shell; and transient messages route to the viewer's own
  notice anchor, which sits above it. Right-clicking inside the rail no longer
  opens the playback menu on top of the menu you asked for. When the rail is
  open, the viewer's three top-right buttons now stay inset on the media side
  instead of sitting over the inspector.
- **A bundle filed into a collection is there when you open it.** The count
  moved immediately and the contents did not: opening the collection rendered
  its cached listing — without the bundle — until a refetch came back, so the
  number beside the name disagreed with what was under it, and a collection that
  had been empty showed nothing at all. Only collections you had already visited
  were affected, which is why it looked intermittent. The optimistic projection
  already pulled moved bundles out of the listings they left; it now also puts
  them into the ones they join, following the same subtree rule as the counts —
  a listing showing subcollection contents gains a bundle filed into a child,
  the same collection showing only its own does not. Filtered and searched
  listings are left to the refetch rather than guessed at. The collection
  picker's checkbox now projects the same way a drop does.
- **Collection covers appear when there is one, and change when it does.** Two
  faults, both ending in a folder glyph. The card remembered a failed cover
  image forever, so the 404 every collection answers before its thumbnail exists
  — or while it has no bundles — pinned the glyph in place through bundles being
  filed in and through a cover being chosen. And the server never changed the
  URL: a collection's auto-picked cover is derived from its membership, but
  filing a bundle in touched no collection row, so the cache key stayed
  identical and the browser kept serving what it had. Both sides of a move, and
  their parent collections, now get a fresh key.
- **Collection cover art fills the folder card.** The cover slot could collapse
  to the height of the metadata footer even while the card stayed wide, leaving
  only a shallow strip of artwork. Its width is now explicit and it cannot
  flex-shrink, so the 16:10 cover frame stays visible at the card's full width.
- **Empty bundle notes start at one line.** The note editor now begins with a
  single-row box instead of the browser's default multi-row textarea. Its CSS
  minimum is 34 px rather than the former 44 px, with one line's padding; the
  existing auto-grow still expands the box when the text wraps or overflows.
  The earlier saved height preference is reset, so notes already held open by a
  stale fixed size adopt the compact default too; new explicit resizes persist.
  Stacked note boxes now sit 4 px apart instead of 6 px.
- **Collection pills in the Bundle Inspector now open their collection.** The
  name side navigates to that collection without changing bundle membership;
  the × remains a separate removal action. From the docked player inspector,
  navigation closes the viewer first so the destination is visible.
- **The bundled desktop no longer strands its first library queries or mounts
  an unavailable library.** Cold starts hold at registry-availability and
  ownership checks, then mount the workspace once.
  The Tauri development root also skips React StrictMode replay: TanStack Query
  correctly aborted the replayed first request burst, but WKWebView could strand
  its immediate replacements at “Loading library…” until navigation issued a
  fresh query. Browser development stays under StrictMode, so the shared
  frontend keeps those checks without making `just bundled` unreliable. If a
  remembered library is offline, the app now opens another available library;
  if none is available, it shows Retry and Manage Libraries without issuing
  ownership, authorization, or content requests against the offline row. A
  foreground-only five-second probe also recovers automatically when its drive
  or network share returns, and the recovery screen does not expose the raw
  registry id or path.
- **Stopping `just dev` no longer strands a library ownership lease.** Its
  Ctrl-C trap killed the whole process group, including Uvicorn's reloader and
  worker at once, so FastAPI did not always reach the lifespan shutdown that
  marks mounted libraries released. The next bundled desktop then treated the
  dead source server as a fresh foreign owner, waited five minutes for the lease
  to become stale, and still required the normal confirmed takeover. The recipe
  now signals only its two direct children and waits for Uvicorn to release the
  lease before returning; a scratch-library smoke test covers the full command.
- **Files now locate their counterpart in either browser.** Selecting a file
  inside an open bundle offers **Locate in File Browser**, which opens its
  physical directory and highlights it. Selecting an indexed, bundled file in
  File Browser offers **Locate in Bundle Browser** in both its inspector and
  right-click menu, which opens its one owning bundle. Both are ordinary
  Cairndex navigation and work in the web build;
  **Open in Default App** and **Reveal in Finder** remain desktop-only. The File
  Browser menu starts with its desktop Open/Reveal section, followed by write
  actions when enabled, and finishes with separate **Copy Path** and
  **Save Contact Sheet…** sections when that video export is available. The
  matching in-bundle file menu now follows the same native, write,
  bundle-navigation, and export grouping.
- **Setting a cover frame for a video no longer re-covers the whole bundle.**
  Choosing a nicer frame for one video also made that video represent the
  bundle. Which member speaks for the bundle stays the separate, explicit choice
  it already had an affordance for — the star beside each row in the inspector's
  file list. The two compose: set a frame, then star the file. The viewer's menu
  now says "Set Frame as Video Cover". Its cover actions lead their section, and
  the redundant Frame Back/Forward context-menu rows are gone.
- **Collection counts now move with the drop.** Dragging a bundle into a
  collection left every number beside the collections on its old value until a
  refetch came back — plainly visible on a library whose database lives on a
  network share. The counts are now worked out on the spot from the collection
  tree the app already holds: the collections counting a bundle are each of its
  memberships plus every ancestor, so filing into a subcollection raises the
  child and its parents while a move between a parent and its own child leaves
  the shared ancestors alone — the case a naive ±1 would have got wrong, and the
  reason this was left waiting for the server. The same applies to the collection
  picker, to Uncategorized and Untagged, and to tag counts in the tag picker. The
  server's answer still reconciles it, and a rejected write puts every number
  back.
- **Nesting one collection inside another left the counts on the old tree.**
  Dropping a collection into another changes what every collection above it — on
  both sides of the move — counts, and nothing was refreshing those numbers, so
  they sat wrong until something unrelated happened to refetch them.
- **The collection inspector's own figures never refreshed.** "Bundles (here)",
  "Bundles (total)" and "Subcollections" came from a query nothing in the app
  invalidated: filing a bundle into that collection, deleting one, adding a
  subcollection, or running a scan all left the pane showing whatever it had said
  when it opened. They now move with the sidebar's count, immediately for a
  membership change and on a refetch for everything else.
- **A library served from the container stopped opening from any machine using a
  network share.** Opening it returned HTTP 500 with a traceback ending at a
  SQLite pragma, on a library whose files read fine and whose folder was
  writable. Cairndex was setting `journal_mode=WAL` on every database
  connection, believing it a per-connection setting; it is not — WAL is recorded
  in the database *file header* and travels with the library folder. A WAL
  database cannot be opened over SMB or NFS **at all**, not even read-only,
  because WAL needs a shared-memory index that network filesystems cannot
  provide. Setting the pragma from a machine on the share had always failed
  silently, so nothing looked wrong; the first server with local access to the
  storage flipped the file for good, and only a machine with local access could
  flip it back.

  **A library now uses WAL while a server has it open and a rollback journal at
  rest**, so a closed library is a single portable file that opens anywhere
  (ADR-0021). A library on a filesystem that cannot host WAL is never put into
  it, and the server checks what SQLite actually did rather than assuming the
  pragma worked. The server's own `registry.db` keeps WAL: it never leaves the
  server's disk.

  **One case still needs care.** An *unclean* stop — `docker kill`, a power cut,
  the OOM killer — never reaches the conversion and leaves the library in WAL, so
  stop containers with `docker stop`. Nothing is lost when it happens: no data is
  at risk, and restarting the server that crashed and stopping it cleanly
  converts the library back. If one is locked out, the error now says so — HTTP
  409 `library_database_unopenable`, distinguishing a journal-mode problem from a
  permissions one and carrying the command that fixes it, where before it was a
  bare 500. `docs/deployment.md` has the full procedure.

  **Creating a library was its own version of the same bug**, caught deploying
  this fix against a real container rather than only the test suite: a fresh
  `POST /libraries/create` followed by nothing but a clean `docker compose
  stop` still left the file in WAL. Creating a library bootstraps its schema
  through a one-shot database connection that the shutdown path never knew
  about, so a library nobody had opened yet was orphaned in WAL by a shutdown
  that was, in every other respect, clean. Every one-shot open of a library
  database — creation, and each of the offline `devtools` maintenance
  scripts — now converts back on its own before disposing its connection.

- **The scan progress bar never moved.** Clicking Update showed "Scan" and a bar
  that said nothing about what was happening or how far along it was. Two causes,
  both in the reporting rather than the work: a phase change could not clear the
  previous phase's total, so a finished discovery pass left its count frozen on
  screen through the phases after it; and progress was only reported every 200
  files, so any library smaller than that reported nothing at all until the scan
  was already over. **Progress now moves on any library size and names what it is
  doing** — "Discovering files", "Reconciling moves", "Generating thumbnails" —
  with a count when the work has one.

### Security

- **Automated dependency and static security review now covers the public
  repository.** Dependabot checks GitHub Actions, Python, both npm projects,
  Cargo, and Docker weekly; pull requests reject newly introduced high-severity
  vulnerable dependencies; and CodeQL analyzes Python and JavaScript/TypeScript
  on changes and weekly. Private vulnerability reporting is documented with an
  explicit prohibition on uploading real owner data to an issue or report.

- **Docker builds now prove private local state stays outside every image.** The
  build gate seeds synthetic canaries into runtime database, environment,
  virtualenv, dependency, and sidecar packaging paths; builds both development
  images and the production image; rejects an unexpectedly large context; and
  inspects all three images for leaks. The ignore rules now cover nested local
  environments, databases, virtualenv variants, and generated sidecar bundles.

- **Publication now has a mandatory pre-push privacy gate.** The canonical agent
  instructions require an object-level audit of every ref before a first public push,
  history rewrite, or pull request; detect binary types without trusting filenames;
  inspect Docker contexts and images; and use only visually reviewed synthetic data in
  screenshots and fixtures. A historical private screenshot stored under an
  extensionless flag-like filename was removed from all controllable local history and
  garbage-collected. The existing public GitHub pull-request refs remain a separate
  remote-remediation problem until GitHub Support purges them or the repository is
  recreated.

### Internal

- **Release versions can no longer drift between the tag and the artifact.** A
  root `VERSION` is checked against the server, web, desktop, npm lock, Cargo
  lock, and Tauri metadata in CI. Tag-triggered desktop and container workflows
  also require the tag to match, and the desktop workflow validates both the
  version and changelog on Linux before spending macOS build minutes. Existing
  metadata is synchronized at the already-current `0.1.1` baseline; the next
  release number remains an owner decision.

- **Container smoke tests no longer reuse a stale image by accident.** Running
  the smoke script without an argument always builds a commit-specific image and
  removes it afterward. An explicit image tag is the only reuse path. GHCR
  publication now tags and tests the candidate once, verifies every final tag has
  that tested image ID, and pushes those bytes without a post-test rebuild.

- **Browser tests for the grouping dialog's folder rows.** Both layout faults
  the owner found were invisible to the unit suite by construction — jsdom
  applies no stylesheet, so `vitest` renders the same markup and sees nothing
  wrong. Four Playwright tests now cover the class: sibling rows share one
  indent, the attention bar is not clipped off a top-level row, a folder row
  sits above the files it covers and its files are indented under it, and
  looking inside a folder decides nothing.

  Asserted as relationships (these rows share an x; this row is above those)
  rather than pixel values, so restyling does not break them. Each was
  mutation-checked against the bug it exists for: reverting a fix fails its test
  and only its test.

- **A bundle may record that one of its directories is a single member** — the
  storage and the two operations behind plan 6, with no UI yet, so nothing
  user-visible changes. A new `bundle_directory_members` table names which
  directories stand in for their files, and three library-scoped endpoints under
  `/bundles/{id}/directory-members` list, collapse and expand them. Metadata-only
  and outside the write-mode gate: nothing on disk is touched.

  The table stores **no contents**. Membership stays on `asset_files.bundle_id`
  and which files a folder covers is derived from the existing
  `directory_path` index, so collapsing is one row inserted, expanding is one row
  deleted, and neither can lose a file row, an id, a rating or a resume position.
  Reversibility therefore needs no undo journal — which was the question the plan
  called the one most worth designing up front.

  The subtree match is a key range rather than a `LIKE`, so it always uses the
  index and a folder whose real name contains `%` or `_` cannot widen it.

- **`cairndex.devtools.benchmark_storyboards`** generates fixtures of known GOP
  length with ffmpeg and times each sampling mode over them, reporting wall
  clock, tiles, cues and sheet bytes. The numbers above come from it and are
  recorded in `docs/performance.md`.
- **The sheet count is now asserted, not assumed.** Sampling at irregular
  intervals made the image muxer's default rate sync duplicate sheets to fill a
  constant frame rate — 300 files for 30 tiles in the benchmark — which would
  have pointed every cue past the first sheet at a copy of it. Generation pins
  the sync mode, and a test fails if a pass writes more sheets than its tiles
  fill.

## [0.1.1] — 2026-07-30

### Fixed

- **The grouping review dialog stalled on a large library.** Every read of a plan
  fetched its suggestions' files one suggestion at a time — a query per row, so a
  library with thousands of suggestions made thousands of round trips for a single
  conversion, and opening the dialog loaded every proposal of every plan ever
  generated just to show how many each holds. Measured on a 3,000-file library:
  splitting a folder into a collection went from 0.70 s to **0.06 s**, collapsing
  one back from about 1.0 s to **0.47 s**, and the dialog's opening request from
  reading every proposal to **3 ms**. The saving is in round trips rather than
  arithmetic, so it should matter most for a library on network storage, where each
  round trip costs far more than it does on a local disk.
- **A file showed one name in the File Browser and another inside its bundle.**
  The bundle's file list, the inspector and the viewer render a *stored copy* of
  the filename, and the copy could drift: three separate code paths move a file's
  path — a rename Cairndex performs, a rename it discovers during a scan, and a
  missing file repaired by hand — and each one that forgot to update the copy left
  the file under its old name. **A bundle now shows the file's current filename**,
  derived rather than stored, so no path can leave it behind and files that were
  already showing a stale name are correct immediately — no scan, no repair step.
  The three paths keep the stored copy in step as well, since search reads it, and
  the name a file arrived under is still recorded separately, unchanged.
- **Dropping files onto a bundle copied them into the library root.** They were
  linked into the bundle correctly but filed nowhere near its own files, leaving
  a manual move to put right. A drop now asks where to put them, opening in the
  folder the bundle's first file lives in — the answer nearly every time, with
  any other folder one click away.
- **Double-clicking an image zoomed instead of closing the viewer.** Double-click
  closes the viewer, as it already did for video; on an image it cycled the fit
  and stayed open, because panning captures the pointer and that redirects the
  double-click away from the picture. Cycling fit moved to the zoom readout,
  which is now a button. The same capture was also swallowing clicks on the
  image background toggle, so that button did nothing at all — fixed with it.
- **Viewer messages appeared in two different places.** "Building contact
  sheet…" sat 64px above where "Resumed at …" sits, in a different shape, so two
  messages about the same playback looked unrelated. They now share one anchor
  and one frame, and stack when both are up.
- **A rename box could select the file's extension.** The extension is left out
  of the selection, since renaming a file almost never means retyping its type —
  but asserting that once, as the box opened, was not enough in the desktop
  shell, whose engine can apply its own double-click selection afterwards. It is
  now re-asserted on the next frame.
- **Turning a single-item bundle into a collection nested forever.** It produced
  a collection wrapping one identical bundle — and because that child was itself
  convertible, each click added another layer of collections with the same name
  and nothing inside them. A folder holding one video is one subject however many
  covers or subtitles sit beside it, so there is nothing to divide: the control
  is no longer offered on such a row, and the server refuses it. Dividing still
  works wherever it means something — two or more videos split per video with
  sidecars following their own, and an image-only bundle splits per file.
- **An "Add to …" suggestion sat outside the collection it was joining.** A new
  file in `Studios/StudioAlpha/` showed up under *Studios*, beside that
  collection rather than inside it — reading as unrelated to the very bundle it
  adds to. Two causes, both fixed: an addition was pinned to the top level
  regardless of where its files live, and the collection its target bundle
  actually belongs to was being ignored whenever the folder happened to suggest
  somewhere else. An addition now surfaces where the bundle it joins already
  lives, falling back to its own folder when that bundle is in no collection.
- **A tooltip could stay on screen after its button was clicked.** Clicking is
  what moves the row, and since nothing makes the pointer *leave* the button, no
  hover-out ever fires — so the tooltip hung there at its old position, showing
  the new label. It is now dismissed on click, and a position computed for a label
  that has since changed is never shown.
- **Tooltips were clipped by the panel edge.** The controls' tooltips are the
  longest text in the dialog and the dialog body scrolls, so an absolutely
  positioned tooltip got cut off. They now render outside the panel and clamp
  themselves into the viewport — and a disabled Narrow/Widen still explains
  itself, which is exactly when you want it to.
- **A merged collection could lose its files.** Merging a collection whose
  bundles live in subfolders leaves one bundle whose folder is the *parent* — a
  folder with no media of its own. That row was offered Narrow/Widen anyway, and
  using it deleted the row while the suggester had nothing to put back, so both
  files dropped out of the plan silently and could no longer be bundled. The
  control is no longer offered on a row whose files span more than one folder
  (it could not have narrowed or widened anything there), and the server now
  refuses any stem change that would drop a file rather than performing it.
  This also fixes the reported symptom: such a row kept its Narrow/Widen buttons
  after being turned back into a collection.
- **Narrow and Widen no longer discard your review work.** They used to
  regenerate the whole plan server-side — new rows, new ids — so adjusting one
  folder reset every checkbox and every edit everywhere. They now re-suggest
  **only that folder, in place**: every suggestion outside it keeps its
  identity, so your selections, renames, destination switches, drag edits, and
  bundle↔collection conversions all survive an adjustment to some other folder.
  The adjusted folder itself comes back as fresh (checked) suggestions, which is
  what asking to re-group it means. Selection is additionally tracked by what a
  suggestion *contains* rather than by its row id, as a second line of defense.

  An explicit **Suggest grouping** still starts from a clean slate — that is
  a fresh start rather than an adjustment.

- **The Docker development stack was not usable.** Its image had no
  `ffmpeg`/`ffprobe`, so the server started and then failed at the first scan —
  probing, thumbnails, storyboards, subtitle conversion, and playback all shell
  out to them. It also mounted no library, so there was nothing to point the app
  at, and kept no data volume, so registered libraries were lost on every
  rebuild. All three are fixed, and the stack is now verified working end to end:
  scan, cover generation, backend reload, and browser hot-module reload.
- **The production container's startup claimed to apply database migrations and
  did not.** The entrypoint ran `alembic upgrade head` against an empty
  migrations directory — exit 0, no effect, and a log line saying migrations had
  been applied. Cairndex has no migration chain: the registry DB is bootstrapped
  on first open and each library's schema is patched additively when it opens.
  Upgrading is still just starting the new image; the startup line no longer
  suggests a step that does not exist.

### Added

- **Cairndex is published as a container image**, so deploying it no longer
  means putting the source on the server. `ghcr.io/allpan3/cairndex` is built
  and pushed by a workflow on a version tag (or a deliberate manual run — never
  automatically from `main`), and the new `deploy/` directory holds the two
  file a NAS needs. Every setting in `deploy/docker-compose.yml` carries a
  working default, so it needs no `.env` beside it and can be pasted straight
  into a NAS Docker UI's Project / Stack / Compose section — which is how most
  of these boxes are administered, and a compose file that only works beside an
  env file is one that only works from a shell. Updating is
  `docker compose pull && up -d`, with no migration step. `deploy/README.md` is
  the runbook — both install paths, permissions, updating, stopping, backups,
  and the two refusals that look like failures but are not. Building from source
  still works and is documented as the way to run an unreleased branch.

  **Mounts are named for what they hold.** The container path is `/libraries`,
  with one mount per share beneath it (`/libraries/main`, `/libraries/archive`),
  replacing the single `/storage/media` — which named the wrong thing twice
  over: a mount holds *libraries*, not "media", and it holds as many as you
  care to make. Nothing in the server or the web app referred to the old path;
  it was a deployment convention throughout, and the host-side variable is now
  `CAIRNDEX_LIBRARY_PATH` to match.

  The shape matters more than the spelling. **A mount is a share, not a
  library**: one mount can hold any number of libraries, created live in the
  app with no compose change and no restart, and you edit the compose file only
  when files sit somewhere the container cannot see at all. Mounting each share
  as a *child* of `/libraries` is what makes that cheap — adding a second share
  later never moves the first, and moving one would orphan every library
  registered inside it, since the registry records the path the container saw.
  The startup preflight follows: it now warns when nothing is mounted at all
  (the first-run mistake) and checks each mount separately.

  **If you ran an earlier build of this, re-register your libraries.** A server
  records each library under the path *it* saw, so one registered at
  `/storage/media` reads as "currently unavailable" once the mount moves — the
  library package itself is untouched and re-registering at the new path
  restores it, along with everything it knows. The containerized dev stack keeps
  its registry in a volume that survives rebuilds, so it is affected too:
  re-register, or `just docker-dev-down --volumes` to start its registry over.

  **And you do not have to hand your directories to uid 10001.** The image runs
  correctly as any uid, so `user: "1000:1000"` in the compose file lets the app
  write as the machine's owner instead — no `chown` anywhere, and what Cairndex
  creates stays readable to that owner's own backups. This holds because the app
  writes only to `/data`, `/tmp` and the library mounts, all supplied from
  outside; `smoke.sh` now starts the image under a foreign uid and creates a
  library through it, so the property is tested rather than assumed. `/data`
  must be a bind mount to use it — a named volume takes its ownership from the
  image.

  **The image is smoke-tested before it is pushed, not after.** It is built to
  the runner's local daemon, put through the same `infra/docker/smoke.sh` that
  CI runs, and only then pushed — the second build reuses the layer cache, so
  the gate costs seconds. Publishing first would leave a broken image pullable
  in the gap, with `:latest` already moved.
- **Turn a suggested bundle into a collection, and back.** The suggester decides
  from filenames alone whether a folder holds one thing or several, and it gets
  it wrong in a way Narrow could not fix: a folder whose files carry explicit
  part markers reads as a single bundle at *every* stem sensitivity, so there
  was no way to say "this folder is a collection". Each suggestion now carries a
  compact split/merge icon button (tooltip: *Make this a collection of bundles
  instead* / *Make this one bundle instead*), matching the destination toggle
  beside it.

  Converting to a collection splits the folder into one bundle per video, with
  each cover and subtitle following its own video rather than becoming a bundle
  of its own. Converting back merges everything under the collection into one
  bundle again, so the override is reversible rather than a one-way door. A
  suggestion that adds files to an already-confirmed bundle cannot be converted,
  since its files join a bundle that is not going to become a collection.

- **The production image is now smoke-tested, not just built.**
  `infra/docker/smoke.sh` (`just docker-smoke`, and a new CI step) starts the
  image against a throwaway library and exercises what actually rots: startup
  under the read-only root filesystem, the non-root user writing its volumes,
  ffprobe and ffmpeg during a real scan, and a graceful shutdown releasing the
  library's ownership lease. The two bugs above lived behind a green
  build-only CI job for a month.
- **A startup preflight on the production container.** It refuses to start when
  the app-data dir is not writable by its non-root uid — the most common NAS
  misconfiguration, and one that otherwise surfaces much later as an opaque
  SQLite error — and warns, without refusing, when the library mount is
  read-only, since browse-only is a legitimate deployment.
- **`just docker-dev`, `docker-dev-down`, `docker-dev-library`, `docker-prod`,
  `docker-build-nas`, and `docker-smoke`.** `docker-build-nas` cross-builds the
  amd64 deployment image from an Apple Silicon Mac. `docker-dev-library` seeds a
  scratch library from generated media — a multi-part film with cover and
  subtitles, an episodic set, loose images and a loose clip — so bundling,
  grouping, covers, and playback all have something real to work on. It uses
  ffmpeg from a container, so no local ffmpeg is required.

### Changed

- **A grouped bundle is named by the part its files share**, not by whichever
  file came first. Four files matched on a common prefix were titled
  "StudioAlpha.19.12.20.Lead.Player.#2.Session.Behind.The.Scenes" — one
  member's name, implying the other three were behind-the-scenes clips. They now
  read "StudioAlpha.19.12", the shared part that actually grouped them,
  trimmed so it never ends mid-word. A multipart video gains from the same rule:
  "Trip.part1" becomes "Trip". A bundle filling its own folder still takes the
  folder's name, and a single subject still its own filename.
- **Double-clicking a name puts the caret where you clicked**, instead of
  selecting the whole title. These names are long and mostly right, so the usual
  edit is a tweak in the middle of one — and a select-all threw the name away the
  moment you typed. Keyboard entry (Enter/F2) lands at the end.
- **A single-subject bundle can become a collection again.** Refusing it outright
  left rows with no way to become one at all; you may simply be making a home for
  siblings to drag in. What is still refused is a single subject that already sits
  in a collection for its own folder, where another layer would only repeat the
  name it is inside — and since the child of a conversion always lands exactly
  there, that is what keeps the nesting bounded.
- **The bundle icon is no longer a film clapper.** A bundle is whatever its files
  are — photos, audio, documents — and the clapper read as a claim that it is a
  video. Bundles now use stacked sheets and collections an outlined folder, both
  drawn like the rest of the app's icons rather than as emoji. The addition rows
  drop their clapper too: "Add to <bundle>", since the row already shows an icon.
- **Row alignment is now exact rather than nearly right.** The checkbox, kind icon
  and title share one centre line, a bundle's files indent to the first character
  of its title, and the conversion/Narrow/Widen buttons sit on the title's line —
  all measured at 0px offset instead of tuned by eye. The leading controls have
  fixed sizes so a platform-default checkbox width cannot shift any of it.
- **The ⠿ drag handles are gone.** Every bundle and file row is draggable in its
  entirety — the file rows already were, which made their handle pure decoration
  taking horizontal space on every line. The rows carry a grab cursor instead,
  and a row being renamed is not draggable, so text selection in the edit box
  still works.
- **The suggestion panel is wider** (1100px, was 780px) and its rows no longer
  misalign when a long name wraps — the checkbox, drag handle and kind glyph
  stayed vertically centred against the taller row, drifting away from the title
  they belong to; they now sit on its first line.
- **Narrow/Widen tooltips say what they do to which folder** — "Folder Trip
  (matching: balanced) — split into more bundles by matching more of each
  filename". The pair belongs to a *folder*, and is attached to whichever row
  speaks for that folder, which is a collection row sometimes and a bundle row
  other times; the old "stem matching" wording made that read as two unrelated
  controls.
- The review dialog drops two pieces of noise: single-file suggestions no longer
  say "single file on its own" (the row already shows exactly that), and
  converted rows no longer explain that you converted them.
- Narrow/Widen are compact icon buttons too — inward chevrons narrow, outward
  widen — matching the destination and conversion toggles instead of dominating
  every folder row with text buttons. The current mode is named in the tooltip
  rather than printed between them.
- **The dialog's intro is three short lines instead of a paragraph.** It had
  grown to document every affordance in the dialog, above the thing you opened it
  to read; each control now carries its own tooltip.
- **Collection rows no longer carry a reason.** Three code paths had each grown
  their own phrasing for the same fact ("holds 2 sub-item(s)", "3 unrelated
  files", "2 filename-matched bundle(s) from 4 files"), so identical rows read
  differently depending on which produced them — and the row already shows the
  bundles it holds. Bundle reasons stay, since "3 parts of one video" says
  something the row does not.
- **File rows show the media kind, not the suggester's guessed role.** They were
  labelled `video part`, `alt version`, `cover`, `derivative` — guesses from
  filenames that are neither reliable nor editable, so the label invited a guess
  to be read as a fact. The rest of the app settled this already; the review
  dialog now speaks the same vocabulary (video / image / subtitle).

- **Ratings now go in half stars.** The scale is 0–5 in 0.5 steps everywhere it
  appears: the inspector, the multi-select batch bar, the toolbar Rating filter,
  and the Smart Collection editor. Each star is two click targets — the left half
  picks `n − ½`, the right half picks `n` — and clicking the current value still
  clears the rating.

  **Nothing you already rated or saved changed meaning.** A rating is stored as a
  number of stars rather than a count of half-star units, so every whole-star
  rating in an existing library still reads as itself, and every saved Smart
  Collection keeps selecting what it selected — `rating >= 4` is still four stars
  and up. No migration runs, and libraries move freely between this version and
  the previous one.

  The controls also grew up (owner feedback): the stars are larger with tighter
  spacing, so each half is a real target; **press and drag across the row** to
  sweep to a rating, committing on release; and a small text hint names the
  value ("3½ stars") while hovering or dragging, so you never have to count
  filled halves. A drag always sets the value it ends on — only a click on the
  current value clears.

  Two smaller visible effects: the rating filter's per-star count now follows
  whichever half is under the pointer, so it always answers "how many would
  clicking here match?", and the inspector's empty stars are muted solid rather
  than hollow outlines, matching the filter popover. The facets API gained half
  keys (`"3.5"`); whole stars keep the key they had (`"4"`, never `"4.0"`).

- **Both stacks are configured from one `.env`** (`.env.example` covers both).
  The dev stack reads separate `CAIRNDEX_DEV_*` keys — library path, ports, and
  machine name — so configuring one stack never silently reconfigures the other,
  and so the dev stack can run alongside a native `just dev` on other ports
  rather than instead of it.
- **The production stack identifies itself properly.** `CAIRNDEX_MACHINE_NAME`
  and `CAIRNDEX_ADVERTISED_URL` are wired into the compose file; without the
  first, a library's ownership lease recorded the container's hex id, so another
  machine could only report "served by 79cd6c7e81a3". It also gained a
  `stop_grace_period` above Docker's 10s default (shutdown releases leases and
  checkpoints WALs, and a SIGKILL part-way through strands the lease until it
  ages out), a compose-level healthcheck, and bounded log rotation.
- The dev backend reloads on `src` only. A bare `--reload` watched the entire
  bind-mount, including `.venv` and `var/`.

### Internal

- `cairndex.domain.rating` is the one definition of the rating scale — range,
  step, and facet-key format — shared by the ORM model, the write schemas, the
  bundle service, and the facet builder. `apps/web/src/app/rating.ts` mirrors it
  on the client. `tests/test_rating_scale.py` pins the compatibility premise
  against the pre-half-star column shape (declared `INTEGER`, with the range
  CHECK that SQLite cannot alter in place).
- The inspector's star editor moved out of `Inspector.tsx` into `Stars.tsx`, so
  the half-star geometry exists once instead of in two components.

## [0.1.0] — 2026-07-28

First public release: a macOS desktop app, and the server and web client behind
it. Everything below landed before the tag, so this section is the whole history
rather than a delta — later releases will be short.

**What it is.** Cairndex indexes a folder of media you already own and keeps its
own records beside it. It never renames, moves, or deletes anything unless you
turn write mode on for that library, and even then every operation is journaled
and undoable. Bundles group the files that belong together; collections and tags
organize the bundles.

**Highlights.**

- A real video player — direct play, remux, or HLS transcode chosen per client
  from what that client can actually decode — with storyboard scrubbing,
  chapters, subtitle tracks, frame stepping, and resume.
- An image viewer with generated previews, so HEIC and TIFF open like anything
  else.
- A File Browser over the library root alongside the bundle view, sharing one
  media viewer and one file inspector.
- Optional **write mode**: rename, move, trash, and drag files in from Finder,
  all journaled, with a trash you can restore from.
- **Contact sheets** — a grid of frames from a video, saved wherever you can see
  one.
- The desktop app runs its own bundled server, so a local folder opens without
  administering anything.

**Known limits.** Apple Silicon only for the packaged app (Intel stays pinned
and locally buildable). The app is signed ad-hoc rather than with a Developer ID,
so the first launch has to be approved once through **System Settings → Privacy
& Security → Open Anyway** — see the README's install section for the exact
steps, including that it repeats after each update until the updater lands. One
library is served by one machine at a time, enforced by a lease.

### Added

- **Sibling filenames collapse what they share.** Long names in the bundle
  inspector used to truncate at the end — where sibling files differ — so
  `…Part1.mp4` and `…Part2.mp4` looked identical. The shared stem now dims and
  gives up its width first; the distinct tail keeps its full text and
  brightness. Per-name, so one unrelated `poster.jpg` doesn't stop its siblings
  from collapsing.

- **A menu on a tag pill** — filter the library by that tag, rename, copy, paste
  onto another bundle, or remove it from this one. **Shift-Cmd-C** copies the
  selected bundle's tags and **Shift-Cmd-V** pastes them onto the selection, as a
  union: pasting adds, it never strips.

- **Save a contact sheet from anywhere a video is** — the File Browser, a
  bundle's album grid, and the bundle inspector's file list, not just the open
  player. A dialog asks for the grid (4×4, 5×5, 6×6) and the width (1600, 2048,
  2560) together, and says what the two add up to: the cell size, which is what
  actually decides whether a frame is legible. The black header now prints three
  compact rows: File Name; Details with size · duration · resolution / frame
  rate; and Codec with video codec / bitrate · audio codec / bitrate / sample
  rate. A larger blue-accented **EXPORTED FROM CAIRNDEX** brand lockup anchors
  the right side. Probe metadata now keeps the primary video and audio stream
  bitrates separately, plus the primary audio sample rate; the normal metadata
  job refreshes older rows once under probe format v5. Every cell is labelled
  with the instant it was taken from. Generation reports progress through the
  same toast as file operations, which holds while the work is in flight.

- **The in-bundle view works like the File Browser.** It switches between grid
  and list with the same control and the same rows, and selecting one file puts
  that file's details in the rail — the same inspector the File Browser drives,
  including the **Path**, which is worth reading here because a bundle's files
  can come from anywhere. Both surfaces also share one right-click menu, so the
  same file offers the same actions wherever you click it.

- **A bundle-inspector rail in the viewer.** The `i` button shows the media's own
  information — type, size, dimensions, duration, subtitles, and the playlist.
  Beside it, a sidebar toggle docks the same bundle inspector the main shell
  uses, so rating, notes, tags and collections are editable without leaving the
  video. Two panels on two toggles; both can be open at once, and the stage
  gives up width rather than sitting underneath.

- **`just release`.** Runs the desktop shell as it ships — optimized Rust and a
  minified web build. `just bundled` and `just desktop` both go through
  `tauri dev`, which serves the web app from Vite: React's development build,
  every module unbundled, and StrictMode rendering each component twice. Fine
  for exercising behaviour, misleading for judging speed.

- **Contact sheets.** Right-click a playing video → **Save Contact Sheet**: a
  metadata header (title, size, duration, resolution) above a 4×4 grid of frames
  sampled evenly across the video, saved as one JPEG through the export
  destination. The server cuts the frame grid with ffmpeg and caches it like
  every other derived asset; the header is drawn client-side, where text
  rendering needs no font configuration. Needs the file probed (Collect
  metadata) and indexed; the first slice of the plan-1 §10 export family.

- **A Random view.** Every bundle in a seeded shuffle, for browsing by
  serendipity. The toolbar's sort control becomes a **Shuffle** button there —
  explicit sorting would un-shuffle the one thing the view is for — and manual
  reordering is disabled so a shuffled display can never rewrite an order you
  arranged on purpose. The arrangement is stable while you scroll and page;
  Shuffle (or a new session) deals a new one.

- **Back / Forward navigation.** A compact pair at the left of the top bar, on
  both the Bundles and Files surfaces, stepping through recently visited
  places — views, collections, open bundles, and File Browser folders.

- **Files can be removed or deleted from inside a bundle.** The bundle album's
  right-click menu gains **Remove from Bundle** (metadata-only; the file falls
  back into Unbundled) and, with write mode on, **Move to Trash** — the same
  journaled, recoverable deletion the File Browser offers.

- **Dropping a file onto a bundle card adds it to that bundle** (write mode).
  The file is imported into the library (journaled, keep-both on name
  collisions) and linked into the bundle; the card highlights while a drag
  hovers it.

- **Creating a nested tag: type `/`.** `genre/noir` creates (or reuses) each
  segment under the previous one and assigns the leaf — in both the bundle tag
  editor and the multi-bundle inspector.

### Changed

- **File rows say everything true about the file.** The line under a file's
  name used to pick one fact — dimensions, or duration, or size, never two of
  them — so a video's row could not say how long it was and how large at once.
  It now reads like `video · 3.8 GB · 1080p · 33:48`, and images include their
  size too. The row still leads with the file's role in the bundle (video,
  audio, subtitle) rather than its format — that slot is reserved for manually
  assigned roles later. Common resolutions go by their short names (8K, 4K, 2K,
  1080p, 720p); anything non-standard keeps its honest dimensions rather than
  being rounded to a name it does not have. The right-click menu on a bundle's file
  rows also gained "Reveal in Finder" and "Locate in File Browser" — the album
  grid already offered both for the same file; the rail simply was not passing
  them through.

- **A file's type is now its format, and encoding is on show.** Where a file
  used to describe itself as "video" — something the thumbnail already said —
  it now says MP4, MKV, PNG: the fact that decides whether it plays directly.
  The player's info panel and the file inspector also gained the encoding
  behind it — codec, bit depth and HDR where they are not the ordinary case,
  and bitrate — so when a file misbehaves, what it actually is can be read
  without leaving the app. Files with no usable extension still fall back to
  their media kind, and un-probed files simply omit the rows rather than
  showing a column of dashes.

- **The bundle inspector is available while media plays.** The viewer's side
  panel holds the real inspector — rating, notes, tags, collections, metadata,
  all editable — plus the playlist, with the current file marked and clickable.
  Whether it is open persists across files and sessions. Toggle with `i`, the
  topbar button, or the right-click menu.

- **A collection's description is reachable from the sidebar.** Opening a
  collection there now shows its inspector, so the description sits where a
  bundle's notes do rather than only appearing when you select a collection
  *card*.

- **The tag picker takes the keyboard.** Enter accepts the single match, or
  creates what you typed; either way the field clears and the picker stays open
  for the next one. Clicking away closes the picker without also clearing the
  bundle selection underneath it.

- **Right-click in the viewer opens Cairndex's own menu** — play/pause, frame
  steps, subtitles, loop, snapshot, contact sheet, set-frame-as-cover, info,
  fullscreen — instead of the browser's native video menu, whose entries drove
  the raw element the custom player exists to replace.

- **Player keys, remapped** (owner request): `,` / `.` step frames; `z` resets
  the speed to 1×, `x` slower, `c` faster; subtitles moved from `c` to `v`
  (mpv's binding). The speed slider shows a reset control while off 1×. The
  in-app shortcut reference follows.

- **Snapshots and exports have a configurable destination** (desktop). Settings
  → Exports: unset asks via the native save dialog every time; a chosen folder
  saves silently with keep-both naming. In the desktop shell the viewer's
  snapshot now saves through this path too.

### Fixed

- **The viewer no longer blames the network for a file it simply can't play.**
  Every video failure showed one card — "Playback interrupted… this can happen
  after seeking into a part that hasn't loaded yet" — with a Try again button,
  including for formats the player had refused outright, where every retry
  reproduces the same refusal. Those now get their own card that says the format
  is the problem, points at Collect metadata, and offers no button that cannot
  work. A genuinely interrupted read keeps its retry and says what actually
  happened. The cards also carry real icons per state instead of one crosshatch
  glyph for everything, and the glyph no longer gets read aloud ahead of the
  message.

- **Large videos that need converting now start almost immediately.** Preparing
  one meant finding its keyframes, and finding them meant reading the entire
  file — twenty seconds for a 4 GB video on a NAS, longer than the player waits
  before giving up, so the video never started at all. MP4 files already record
  where their keyframes are, in a few megabytes of index, and that index is what
  gets read now: the same answer in a twentieth of a second. Formats that keep
  no such index are read the old way, as before.

- **HEVC videos that refused to play in the desktop app.** MP4 labels its HEVC
  either `hvc1` or `hev1`, and AVFoundation — Safari, and so the desktop shell —
  plays only the first. Both labels normalized to plain `hevc`, and the browser
  reported HEVC as supported on the strength of `hvc1` alone, so an `hev1` file
  was handed straight to a video element that could not decode it: a "Playback
  interrupted" card that no retry could clear. The probe now records the label,
  the capability handshake reports the two separately, and an unplayable label
  routes to a remux that copies the streams and rewrites the label — seconds,
  not the full re-encode that fixing four bytes of metadata would otherwise
  cost. The same check reaches card hover previews, which fall back to the
  storyboard instead of a stalled video. Existing libraries re-probe themselves
  to pick up the label.

- **One layout control.** The toolbar's grid/justified/list now also drives the
  collections section (rows in list layout) and the in-bundle file view, which
  loses the private layout switch it briefly grew. The zoom slider reaches all
  of it too — tiles on the card ramp, rows on the row-height curve.

- **Pasted tags appear immediately.** The copy/paste chords are optimistic like
  the pill menu: toast and pills update at the keystroke, the network catches up
  behind. Filtering from a tag pill reveals the filter row instead of silently
  shrinking the library.

- **Tag and collection pills** no longer show a text cursor, and hover with a
  quiet glow. The copy/paste chords are desktop-only — in a browser tab,
  Shift-Cmd-C belongs to DevTools.

- **Renaming and deleting a tag work in the desktop app.** Both asked through
  `window.prompt` / `window.confirm`, which Tauri's webview does not implement —
  so the rename silently did nothing and the delete never asked. Every question
  the app needs to ask is now a rendered dialog.

- **Filtering from a tag pill uses the tag you clicked**, not every tag on the
  bundle.

- **A contact sheet's last slice was never sampled.** Each cell came from the
  leading edge of its slice, so the final one was skipped, and the edge trim was
  a flat 4% of the duration. On a one-hour video that hid the last 5.8 minutes
  entirely. Cells now come from the middle of their slice and the trim is capped
  at five seconds.

- **Deleting a parent tag works.** It was refused so the children could be moved
  first; it now asks how many tags and bundles the delete would touch, and takes
  the subtree once confirmed. A tag on nothing with no children skips the prompt.

- **The context menu closes wherever you click** — the sidebar included — and no
  longer clears the bundle selection on its way out.

- **Enter works in the collection picker**, which never had it wired, and both
  pickers now clear what was typed when they close instead of presenting a stale
  search next time.

- **The context submenu and the viewer's inspector rail had no background** —
  both asked for a CSS variable that does not exist, so the page showed through
  them.

- **The resume toast sits above the control bar** rather than 6px inside it.

- **Contact sheets no longer time out on long videos.** The 502 was the desktop
  shell's relay giving up, not a failure: sampling with `fps=1/n` decodes every
  frame between the first sample and the last, so the work scaled with the
  video's duration — 24s for a twelve-minute 4K file, and worse from there.
  Frames are now taken by seeking to each one, which costs the same whatever the
  video's length: the same file takes 2.1s, and one ten times longer takes about
  as long.

- **Double-click closes the viewer**, and Escape closes it whether or not it is
  fullscreen — it used to take two presses. `f` still leaves fullscreen and
  keeps playing.

- **The viewer's "next" arrow stays over the picture** instead of sitting on top
  of the docked inspector, and the resume toast moved down beside the seek bar it
  refers to.

- **Escape dismisses a tag or collection picker**, without also closing whatever
  is behind it. The active row is a filled pill rather than an outline, and the
  search box no longer highlights itself — it is focused the whole time the panel
  is open, so the accent border said nothing and competed with the row that does.

- **A collection's description sits under its title**, not below the bundle
  counts.

- **Seeking a large video no longer degrades as you go.** Holding an arrow key
  auto-repeats about thirty times a second, and each repeat wrote
  `video.currentTime` — aborting the in-flight byte range and opening a new one,
  which a 25 Mbps 4K source feels acutely. Relative seeks now accumulate and
  commit through the same throttle the drag path uses, so a held key covers the
  same distance while the element sees one seek per window.

- **The viewer stopped doing library-wide work on every frame.** The tag and
  collection pickers built their row trees — walking and sorting every tag and
  collection in the library — on every render, open or not, and playback
  re-renders the viewer several times a second. They build only while open now,
  and the inspector is memoized so a playback tick stops at its boundary.

- **The scrub preview tracks the pointer again.** The seek throttle deliberately
  lags the video and the storyboard tooltip is what covers for it, but the drag
  handler left it frozen wherever the press landed. The seek bar also re-read
  the track's geometry on every pointer move, forcing a layout of a document it
  had just restyled; it measures once per gesture now.

- **Contact sheets work in the desktop shell.** The route was missing from the
  media proxy's read-only allowlist, so the shell refused the request before the
  server saw it — which is why the browser worked, the shell returned 404, and
  restarting the sidecar never helped.

- **Clicking away closes a picker without clearing the selection.** Dismissal is
  handled in the capture phase now; stopping the click alone was too late,
  because marquee selection acts on mousedown and mouseup.

- **The tag picker shows what Enter will take** — the single match, an exact
  name, or the "create what I typed" row — decided once and marked from the same
  value, so the highlight cannot drift from the action.

- **Three file-serving routes no longer pin a database connection while
  streaming.** `/file`, `/file/preview` and a collection's `/thumbnail` still
  used the yield dependency that the streaming routes were moved off when
  drag-seek pool exhaustion was diagnosed. `/file` is how an unindexed File
  Browser video plays, so seeking one reproduced that bug in full.

- **Tagging is immediate again.** The chip now appears on click instead of after
  a round trip, and tagging no longer forces the whole grid to refetch — only
  Untagged membership depends on tags, so that refresh waits until the view is
  next shown.

- **Videos start faster.** The File Browser was asking for every row's thumbnail
  the moment a folder opened, saturating the browser's connections to the server
  so anything sharing them — a video starting, most visibly — queued behind frame
  extractions nobody was looking at. Thumbnails now load only once on screen.


- **Dropping a file anywhere but a drop target no longer replaces the app with
  the file.** In the desktop shell an OS drop lands as a plain browser drop, and
  any surface without a handler let the webview navigate to the dropped file
  with no way back. Every file drop is now intercepted; unhandled ones get a
  hint about where drops work.

- **The viewer title no longer sits under the macOS window controls** in the
  desktop shell; the topbar clears them the way the sidebar always has, by just
  enough, and not in fullscreen where the controls are hidden anyway.

- **The window can be dragged by the player's top bar again.** The viewer covers
  the whole window, so while media was open there was no grab area at all.

- **Dismissing the viewer's right-click menu no longer pauses the video** — the
  click that closed the menu was reaching the video underneath it.

### Added

- **File Browser and Unbundled show thumbnails.** Both surfaces rendered a
  media-kind icon for every row, so a folder of videos — or the whole Unbundled
  queue — was a wall of identical glyphs. They now show a still: an indexed file
  uses the per-file thumbnail the server extracts (a real frame, for video), and
  an image that was never indexed falls back to its path-scoped preview. Anything
  with no possible still — a subtitle, a folder, an unindexed video — keeps its
  icon, as does a file whose thumbnail the server cannot produce. Both the grid
  and the list get them; in the list they scale with the zoom slider.

### Added

- **Write mode — the gate** ([ADR-0013](docs/adr/0013-library-write-mode.md),
  plan 4 W0). Cairndex can be given permission to create, rename, move, and
  trash files inside one library root. **Nothing writes yet**; this is the
  switch every later operation will have to get past, landed on its own so the
  default answer is no before there is anything to say no to.

  Two switches must agree. Yours, per library, in **Libraries → Write mode**,
  off by default and stored in the server registry rather than the library
  package — so a library copied to another machine arrives read-only instead of
  carrying permission with it. And the operator's, `CAIRNDEX_WRITE_MODE`
  (`allowed` by default, `disabled` forcing every library read-only). Turning it
  on for a passphrase-protected library asks for that passphrase again; turning
  it off never does, because giving up a capability is always safe.

  Write endpoints answer `403 write_mode_disabled`, naming which of the two
  gates refused — the fixes are different, and one of them may not be yours.

- **Write mode — rename and New Folder** (plan 4 W1). The first operations that
  actually touch files. In the File Browser: **Rename…** from the context menu
  or <kbd>F2</kbd>, editing the name in place; **New Folder** in the toolbar and
  the empty-space menu. Every completed operation offers **Undo**.

  **Renaming through Cairndex never needs repair.** The rename and the stored
  path change together, so the file keeps its identity — bundle membership,
  cover, subtitle links, notes, ratings and cached thumbnails all survive, and a
  renamed folder carries everything inside it. That is the difference from
  renaming in Finder, where the scanner has to work out afterwards what moved
  where.

  **Every operation is journaled before it happens**, in the library itself, so
  the history travels with it. If the server dies mid-operation, the next open
  looks at the disk and either finishes the job or marks it failed — it never
  guesses, and never leaves a file whose recorded location is quietly wrong.

  A name that is already taken **asks** rather than failing: nothing has moved
  when the prompt appears, and *Keep both* adds `(2)`. Replace is deliberately
  not offered yet — it is defined as move-the-old-one-to-the-trash first, and
  the trash arrives in a later slice; until then there would be no way back.

  Renaming into or out of the library's own `.cairndex/` folder is refused, as
  are absolute paths, `..`, symlinks pointing outside the library, and names
  that a Windows or SMB client would silently mangle.

- **Write mode — move** (plan 4 W3). **Move to…** from the File Browser context
  menu — on one file, one folder, or a whole selection — opens a picker that
  walks the library's own folders one level at a time, so the destination is a
  real folder you can see rather than a path you type. The folders you are
  moving are left out of it, because a folder cannot go inside itself.

  **Moving through Cairndex never needs repair either.** Like a rename, the file
  moves and its recorded location change together, so every id survives — a
  moved folder carries its whole subtree, its bundles, covers and subtitle links
  intact. The whole selection is one action with **one Undo**. A name already
  taken in the destination **asks** — Replace / Skip / Keep both, applied to the
  batch — before anything moves; Replace sends the file it displaces to the
  trash, so it too is recoverable. If one file of a batch cannot be moved (a
  permissions wall on a share), the rest still move and the toast says which one
  stayed behind.

  *Not yet:* dragging entries onto a folder to move them — the menu is the way
  in for now.

- **Write mode — delete to a trash, and Replace** (plan 4 W4). **Deleting never
  unlinks.** Files and folders move into the library's own trash, and a new
  **Trash** view in the sidebar puts them back. Because the move is a rename
  within the same folder, it is instant whatever the file's size, and because
  the trash lives inside `.cairndex/` it travels with the library — copy the
  folder to another machine and its trash comes too.

  A restored file is the *same* file: same id, same bundle, same cover, same
  subtitles, same thumbnails. Deleting a folder takes everything in it as one
  deletion, and Put back returns the whole thing in one action rather than file
  by file.

  **Replace now exists**, in the rename collision prompt, and it is not an
  overwrite: the file being replaced is moved to the trash first, so the choice
  stays reversible. Undoing a Replace brings back *both* files. This is why the
  trash was built before the button was offered.

  **Empty Trash is the only action in write mode with no way back** — it says so,
  and names the amount of space it will reclaim. Deleted files are kept until
  then; there is no automatic expiry.

  Two smaller things that matter more than they sound: a trashed file is **not**
  reported as *missing*, so scanning does not confuse "you deleted this" with
  "this vanished"; and the trash stays visible when write mode is switched
  off — the sidebar entry remains as long as anything is in it and the view
  turns read-only, with Put back and Empty Trash waiting for write mode to come
  back — because turning a capability off should not make files look permanently
  gone when they are not.

  **Back up `.cairndex/trash/`** — it holds real files, not derived data. See
  `docs/deployment.md`.

- **Write mode — copying files in** (plan 4 W5). **Add Files…** in the File
  Browser toolbar, and dragging files from your desktop onto the listing, copy
  them into the folder you are looking at and link them, ready to bundle. This
  is the only way files from outside a library ever get into one.

  Files upload one at a time rather than all at once — six parallel uploads
  share the same bandwidth six ways, so everything finishes late instead of the
  first files finishing early. A name that is already taken asks, with the full
  Replace / Keep both choice, and answering carries on with the rest of the
  batch rather than abandoning it. Each file gets its own **Undo**, which moves
  it to the trash rather than deleting it.

  Nothing is held in memory: the upload streams to a staging file inside the
  library and is renamed into place, so importing a 60 GB video costs 60 GB of
  disk **in the library** and almost no RAM. An interrupted upload leaves a
  partial file that the next library open removes. `CAIRNDEX_IMPORT_MAX_BYTES`
  caps a single file if you want one; by default there is no limit.

  **Dragging from Finder into the desktop app now copies files in** — the thing
  write mode was built for. Drop media anywhere in the window and it lands in
  the folder you are looking at (or the library root), gets linked, and is ready
  to bundle. Files already inside the library still link in place as before, so
  a mixed drop does the right thing with both halves.

  The app will only ever upload a file **you dropped on it**: the shell records
  each drop itself and refuses anything else, so nothing can talk it into
  reading a file from elsewhere on your disk. Large files stream straight from
  disk to server without being loaded into memory at either end.

- **A release pipeline** (`.github/workflows/release.yml`). A `v*` tag — or a
  manual dispatch — builds the macOS app for Apple Silicon, smoke-tests the
  packaged sidecar against its bundled ffmpeg, and attaches the DMG, its
  `.sha256`, and `THIRD-PARTY-NOTICES.md` to a **draft** release. Publishing
  stays a human decision. The job refuses to continue on an invalid bundle
  signature or a binary of the wrong architecture.

  **Apple Silicon only.** An Intel job was built and proven first, then dropped
  after the v0.1.0 run: it is not needed, and it was ~4× slower at every
  compile-bound step on minutes billed at 10×. Intel remains pinned and locally
  buildable — restoring the artifact is one commented matrix entry.

  The workflow runs least-privilege: the build jobs hold a read-only token
  (only the publish job can write, to create the draft), and non-GitHub-owned
  actions are pinned by commit SHA, since this workflow produces the binaries
  strangers download and a repointed tag must not change what runs in it.

- **The desktop app now bundles ffmpeg**, so opening a library folder on your
  own Mac needs no Homebrew, no separate ffmpeg install, and no PATH setup —
  previously a packaged app fell back to a system ffmpeg that a user might not
  have. Both Apple Silicon and Intel are pinned (FFmpeg 8.1.2, static, GPLv3,
  notarized upstream), checksum-verified before they can enter a bundle.

- **`THIRD-PARTY-NOTICES.md`**, covering the bundled FFmpeg's GPL source offer,
  configure options, and exact binary digests. Cairndex's own code stays MIT;
  the obligation attaches to the redistributed binary
  ([ADR-0019](docs/adr/0019-open-source-distribution-model.md) §3). Also flags
  one unresolved item for the owner: `pillow-heif`'s wheels bundle LGPL
  `libheif`, whose notice obligations are not yet discharged.

- **A README install section** for the macOS app, covering the
  "Apple could not verify…" first launch and the System Settings → Privacy &
  Security → **Open Anyway** step that clears it — including that the step
  **repeats on every update**, since without an updater each update is a fresh
  quarantined download and an ad-hoc signature gives macOS no stable identity to
  carry the approval across.

### Internal

- **Documentation-only changes no longer run CI.** `paths-ignore` covers
  `docs/**`, `**/*.md`, `LICENSE` and `.gitignore`; a commit touching docs *and*
  code still runs everything. About half this repository's commits touch only
  docs, and nothing in CI validates prose. `workflow_dispatch` runs the full
  matrix on demand, and `desktop-macos` gained a 30-minute timeout so a hung
  Tauri build cannot occupy a runner for GitHub's six-hour default.

  A companion change restricting the desktop jobs to pull requests was reverted
  the same day: the repository went public, standard runners became free, and
  the restriction had been a pure cost trade that cost coverage on
  direct-to-main commits.

- **Fixed a flaky packaged-sidecar smoke test.** It asserted on
  `bundles?limit=1` — whichever of three differently-formatted fixtures sorted
  first — and failed intermittently with `thumbnail is not a JPEG (296 bytes)`,
  including twice on `main`. It now pins the assertion to the JPEG fixture. What
  produced those 296 bytes is still unexplained and is recorded as an open
  question in the test.

- **Fetched ffmpeg binaries are stored per platform** under
  `packaging/vendor/ffmpeg/<platform>/`. They previously shared one directory,
  so building both architectures meant each fetch silently overwrote the other's
  binaries — same filenames, no way to tell them apart.

- **`build_sidecar.py` verifies the bundle's architecture.** The checksum gate
  proves the *ffmpeg* matches the pin for `--platform`; it cannot see an arm64
  sidecar staged with a correctly-pinned Intel ffmpeg, which passes every digest
  check and produces an app that dies on launch. That is the mistake a
  two-architecture matrix makes, so the build now reads the frozen executable's
  Mach-O header and refuses a mismatch.

- **The packaged smoke test can no longer pass by accident.** It set
  `CAIRNDEX_FFMPEG_PATH` to the bundled binary and trusted the sidecar to use
  it, but `media/tool_paths.py` falls back to PATH discovery when a configured
  binary is not executable — so a lost execute bit would have let the run pass
  against a developer's Homebrew ffmpeg while claiming to prove the bundled one.
  It now fails on a bundled binary that is present but not executable, and on a
  bundle that stages one media tool without the other.

- **`packaging/` is inside the type-checking gate** (`mypy src packaging`). It
  was outside only because the gate named `src`, which left the checksum gate
  that decides what may be published unchecked. `ffmpeg_manifest.py` now
  validates field types as it reads them, so a digest that arrives as a number
  is a named error rather than a comparison that can never match.

- **The GPL corresponding-source record is committed, not linked.** Each
  architecture's configure line and full component version list now live in
  `packaging/ffmpeg-build-info/`; the three-year offer no longer depends on a
  third-party build server still serving those files.

### Security

- **The desktop importer no longer trusts the library id it is handed.** It went
  into the upload URL by string interpolation, so an id carrying `..`, `?` or `/`
  could restructure that URL — and because a server-scoped token is attached
  before the request goes out, a crafted id could have pointed an authenticated
  POST, carrying the file's bytes, at a path nobody chose. The id is now
  shape-checked (server ids are ULIDs) and the path is assembled segment by
  segment, which escapes it. Reaching this needed code running in the app's own
  web layer, which is why it is hardening rather than a fix.

### Added

- **Delete a bundle's files along with the bundle.** The Delete dialog's "Also
  delete contained files" checkbox has been present but inert since it was added
  — it captured your answer and then kept every file. It now works, and like every
  other deletion in Cairndex it is **trash-first**: the files move to the
  library's Trash, stay listed there, and can be put back until you empty it.
  Nothing is unlinked.

  **Put back returns the bundle, not just the files.** The bundle itself is not
  destroyed: trashing a file hides it from every view, so a bundle whose files are
  all trashed disappears on its own, and restoring brings it back with its title,
  tags, collections and cover intact. Emptying the trash is what makes both final.

  It appears only on a library with write mode on, because that is the only place
  the server would accept it — the ordinary metadata-only delete is unchanged and
  always available. The dialog also stops claiming the files "always stay on
  disk", which stopped being true the moment the box could be ticked.

- **Trash retention.** `CAIRNDEX_TRASH_RETENTION_DAYS` empties trashed files older
  than the given number of days. Off by default and deliberately so: the trash is
  the way back from a deletion, so it expires only once an operator has said how
  long "long enough" is. The sweep runs when a library opens, never on a request,
  and a failing sweep never blocks the library from opening.

### Fixed

- **Moving a file across a mount point inside your library now works.** A library
  root can span filesystems — a NAS share or external drive mounted at a
  subdirectory, a bind mount in a container — and the underlying rename cannot
  cross that boundary. Renames, moves, deleting to the trash and restoring from it
  all reported a per-file failure at that line; nothing was ever lost, but the
  operation could not succeed. They now fall back to copying and then removing the
  original.

  **The original is always the last thing to go.** The copy lands under a hidden
  name beside its destination, is flushed to disk, and is committed with an atomic
  rename; only then is the original removed. Every interruption therefore leaves
  the file readable at one path or both — never neither. If the process dies in the
  window where both exist, the next library open finishes the bookkeeping and
  **reports the leftover original rather than deleting it**: automatic recovery
  does not destroy original media, so the duplicate is yours to remove through the
  ordinary Trash once you can see it.

  A cross-device move is a copy, so it takes as long as the bytes take — and,
  unlike a rename, it needs room for a second copy while it runs.

### Changed

- **Creating a collection is reachable from where you are.** The sidebar's **+**
  now always makes a **top-level** collection, whatever happens to be open — it
  used to nest under the current selection, which meant there was no way to ask
  for a top-level one while browsing a collection, and the same button quietly did
  two different things. Nesting became its own gesture instead: **right-click a
  collection → New Subcollection**.

  In the main grid, right-clicking empty space now offers a collection **at the
  level you are looking at** — "New Collection" in the All view, "New
  Subcollection" inside a collection — from *both* the collections section and the
  contents section below it, since a collection with no subcollections yet has no
  collections section to aim at. The Collections heading and its run-out in the
  sidebar offer the same, and the desktop shell gains **File → New Collection**
  (<kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>), which like the **+** always
  means top level.

  Every route ends the same way: the new collection opens its inline rename box
  ready to be typed over, unfolding the sidebar's Collections section first if it
  was folded — otherwise a collection called "New Collection" would appear with
  nowhere visible to name it.

- **The File Browser plays video in the app's player.** Opening a video there
  used to hand it to the browser's own `<video controls>` — no custom control
  bar, no keyboard map, no transcode fallback, no storyboard scrubbing, no
  resume. It now opens the same viewer the Bundle Browser uses, so
  <kbd>←</kbd>/<kbd>→</kbd> seek, <kbd>Space</kbd> plays, and everything the
  player can do is available from either surface. Images gain the zoom/pan stage
  for the same reason. Audio keeps the native element it always had —
  there is no custom audio UI yet.

  **Stepping still follows the folder, not a bundle.** The File Browser keeps
  owning its own playlist — the openable files in the directory you are looking
  at, in the order shown — so opening a file that happens to be in a bundle does
  not silently switch you to that bundle's contents.

  **A file that was never indexed still plays.** It streams from its path and
  gets the whole player shell, minus what genuinely needs a file row: no
  subtitles, storyboard, chapters, or saved position, and no server-side
  remux/transcode, so an exotic codec fails exactly as it did before. A file that
  *is* indexed behaves identically to opening it from its bundle, resume point
  included.

- **Date orders belong to Recent, and new bundles arrive at the front.** Date
  Added / Modified / Opened are offered in the Recent view only — elsewhere they
  were a second route to what Recent is for. Every other view sorts by Manual,
  Title, Rating, Size or File Count. In manual order, a bundle nobody has dragged
  yet now sorts newest-first rather than oldest-first, so what was just imported
  appears at the front instead of the end of the library. A group that *has* been
  dragged keeps its explicit order untouched.

- **A file's line now names what it is, not the role the scanner guessed.**
  Roles were assigned by reading filenames — the first image became `cover`, a
  second video `alternate_version` — and nothing could change them afterwards:
  reordering files did not reassign them, and no control set them. A guess
  presented as a label reads as a fact, so files now show their media kind
  (video, image, subtitle, audio) with the extension standing in for anything
  unclassified, such as `pdf`. Which file is the cover stays where it is
  unambiguous: the starred row.

- **Superseded: a file's role reads as "image" where the app was guessing.** The scanner
  marks the first image in a bundle (or one named cover/poster/thumb) as `cover`
  and the rest as `image`, but nothing on disk says whether a picture beside a
  video is cover art, an album page, or a screenshot — and printing the guess as
  a type invited it to be read as fact. Both now read "image"; which file is
  actually the cover stays where it is unambiguous, on the starred row. The role
  itself is unchanged and still seeds the automatic cover pick.

- **The desktop window's title bar is merged into the app.** macOS no longer
  stacks a grey system bar above the shell: the app surface starts at the top of
  the window and the traffic lights float over the sidebar's top-left corner,
  which the sidebar now reserves. The toolbar sits in that same strip and drags
  the window, as a native toolbar does. Browser tabs are unaffected.

- **"Recently Added" is now "Recent", and picks its date.** It ranks by **Date
  Added**, **Date Modified**, or **Date Opened** — *which* date is the whole
  choice the view offers, so its menu holds those three and nothing else. Sorting
  it by Title or Size only produced a second All view under a misleading name
  (the server treats `recent` as All; only the ordering differs), and the
  per-view preference remembered the mistake.

  Date Opened is new: opening a bundle — in the album view or the viewer —
  records the time. It is stored separately from the modified time on purpose,
  so merely looking at something never counts as changing it: opening consumes
  no version and leaves Date Modified alone. A library that predates this gains
  the column on open, with everything in it reading as never-opened, which is
  what actually happened.

- **The sidebar no longer highlights a collection selected in the grid.** The
  tree's highlight means "this is where you are", and selecting a folder card
  doesn't navigate — so lighting up the matching row claimed a move that never
  happened. Each surface now shows the selection it made; the selection itself is
  still one thing, and every action on it (drag, context menu, inspector) is
  unchanged.

### Fixed

- **Bundles can be reordered in the All view.** It was disabled on the grounds
  that "reordering everything is meaningless", but All *is* the global manual
  order — the one new bundles now arrive at the front of — so arranging it is
  exactly what someone curating a library wants. Only the flattened
  subcollection view stays fixed: its cards span several parents, so a drag there
  would rewrite the global order while appearing to arrange one collection.

- **Rubber-band selection is gone from the list layouts**, in both the Bundle
  Browser and the File Browser. A band dragged down a single column of rows can
  only ever pick a consecutive run — which is what Shift-click already does in one
  gesture — so the rows keep their drag for reordering and for dropping onto a
  collection instead, and there is no longer a hidden rule about which part of a
  row starts which gesture. The grid layouts band as before. Clicking empty space
  still clears the selection everywhere.

- **Opening a bundle now re-sorts the Recent view on its own.** Date Opened only
  caught up when something else happened to refetch the listing — navigating back
  to it, or changing the order — so the owner's own action stayed invisible until
  they poked it. Opening a bundle now tells exactly the listings that rank by that
  column, so the re-sort happens behind the viewer; a view sorted by anything else
  is left alone.

- **Dragging a nested collection to the bottom of the tree puts it there.** It
  used to land near its old parent instead. Two causes, both from splitting one
  gesture in two: the placement half of the request still spoke a retired
  contract and was rejected outright (leaving the collection reparented but
  carrying its old position), and even with that fixed, the reparent published an
  intermediate state — in the new group, old position — that a refetch could latch
  onto before the placement landed. A collection move is now a single request
  naming what moves, which group it joins, and which gap it lands in; the server
  reparents and places together. Nesting is the same operation with no gap named,
  so it too now lands somewhere defined instead of keeping a stale position.

- **The sidebar tree joins the one-seam model, with reachable reorder edges.**
  Dropping between two rows shows a single seam wherever in that gap the pointer
  is. Its reorder edges also had a floor put under them: 28% of a 226px card is a
  comfortable 63px, but 28% of a 29px row is 8px, so nesting kept winning drags
  meant as reorders — the edges are now at least 10px while the middle keeps a
  third of the row for nesting. And a row with its children showing now draws the
  seam *below* those children, where the next sibling actually begins, instead of
  tight under the row where it read as "make this a child".

- **One seam per drop location.** A gap between two cards was describable from
  either side — "after the left one" or "before the right one" — so a single
  insertion point presented as two seams that did the same thing. A drop now
  resolves to a *destination* (the item the block lands in front of, or the end
  of the group) and exactly one seam paints for it, wherever the pointer happens
  to be within that gap's reach. Nesting is untouched: a card's middle still
  rings for "make this a subcollection". Applies to the collection cards and the
  bundle grid, which share the model.

- **Reordering collections no longer sometimes does nothing.** The owner's
  recording caught it: the insertion line promised "before Archive", but the release
  landed two pixels into the *gutter* between cards — territory the cards didn't
  own. It fell to an old surface handler that resolved drops by the grid's
  vertical midpoint, picked the last sibling as the edge, and when that sibling
  was the dragged card itself, silently discarded the move. The collection grid
  now works exactly like the bundle grid: one gap computation over the cursor
  feeds both the insertion line and the drop, gutters resolve to the gap they
  visually are, and the dragged payload lives in a synchronous store so even the
  fastest flick can't outrun it. Sidebar rows got the same synchronous payload.

- **Cards select on press, not release.** Selection used to land on mouse-up —
  so a drag that began on an unselected card swallowed the click that would have
  selected it, and the drag left with the *previous* selection. Pressing a card
  now selects it immediately; pressing a card that is already part of a
  multi-selection keeps the group (so the group can be dragged), and a plain
  click still collapses to just that card on release. Modifier clicks (⌘, ⇧)
  are unchanged.

- **A settled reorder no longer starts a hover preview on its own.** When a
  drop rearranges the grid, cards slide under the resting pointer and whichever
  one lands there began playing its preview unasked — sometimes continuing after
  the pointer moved away. Previews now stay off after a drag ends until the
  pointer actually travels (beyond a few pixels), the signal that hovering is
  intentional again.

- **Reordering collections no longer counts as modifying them.** Same rule
  bundles got: rearranging the shelf isn't editing the books. Beyond honesty,
  each collection's modified time is its cover-thumbnail cache key, so every
  drag was re-fetching every sibling's cover.

- **Drag-reorder rebuilt around three rules, after a screen recording showed a
  drop scrambling cards it never touched.** The recording's toolbar read
  "Manual ↓" — and *descending manual order* was the hole: the server resolves
  and returns the order ascending, so painting its correct answer onto a
  reversed display shuffled the whole grid, and a reload (fetching descending
  again) disagreed with what had been painted. The rules now:

  *Manual order has no direction.* An order arranged by hand is just the order;
  offering ascending/descending over it created two readings of one
  arrangement, and a drag can only be correct under one of them. The direction
  toggle is gone for Manual, and a stored "manual descending" preference is
  read as plain manual.

  *What the line shows is what the drop does.* One computation over the cursor
  position now produces both the blue insertion indicator and the committed
  move — cards no longer handle reorder drops at all, so there is nothing left
  to race and no second opinion. The indicator also clears when the drag leaves
  the grid.

  *Rearranging the shelf doesn't edit the books.* The order writer now touches
  only rows whose position changed and carries their modified-time forward —
  previously each drag rewrote the entire scope, stamping every bundle in the
  library "modified just now" (quietly destroying Date Modified) and issuing
  one UPDATE per bundle against a library database that may live on a network
  volume, which is also the likely cause of reloads turning slow after a few
  drags. Overlapping drags are serialized so their results apply in commit
  order.

- **A reorder no longer answers twice.** The move was settled by a *refetch*
  after the write — a second answer to a question the write had already decided —
  so any disagreement between the client's guess and the server's order showed up
  as the row moving again half a second later, unprompted. Both reorder endpoints
  now return the resulting order, the client applies exactly that, and nothing is
  invalidated. One gesture, one request, one answer.

- **Reordering collections sometimes did nothing at all.** The endpoint required
  the client to send *exactly* the members of a sibling group, so a drag failed
  outright — silently — whenever the client's picture had drifted (a collection
  created, deleted, or moved elsewhere since the tree last loaded). It now takes
  the same move description bundles use and resolves it against the group as it
  actually stands, ignoring ids that are no longer there.

- **Superseded: a reorder appeared to trigger a second, unrelated one a moment later.** The
  optimistic update — the part that moves the card under the cursor before the
  server answers — was applied to *every* cached listing rather than the one the
  move belongs to. A drag inside one collection also rewrote the remembered order
  of the All view and every other cached collection, and each of those snapped
  back to the truth the moment it was next shown or refetched. Only the listings
  a move actually reorders are touched now.

- **Drag-reordering bundles was unreliable in three separate ways, and has been
  rebuilt.** Items landed one place off, jumped to the very start or end of the
  list, or did nothing at all.

  *A drop on a card was handled twice.* The container's fallback handler — meant
  for drops in the margin — tested for cards with a selector that never matched
  the elements that carry the drop, so it fired for card drops as well and sent a
  second, contradictory move. The two raced, and the wrong one often won: that is
  the jump to an end.

  *A drop in the gutter meant "an end".* Anything not exactly on a card was read
  as "send it to the start or the finish", including the few pixels between two
  tiles — the very place the insertion line invites the drop. Off-card drops now
  resolve to the nearest gap.

  *The client decided the order.* It sent the whole list it could see and the
  server numbered it 0..n-1, which is only right when the client holds the entire
  collection. Browsing is paged, so a drag in anything larger than a page
  renumbered the loaded window on top of the order values the rest still held,
  and bundles the user could not even see moved. The client now sends the *move*
  — what was dragged, and what it was dropped in front of — and the server
  resolves it against the whole collection. The dragged ids also travel on the
  drag itself rather than in React state, so a drop no longer depends on a render
  having happened first.

- **Reordering files inside a bundle was slow.** Not the write — a handful of
  UPDATEs — but what followed it: the list only moved once the round trip
  finished, and then refetched the bundle's files, a request that stats every
  file to reconcile missing ones. On a network volume that was the whole delay.
  The drag now applies immediately and the server's own response replaces it,
  with no refetch.

- **The desktop window could not be moved.** Two causes, both silent. Tauri's
  `data-tauri-drag-region` in its bare form only fires when the click lands on
  that exact element, and the app's top row is made of children — a flex spacer,
  the title and count — so nearly every grab hit a child and did nothing; the
  drag strips now use the `deep` form, which still refuses on buttons and
  inputs. Underneath that, the shell's capability file never granted
  `core:window:allow-start-dragging`, so the drag request was denied by the
  permission layer even where the region matched. The sidebar's padding and the
  inspector column, both dead bands at the window's top edge, now drag too.

- **Dragging a collection to reorder it showed no insertion line.** The folder
  card's redesign clipped its own overflow, and the drop indicator is drawn in
  the gap just *outside* the card — so it was clipped away, leaving a reorder
  drag with no sign of where it would land. The card no longer clips; the cover
  and the footer clip themselves, which is all that ever needed it.

- **The window jittered between two sizes at one particular width.** The grid
  measures its scroll container to lay out columns, and that measurement excludes
  a scrollbar — so at the width where content is *just* tall enough to need one,
  showing the scrollbar narrowed the measurement, which relaid the cards shorter,
  which removed the need for the scrollbar, which widened it again, forever, at
  frame rate. The scrollbar's width is now always reserved, which makes the loop
  impossible. Only affects setups showing classic scrollbars; with macOS overlay
  scrollbars nothing changes.

- **Cover art was intercepting the gestures meant for the card holding it.** A
  thumbnail is decoration, but the browser treated the image element as the
  thing being clicked, and WebKit then applied its own image behaviour on top:
  grabbing a folder cover started a native *image* drag (a large translucent
  copy of the artwork instead of the drag pill, ignoring the app's drag image
  entirely), right-clicking one opened the OS image menu instead of Cairndex's,
  and macOS Live Text made the words recognised *inside* the picture
  selectable — so a drag-select that crossed a cover highlighted text baked
  into the artwork rather than selecting items. Thumbnails and hover previews
  are now inert; the card or row beneath them owns every gesture. The real
  viewers keep their interactive images, where selecting text in a picture is
  a feature rather than a misfire.

- **Collections could not be multi-selected for a drag, and blank space would
  not deselect them.** Dragging one card of a three-collection selection moved
  only that one; the drag pill likewise said one name. A collection drag now
  carries the whole selection ("3 collections") and drops them together —
  reparenting into a folder, or reordering as one block that keeps its relative
  order. Any dragged collection that is an ancestor of the drop target is left
  behind instead of failing the whole drop on the server's cycle check.
  Clicking blank space now clears the selection in two places that ignored it:
  the wide empty strip beside the *Subcollections* / *Contents* titles, and the
  sidebar's own empty space.

- **The macOS app bundle was invalidly signed, not merely unsigned.** Tauri only
  runs `codesign` when a signing identity is configured, and none was, so
  `Cairndex.app` shipped with no `_CodeSignature/CodeResources` — an executable
  carrying a bundle-style signature with nothing sealing its resources. macOS
  rejects that as malformed (*"code has no resources but signature indicates
  they must be present"*), which fails harder than an absent signature and
  would have met the first person to download a release. It stayed invisible
  because Gatekeeper only assesses **quarantined** apps, and every build
  observed so far was local. `signingIdentity: "-"` now ad-hoc signs the
  bundle; the quarantined verdict is the ordinary `rejected` that **Open
  Anyway** clears. The nested notarized ffmpeg keeps its own Developer ID
  signature ([ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4).

### Changed

- **HEIC decoding moved from `pillow-heif` to `pi-heif`, removing a GPL
  library from the app.** `pillow-heif`'s wheel bundles **libx265**
  (GPL-2.0-or-later) for encoding, and libheif names it in a load command rather
  than a lazy `dlopen`, so importing it pulled GPL code into the sidecar
  process. Cairndex only ever decodes HEIC, so that encoder was 8.6 MB of
  copyleft obligation buying nothing. `pi-heif` is the same maintainer and
  codebase, decode-only, and bundles libheif + libde265 (both LGPL) with no
  x265. No user-visible change — HEIC viewing is decoding — and the app dropped
  from 213 MB to 196 MB.

  `pillow-heif` stays as a development dependency for generating the smoke
  test's HEIC fixture, which needs an encoder. That is enforced rather than
  assumed: the PyInstaller spec excludes the package, and `build_sidecar.py`
  now fails the build if `libx265` appears in a bundle at all — an exclude only
  covers the package it names, so a future dependency vendoring the same
  encoder would otherwise slip through.

- **The README's license line now matches the repository.** It said "All rights
  reserved" while `LICENSE` has been MIT since the owner's 2026-07-21 decision.

- **Adding a library is one flow instead of two.** The Libraries dialog no
  longer asks whether you are creating or registering: you give a path, and the
  server reports what is there. A folder already registered is selected, an
  existing Cairndex library is added under the name it carries, and any other
  folder — including one that does not exist yet — is offered as a new library
  with the name prefilled from the folder itself. The separate “create the
  folder if it doesn't exist” checkbox is gone; the same confirmation says when
  a folder will be created.

  Naming a new library happens in place: the path field becomes a name field
  prefilled with the folder's own name, and the same button — in the same
  position — confirms it, so neither the pointer nor the caret has to move.

  On the desktop app a **Browse…** button reaches those same outcomes through
  the native folder picker, and it accepts a folder that is not a library yet,
  asking for a name instead of refusing. Everything except Browse… behaves
  identically in the browser, which cannot produce an absolute path on the
  server.

- **File → Open Library Folder… is now File → Manage Libraries…** (still ⌘O).
  It opens the Libraries dialog rather than jumping straight to the folder
  picker, so one surface covers adding, opening, and removing, and the dialog is
  reachable by keyboard from any state — including the ones that replace the
  workspace, such as a library another server is serving. Browse… inside it is
  the folder picker. First-run setup is the exception: with no server there is
  no library list to show, so there the item still picks a folder directly. The
  sidebar's button for the same dialog is now a stack of books rather than a
  `+`, since the dialog no longer only adds.

- **Path autocomplete works from the keyboard.** Down/Up move through the
  suggestions, Enter takes the highlighted one, Tab completes as far as the
  suggestions agree, and Escape closes the menu. Taking a suggestion keeps the
  menu open so one keystroke per level walks into a tree, and directories that
  are already Cairndex libraries are marked in the list.

### Added

- **Libraries can be removed from a server.** Each row in the Libraries dialog
  has a Remove action behind a confirmation. Removal is **metadata-only**: it
  deregisters the library from this server and never touches the folder, its
  `.cairndex/` package, its `library.db`, or any media. Adding the same folder
  back later restores the library with all of its metadata, since none of it
  lives in the server registry. Removing the library you are viewing is
  allowed; the app falls back to its no-library state.

- `DELETE /api/v1/libraries/{library_id}` — deregisters a library.
  **Metadata-only, as above**; it performs no filesystem deletion of any kind.
  It releases that library's ownership lease and closes its database cleanly, so
  the folder is immediately openable by another machine.

- `GET /api/v1/libraries/probe-path?path=…` — reports whether a path exists, is
  a Cairndex library, and is already registered, plus the library's own name and
  the folder's basename. Owner-setup only, like `path-suggestions`, and it
  creates nothing.

- `GET /api/v1/libraries/path-suggestions` now marks each suggested directory
  that already carries a `.cairndex/` package.

### Fixed

- **Desktop startup no longer flashes a white frame.** The root cause was
  WKWebView's opaque white backing surface, which exists until WebKit's
  compositor paints and is unaffected by document or CSS backgrounds. Enabling
  Tauri's `macos-private-api` feature lets the configured window
  `backgroundColor` disable that surface, so the first composited frame is dark
  by construction (ADR-0020). The earlier off-screen priming workaround was
  reverted. The native main window still starts hidden and is revealed only
  after React commits the mounted shell, so the window appears with UI already
  present; cold-start deep links and near-simultaneous second launches share
  the readiness gate, while a delayed page-load fallback prevents a broken
  renderer bridge from leaving the app invisible.

- **Selecting a bundle cover now updates the star immediately.** Bundle metadata
  writes optimistically update the inspector, roll back on failure, and adopt
  the PATCH response instead of waiting for another detail request. Bundle
  detail reads no longer stat every member path; file-list, playback, and scan
  flows retain missing-file reconciliation. Browse cards and derived thumbnails
  refresh in the background.

- **Bundle file rows now reorder reliably in the desktop app and can play one
  file directly.** Reordering uses captured pointer movement instead of WebView
  HTML drag/drop events, while Option-drag still hands the file to Finder. A
  compact play action immediately after the cover action opens that exact
  supported image or video in the unified viewer.

- **The current bundle cover is indicated on its action instead of beside the
  filename.** The selected file's star button is filled yellow and exposed as
  “Current cover”; other eligible files retain the muted “Set as cover” action.

- **Long bundle titles wrap inside the inspector instead of scrolling on one
  line.** The title editor grows to its wrapped content and re-fits when the
  inspector width changes, while Enter still saves the edit.

- **Bundle file order now uses direct row dragging instead of arrow buttons.**
  Drag a file card to the gap where it should play, or focus it and press
  Option+Up/Down for keyboard reordering. In the mapped desktop app,
  Option-drag retains the existing copy-out-to-Finder gesture.

- **Renamed files on SMB/network libraries can be relinked after scan identity
  repair misses them.** Missing Files now includes stale provisional rows and
  offers a compact relink action when exactly one live, already-linked file has
  the same quick fingerprint and media kind. Relinking preserves the original
  stable file ID, established bundle metadata, references, and newest playback
  progress; it removes only the duplicate Cairndex row and never changes the
  filesystem. Later scans therefore stop reporting the repaired path as
  missing.

- **Grouping suggestions exclude files marked missing by the latest scan.** The
  scanner still retains their database rows so metadata and moved-file repair
  survive, but they no longer appear as live grouping candidates. Applying an
  older open plan also reports a conflict instead of regrouping a now-missing
  row.

- **Files can be moved reliably between grouping suggestions.** The whole file
  row now starts a drag, and both the target bundle heading and its file list
  accept the drop, removing the two small hit targets that made cross-bundle
  moves easy to miss.

- **Relaunching while the local connection is active reopens into it** instead
  of the first-run "Connect to your server" screen (review, P3). The local
  connection stores no URL by design — its sidecar port is per process — and
  the bootstrap read that null as "unconfigured". It now activates the entry
  (starting the sidecar) and falls back to setup only if that fails, with the
  shell's own reason shown. The bootstrap's redundant post-activation probes
  are gone too: activation verifies reachability itself before committing.

- **The sidecar bounds its graceful shutdown at 10 s** (review, P3). uvicorn's
  default waits for open connections *indefinitely*, so one connection held
  open at quit could push the shell past its 15 s grace into the kill fallback
  — the exact path that strands ownership leases and greets the next launch
  with a takeover prompt. The bound keeps the lifespan shutdown, lease release
  included, inside the shell's budget by construction.

- **Connection activation now owns the JSON API base URL** (whole-milestone D6
  review, P1). The base moved only as a side effect of the reachability probe,
  so activating the local connection never pointed the app at the sidecar —
  requests kept going to the previous remote server (or nowhere on first run) —
  and a *failed* activation left every request pointed at the dead server it
  had just probed while the UI still showed the old connection. `verifyServer`
  is now a pure probe, the base moves in activation's commit step for both
  connection kinds, and the compensation path can restore a *local* previous
  connection (it used to skip it entirely because local stores no URL). Pinned
  by a new suite that asserts where requests actually resolve after each
  activation outcome — the property every earlier test mocked away.

- **A lease heartbeat no longer surrenders over a transient read failure**
  (review, P2). A failed *write* was already tolerated ("an offline mount is
  not a lost lease — nobody else can reach it either"), but a failed *read*
  was folded into "corrupt" and surrendered — unmounting the library and
  cancelling its jobs over one NFS/SMB blip, then showing a takeover prompt
  for the user's own healthy library. `read_lease` now distinguishes an I/O
  error from real corruption; the heartbeat rides out the former (no blind
  rewrite either) and still surrenders on the latter. Acquisition still treats
  both as UNREADABLE — "we could not find out" never becomes "nobody holds it".

- **The media relay's scope-flag derivation is now under test** (review, P2).
  `targets_running_sidecar` — the only guard keeping `server_scoped_token`
  derived rather than caller-supplied — had zero coverage; any weakening of its
  URL+token match would have survived the suite and silently reattached a
  paired device token to libraries it does not grant. Five tests now drive the
  real function against a real live-checked `LocalServer`, including the two
  dangerous directions (device token at the sidecar's URL, sidecar token at a
  remote URL) and a dead sidecar. Verified by mutation.

### Added

- **Cairndex is MIT licensed** ([`LICENSE`](LICENSE)), ahead of the first public
  release (ADR-0019 §4). Binary desktop releases additionally bundle static
  ffmpeg/ffprobe builds, which are GPL-3.0-or-later and carry their own source
  offer — Cairndex invokes them as separate executables, so its own terms are
  unaffected. The `LICENSE` file states both.

- **Plan 3 D6 (local-server sidecar) is complete**, verified by an owner pass on
  the packaged app rather than by tests alone. The desktop app can now open a
  local library folder with no server to install or configure: it starts a
  bundled server on demand, and the ownership lease keeps that from colliding
  with a NAS or another machine serving the same folder.

- **Library ownership lease (ADR-0018 §2–§4).** A library can now be served by
  exactly one Cairndex server at a time. Each server writes a lease inside the
  library at `.cairndex/locks/active-owner.json` and refreshes it every minute; a
  second server pointed at the same folder — over SMB, over NFS, or through a
  cloud-synced copy — refuses to open it and names the machine that holds it,
  offering a redirect when that machine advertises a reachable address. This
  hardens the NAS deployment on its own and is the prerequisite for the plan 3 D6
  desktop sidecar.

  A clean shutdown releases every lease, so the everyday quit-here / open-there
  flow never prompts. Only a crash (or a paused sync) leaves a lease to age into
  staleness, and taking one over **always** requires explicit user confirmation —
  there is no automatic takeover after any timeout. Before taking a stale lease
  the server watches it for longer than a heartbeat period, so a holder that is
  actually alive keeps the library regardless of the confirmation. If this server
  loses a lease it holds, it stops writing, cancels that library's jobs, and
  unmounts rather than fighting for it back.

  New endpoints: `GET /api/v1/libraries/{id}/ownership` (readable precisely when
  the library will not mount) and `POST .../ownership/takeover` (202; the
  observation window runs in the background). New settings:
  `CAIRNDEX_MACHINE_NAME`, `CAIRNDEX_ADVERTISED_URL`,
  `CAIRNDEX_LEASE_HEARTBEAT_INTERVAL`, `CAIRNDEX_LEASE_TTL` — see
  `docs/deployment.md`, which also documents the one-active-machine semantics for
  cloud-synced libraries.

- **The desktop shell can now run a local server (Plan 3 D6.3).**
  `apps/desktop/src-tauri/src/sidecar.rs` spawns the bundled server on demand,
  waits for it to become healthy, and stops it with the app. The bundle is staged
  into `Cairndex.app` as a resource. The sidecar announces its own ephemeral
  loopback port, and the shell generates a fresh 256-bit bearer per start and
  passes it in the environment rather than argv. Shutdown closes the sidecar's
  stdin instead of sending a signal — that needs no per-OS branches and, unlike a
  signal, still works when the shell crashes, so a killed app cannot orphan a
  process still holding ownership leases. Concurrent `start_local_server` calls
  are serialized end to end, so a double-invoked mount effect (React StrictMode)
  cannot leave a caller holding a terminated sidecar's URL and token. New
  commands: `start_local_server`, `stop_local_server`, `local_server_status`. No
  UI consumes them yet; that is D6.4/D6.5.

  **Building the desktop crate now requires the sidecar bundle path to exist** —
  `tauri-build` copies bundle resources at compile time, so `cargo check`,
  `cargo test`, and `tauri dev` all need either a built bundle or an empty
  `apps/server/packaging/dist/cairndex-sidecar` directory. See
  `docs/development.md`.

- **A confirmed takeover now waits ~80 s instead of 120 s, and says so.** The
  observation window was two full heartbeat intervals; only the *first* carries
  the guarantee (a takeover starts at an arbitrary point in the holder's cycle,
  so a whole interval must pass before a live holder is certain to have written).
  The second was margin for a write that has to propagate through a cloud-sync
  engine, and is now a separate `CAIRNDEX_LEASE_OBSERVATION_MARGIN` (default
  20 s) — raise it for a synced library, rather than paying for it on a local
  disk. The dialog now states the duration, explains why it is that long, and
  counts down instead of spinning silently for minutes.

- **Fixed: switching connections did not check the server was reachable.** A
  lease redirect would activate the holder's advertised address without
  verifying anything answered there, stranding the app on a dead server and
  persisting it as active — so the next launch opened straight into the error
  screen. Reachability is now checked before the switch commits, like every
  other fallible step, and a failure leaves the previous connection untouched.

- **Fixed: opening a folder your current server already serves.** ⌘O started a
  *second* server against the same folder, which the ownership lease then
  correctly refused — reporting the library as "open on <your own machine>",
  since both servers were on it. The shell is now told which libraries the
  current server already has, and reports a match instead of opening anything;
  the app just selects the library it already had, by portable `library_uuid`
  (registry ids differ between servers, so the shell's id would be meaningless).

- **Fixed: re-opening an already-registered library did not switch to it.** The
  library to show was handed over through a slot consumed on remount, but
  activating the connection that is *already* active changes no id and remounts
  nothing, so the second open appeared to do nothing. The queue is now observable
  in its own right.

- **Fixed: a hand-edited lease timestamp without a timezone was ignored.**
  `active-owner.json` is plain JSON people legitimately edit, and a naive
  timestamp raised `TypeError` inside the classifier — swallowed by the
  heartbeat's never-die guard, so the library stayed silently held instead of
  unmounting. A missing offset is now read as UTC, matching both the documented
  format and what someone editing the file means.

- **Fixed: Open Library Folder… did nothing in the running app.** It was handled
  only in the first-run bootstrap, whose menu listener tears down once the
  workspace mounts — so the item stayed enabled and inert in the state a user
  actually spends their time in. Now handled in both, since the item is reachable
  from both, and a failed open reports the reason instead of failing silently.

- **Fixed: the sidecar aborted at shutdown, leaving its ownership lease held.**
  `--watch-parent` blocked a daemon thread inside `sys.stdin.buffer.read()`,
  which holds that reader's lock; if the interpreter then finalized for any other
  reason (a SIGINT, say) CPython could not close stdin and called `abort()`. The
  abort skipped the lifespan shutdown, so the lease was never released and the
  next launch met a takeover prompt it should never have seen. Now reads the raw
  file descriptor, which takes no such lock. Found from a real crash report while
  exercising the packaged app.

- **Ownership lease UX (Plan 3 D6.5).** A library another server holds now
  explains itself instead of failing content queries. Checked once at the mount
  gate rather than per query, so a refusal is one state and not a scatter of
  identical errors. Three outcomes: a **live** holder is named and offers
  "Connect to <machine>" when it advertises a reachable address — never a
  takeover, since taking a library from a server actively serving it is the
  dual-writer the lease exists to prevent; a **stale or unreadable** lease offers
  a confirmed takeover explaining why confirmation is needed; and a takeover in
  flight shows indeterminate progress with a note that it takes a couple of
  minutes and that a live holder can still win. The library picker stays visible
  throughout, so no state strands the user.

- **Open Library Folder… (Plan 3 D6.4).** A File-menu item (⌘O, a combo the
  browser reserves and the shell can own) picks a library folder, starts the
  local server, registers the folder, and switches to it. Deliberately ungated:
  it works from the first-run screen with no remote server ever configured, which
  is the milestone's premise. Dismissing the picker changes nothing — no sidecar
  start, no connection switch. The library to show is handed across the
  connection switch explicitly rather than through storage, since activation
  remounts the tree that consumes it.

- **Connections model in the desktop shell (Plan 3 D6.4).** The shell now holds a
  set of connections — remote servers plus one managed local server — with
  exactly one active at a time, replacing its single stored server URL. An
  existing configured server migrates into the first remote connection, so a NAS
  setup sees no first-run change. Activation is all-or-nothing (every fallible
  step runs before anything user-visible moves, and a failure re-points transport
  at the previous server) and serialized (a repeat request for the same
  connection joins the one in flight; a different one is refused rather than
  queued). The query cache is now scoped per connection by remounting rather than
  clearing, because library ids are per-server and an in-flight request can
  otherwise resolve into the new connection's cache. No UI exposes switching yet.

- **Shell support for opening a local library folder (Plan 3 D6.4, in progress).**
  A `pick_library_folder` command opens the native folder picker and validates the
  selection as a Cairndex library, returning its canonical path, portable uuid,
  and display name — the shell-side half of "Open library folder…". The media
  relay gained an explicit **server-scoped token** mode for the sidecar's loopback
  owner token, which authorizes a whole server rather than an enumerated set of
  libraries; a paired device token keeps its fail-closed per-library scoping
  unchanged. No SPA consumes either yet.

- **Packaged local-server sidecar (Plan 3 D6.2).** `apps/server/packaging` builds
  the server into a PyInstaller one-dir bundle the desktop shell can spawn, plus
  `fetch_ffmpeg.py` for pinned, checksum-verified static media binaries and a
  `smoke_test.py` that runs the *packaged* bundle over HTTP. A new CI job builds
  and smoke-tests it on every push, because the unit suite imports from source
  and structurally cannot catch a frozen bundle missing a dynamically resolved
  import. `cairndex.sidecar` binds an ephemeral loopback port and announces it on
  stdout, refuses to start without its owner token, and releases its ownership
  leases on SIGTERM. The static-ffmpeg source is not yet pinned — choosing it is
  an owner decision (ADR-0019 §3) — so builds currently use `--skip-ffmpeg`.
  *(Superseded: both macOS architectures are pinned as of the entry at the top
  of this file. `--skip-ffmpeg` is now the Linux-only path.)*

- **Server groundwork for the desktop local-server sidecar (Plan 3 D6).**
  `CAIRNDEX_LOCAL_TOKEN` puts the server in *sidecar mode*, requiring a loopback
  owner token on every API request (health stays open so the shell can wait for
  readiness). It replaces the ADR-0015 pairing ceremony, which has nobody to
  approve it for a process the shell started itself — but deliberately does
  **not** stand in for a library passphrase the way a paired device token does,
  since it is minted with no owner approval. `CAIRNDEX_FFMPEG_PATH` /
  `CAIRNDEX_FFPROBE_PATH` name the media binaries explicitly, and resolution now
  falls back to conventional install prefixes after `PATH`, because a macOS app
  launched from Finder inherits launchd's minimal `PATH` and would otherwise
  report "ffmpeg not found" on a machine that plainly has it. Unset, everything
  behaves exactly as before.

- **SQLite sync hygiene for synced libraries (ADR-0018 §6).** A library in WAL
  mode is up to three files on disk, and a cloud-sync engine uploads whatever it
  happens to find. An idle library is now checkpointed with
  `wal_checkpoint(TRUNCATE)` so its at-rest state is a complete `library.db` and
  an empty WAL rather than a triple that can be captured mid-write, and a clean
  shutdown checkpoints and closes every library before releasing its lease,
  leaving a single file. A periodic consistent snapshot is written to
  `.cairndex/library.db.bak` through SQLite's online backup API (temp file then
  rename) as the heal path if a torn state ever does get shipped — it is a
  convenience, not a backup, since it travels with the library folder. Both only
  ever run against libraries this server holds the lease for. Tunable via
  `CAIRNDEX_SQLITE_MAINTENANCE_ENABLED`, `CAIRNDEX_SQLITE_MAINTENANCE_INTERVAL`,
  `CAIRNDEX_SQLITE_IDLE_CHECKPOINT_AFTER`, and
  `CAIRNDEX_SQLITE_SNAPSHOT_INTERVAL`.

- **D5c desktop distribution (Plan 3).** Release builds now produce a **DMG**
  alongside the `.app`, giving drag-to-Applications install ergonomics. The full
  Developer ID signing + notarization procedure is documented in
  `docs/deployment.md` and driven entirely by environment variables
  (`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, a notarytool keychain profile); with
  those unset the build is byte-for-byte today's ad-hoc-signed build, so nothing
  is re-plumbed when signing is eventually wanted. CI continues to build with
  `--bundles app` because Tauri's DMG bundler drives Finder over AppleScript and
  flakes on headless runners.

- **D5b deep links, job notifications, and the export seam (Plan 3).**
  `cairndex://bundle/<id>` and `cairndex://collection/<id>` (optional
  `?library=<id>`) open that target in the desktop app, including from a cold
  start — macOS delivers the URL before the webview exists, so the shell parks it
  until the SPA is listening; Windows/Linux pass it in argv, forwarded by
  single-instance on a warm start. Links only resolve from a packaged,
  LaunchServices-registered app. A long maintenance run that finishes while the
  window is unfocused now posts a user notification and a dock badge, coalesced
  per *run* rather than per job (`Update library` chains three jobs for one user
  action); returning to the window clears the badge. A native save-dialog seam for
  future media exports (plan 1 §10 / M11) is present but unused — no export UI
  ships here.

- **D5a menus and shortcuts (Plan 3).** The desktop menu bar is now built from a
  single shared table, `apps/web/src/platform/keymap.json`: the shell embeds it at
  compile time and constructs the menu from it, while the SPA reads the same file
  for action typing and its shortcut reference, so labels and accelerators cannot
  drift apart. A new **Playback** menu drives the open media viewer (play/pause,
  previous/next file, ±10 s, speed, mute, subtitles, snapshot) through the same
  dispatcher the key bindings use, and stays enabled only while a viewer is
  mounted. The shortcut audit enables combos a browser reserves and the shell can
  now own: ⌘1/⌘2, ⌘N, ⌘[ / ⌘], ⌘= / ⌘−, and ⌘⇧I. All accelerators are
  modifier-based by construction, so none can swallow a keystroke meant for a
  text field. Playback items carry an accelerator only where no bare viewer key
  already covers the command — just Previous/Next File (⌘[ / ⌘]), which have no
  key binding at all once a video loads, since the arrows then mean seek.

### Changed

- **Structured errors may now carry `details`.** `ErrorBody` gains an optional
  `details` object, used by the ownership-lease refusals to name the holding
  server so a client can offer a redirect instead of a dead end. It is omitted
  entirely from every error that does not set it, so existing responses are
  unchanged. Regenerated `openapi.json` and `schema.d.ts` accordingly.

- **Distribution model: open source with published binaries (ADR-0019,
  proposed).** Cairndex is going open source and desktop builds will be published
  through GitHub Releases. This settles the sidecar packaging that ADR-0018 §5
  left open — **PyInstaller one-dir plus a bundled static ffmpeg/ffprobe** — and
  reopens three decisions that were justified by "built from source, not
  distributed": Developer ID signing (required again; the entry below is
  superseded), the deferred updater, and ffmpeg's GPL source-offer obligations.
  Choosing a project license and producing multi-arch release artifacts join
  them. None block plan 3 D6; all block the first public release.

- ~~**Developer ID signing is no longer a v1 requirement (Plan 3 §3 amendment).**~~
  **Superseded by ADR-0019 §4** — the premise below (single-owner, built from
  source, not distributed) no longer holds.
  Cairndex is single-owner and built from source, and Apple Silicon ad-hoc signs
  at link time, so packaged builds have worked locally since D1 with no
  certificate. The $99/yr Apple Developer Program buys nothing until a build must
  run on a second Mac or reach someone else's hands. The stated distribution model
  becomes built-from-source / ad-hoc signed, with Developer ID documented as an
  upgrade path. Note that a DMG is install ergonomics, **not** trust: an unsigned
  DMG on another Mac still requires System Settings → *Open Anyway*.

- **Viewer fullscreen is real window fullscreen in the shell (Plan 3 D5a).** The
  viewer is already a full-window overlay, so the shell now toggles the native
  window instead of the HTML Fullscreen API, which WKWebView gates behind user
  activation that a native menu item cannot supply. Fullscreen state is tracked
  from the window itself — a resize watcher reads the real state and broadcasts
  `cairndex://fullscreen` on change — so transitions the app never requested (the
  green zoom button, Mission Control) are picked up too, and a read taken
  mid-animation self-corrects. Escape leaves fullscreen before closing the viewer,
  including on image bundles, which have no player. Browser behavior is
  unchanged.
- **Left click toggles playback (Plan 3 D5a).** Clicking the video plays/pauses
  it, matching every other player. Right click no longer hijacks play/pause and
  is left available for viewer context-menu actions.
- **Window state no longer restores fullscreen or visibility (Plan 3 D5a).**
  Size, position, and maximized state still persist. Restoring fullscreen would
  relaunch into an empty fullscreen window after quitting from a fullscreen
  viewer, and restoring visibility could relaunch the app with no window at all.

### Fixed

- **Grouping suggestions respect multiple bundle stems in one directory.** The
  suggester now partitions fresh files by stem before matching each group to a
  confirmed bundle, so one confirmed owner no longer absorbs every new video in
  its directory. Balanced matching folds trailing rendition labels such as
  `- 720p`, allowing a version to target an otherwise-identical existing bundle
  and expose the reversible existing/new destination control. Grouping review
  adds persisted per-directory Narrow/Balanced/Widen controls, and regenerated
  plans are seeded into the query cache immediately so **Suggest grouping** no
  longer flashes or remains as an empty suggestion list while candidates exist.

- **D4 review hardening (Plan 3).** Dragging a folder or a non-media sidecar in
  from Finder alongside media no longer aborts the whole add: the reverse-map maps
  only regular files (directories count outside) and the manual-bundling apply
  skips and reports non-linkable paths (`files_skipped`, surfaced in the dialog
  message). A drop is now ignored while any modal/viewer is open (so it can't
  silently re-seed an open Create Bundle dialog), while the mapping is still
  resolving (deferred, not mis-reported unmapped), and while the app's own
  drag-out is in flight (self-drop guard). A bundle drag validates each library's
  mount once instead of per file; `start_file_drag` awaits its result over an
  async channel instead of blocking a worker; drag failures carry drag-specific
  error codes; a file-less bundle cover is no longer a drag source; and a File
  Browser list row becomes a drag-out source only once selected, preserving
  rubber-band selection from a row. The W5 copy-in seam is offered the un-addable
  remainder of every drop (including mixed drops). A second review round then:
  reports manual-bundling skips by reason (`skipped_non_media` / `skipped_missing`
  / `skipped_already_bundled`) and skips confirmed-bundle members instead of
  aborting; aligns the Create Bundle preview with apply's media filter (an
  all-non-media selection previews empty and the dialog explains it); categorizes
  the reverse-map into inside / outside-absolute-paths / directories, so the W5
  seam gets exactly the outside files and an in-library folder gets its own
  message; tags each drag-out with an id so a stale ended event can't clear a
  later drag's self-drop guard (with a grace window, a drop-lands-on-us belt, and
  a timeout); and ignores drops behind an open context menu or toolbar popover too.

- **D3 review hardening (Plan 3).** Host handoff commands
  (`reveal_file`/`open_file` and the mapping store commands) are now async and
  run mount-touching filesystem work off the webview IPC thread, so an offline
  or slow SMB mount can no longer freeze the desktop UI. Mappings persist the
  manifest UUID proven at locate time and every reveal/open re-reads
  `.cairndex/manifest.json` and requires a match, so a volume remounted with
  different content is rejected as `library_mismatch` instead of handing off
  another library's files (pre-release root-only mapping entries surface as
  unmapped and need one re-locate). The web layer now owns the user-facing
  copy for the shell's structured error codes.

### Added

- **ADR-0018 (accepted): library ownership lease and desktop local-server
  sidecar.** Records the single-server-per-library enforcement design: an
  active-owner lease file inside `.cairndex/locks/` (write-then-verify
  acquisition, heartbeat watchdog, confirm-on-stale-takeover, unmount on lost
  ownership), the desktop shell's future managed local server for opening
  local library folders without server administration, the portability
  invariant that keeps `registry.db` free of authoritative library state, and
  the supported one-active-machine-at-a-time semantics (plus SQLite
  checkpoint/snapshot hygiene) for cloud-synced libraries. The work heads
  build-order phase F (`docs/plans/README.md`), ahead of the write-mode
  slices, and plan 3 gains milestone D6 for the sidecar. Documentation only;
  no behavior change.

- **Desktop drag-out and drag-in (Plan 3 D4 / §6).** A mapped desktop library
  can drag its real files out to Finder and other apps from the File Browser
  cards/rows, the opened bundle album tiles, the File inspector, and the bundle
  inspector — whose cover drags the whole bundle (all its files) and whose
  "Files in bundle" rows each drag that file. The shell resolves and validates
  every path exactly as reveal/open do; the web layer never handles an absolute
  path. Files dropped from Finder that resolve inside the mapped library are
  reverse-mapped to relative paths and seed the existing Create Bundle fast-add
  flow; files outside every library are told that Cairndex links files in place
  (move them into the library first), and an unmapped library is told to locate
  itself. The outside-files branch is the explicit seam for the plan 4 W5
  copy-into-library flow. Plain web keeps every drag capability inert. Internal:
  the shell adds the cross-platform `drag` crate (the engine behind
  `tauri-plugin-drag`) and depends on it directly rather than the plugin, so
  drag-out path resolution stays in Rust instead of passing absolute paths to
  the web layer; drag-in uses Tauri's built-in `dragDropEnabled` webview event.

- **Desktop library mappings and safe host handoff (Plan 3 D3 / ADR-0007).**
  Settings → Libraries can locate each server library on the desktop through a
  native folder picker. Rust reads the picked `.cairndex/manifest.json`, requires
  its portable UUID to match the server library, and stores the canonical root
  by registry id in shell configuration. Mapped File Browser entries, bundle
  files/current bundle media, and FileInspector expose per-OS reveal/default-app
  actions; plain web and unmapped libraries expose none. Every action carries
  only an id plus a server-provided relative path. Pure-Rust validation rejects
  empty, absolute, current/parent-traversal, missing, and symlink-escaping paths,
  reports offline roots as `volume_not_mounted`, and invokes the cross-platform
  opener plugin only after canonical containment and existence checks pass.

- **Desktop platform seam and pairing auth (Plan 3 D2).** The shared SPA now
  exposes one OS-neutral `HostPlatform` boundary with web no-ops, Tauri-backed
  desktop calls, capability flags, and per-OS labels. Shell Settings can
  start and poll ADR-0015 pairing, bind the one-time token plus approved library
  ids to its issuing server, forget that local pairing, and attach the bearer
  only to granted library paths. Unscoped unprotected libraries stay anonymous;
  unscoped protected libraries offer pairing instead of the browser cookie form.
  Programmatic calls use platform fetch; ADR-0017's fixed-target loopback relay
  supplies media/HLS/thumbnail/preview/storyboard/subtitle URLs with rotating
  capability paths, exact origins, read-only route and scope checks, no
  redirects, bounded stalls/concurrency, and non-chunked known-length 206
  responses. Plain web retains same-origin URLs, cookies, and false native
  capabilities.

- **Tauri 2 desktop shell bootstrap (Plan 3 D1, ADR-0012).** A new
  `apps/desktop` package hosts the existing `apps/web` Vite server/build without
  a frontend fork, bundles as `dev.cairndex.app`, and provides first-run server
  URL configuration in the Tauri store. Cross-platform store, window-state, and
  single-instance plugins own shell persistence; native App/File/Edit/View/
  Window/Help menus dispatch semantic events onto existing SPA settings,
  pairing, bundle, surface, zoom, pane, and fullscreen handlers. Desktop API,
  nested playback/media URLs, and close-time progress reporting resolve against
  the configured server while browser mode remains same-origin. CI now checks
  Rust formatting, Clippy, and tests on macOS and Ubuntu and builds the macOS
  `.app`; the portable shell contains no target-OS conditionals, AppKit, or
  `NSWorkspace` calls.

- **Device pairing and scoped bearer tokens (Plan 2 §4 / T0, ADR-0015).**
  Anonymous clients start a bounded ten-minute six-character pairing request;
  an ADR-0010-authorized web session approves explicit library scopes, and the
  first approved poll receives a 256-bit opaque token exactly once. Only salted
  token/code/poll-key hashes are stored. The additive registry `device_tokens`
  table records device name, scope, creation/last-used times, and revocation;
  usage writes are throttled to once per minute. Library content and scoped
  streaming gates accept `Authorization: Bearer` alongside browser cookies,
  close registry sessions before streaming, reject revoked/unknown tokens with
  structured 401 and out-of-scope use with structured 403, and preserve
  anonymous access for passphrase-less libraries. Settings → Devices lists,
  approves, and revokes devices. Health now advertises `api_features` including
  `trickplay`, `hls`, `progress`, and `pairing`.

- **Reversible grouping destinations.** A re-scan addition still recommends its
  existing confirmed bundle by default, but grouping review can switch that same
  proposal in place between the existing target and a new bundle without losing
  selection, file order, collection placement, or an edited new-bundle title.
  New mode receives normal bundle roles and remains applicable if the old target
  disappears; existing mode retains the current addition behavior. The
  choice and target-title snapshot are additive persisted plan fields exposed by
  a library-scoped destination endpoint. Bundle and collection rename fields now
  match their rendered title width and grow live up to the review-dialog edge.
  The destination switch is a compact circular-arrows icon beside the title with
  an immediate state-specific tooltip; numeric confidence and manual badges are
  removed, and wrapped metadata stays aligned to the title column. Existing
  targets read **Add to 🎬 [bundle name]** with tighter drag-handle spacing, and
  the destination icon no longer remains highlighted after activation. Relevant
  existing collection branches now remain visible, letting a new-bundle
  override inherit or change collection placement without reopening confirmed
  bundles. The hidden top-level drop target no longer reserves blank space above
  the suggestions. Bundle and collection rename editors now wrap through their
  live sizing mirror and focus without scrolling. Destination switches stay
  mounted but disabled during rename, and title buttons share the editor's line
  height, preserving every bundle row and the modal's position on activation.

- **Grouping-review drag-and-drop editing.** Files can be dragged to an exact
  position within any bundle suggestion or moved into another suggestion;
  bundles can be dragged into any suggested collection or back to the top level.
  The open plan persists these edits through the new file-move and bundle-parent
  routes, and apply preserves existing bundle identities while realizing an
  explicit cross-bundle move. Untouched confirmed groupings retain their prior
  conflict protection. New suggestions still default to video, then audio, then
  image, then remaining files while retaining natural order within each group.
  All edits are metadata-only; source files are never changed.

- **One remembered media location per bundle.** A new additive
  `bundle_cursors` table stores the current ordered image/video independently
  from bundle metadata; `PUT /bundles/{bundle_id}/cursor` updates it without a
  version bump. The viewer opens that file, retains per-video timestamps in the
  existing progress table, and persists image positions as file-only cursors.

- **Grouping suggestion inline rename.** Double-clicking a bundle or collection
  title in grouping review now opens an inline field; Enter or blur saves and
  Escape cancels, with Enter/F2 available from the focused title. Renames persist
  on the open grouping plan through the library-scoped
  `PATCH /grouping/plans/{plan_id}/proposals/{proposal_id}` route, and the edited
  title is used by **Accept selected**. An addition remains read-only while it
  targets an existing bundle, but becomes renameable when switched to create a
  separate bundle. No source file is renamed or otherwise changed.

- **Eagle-style thumbnail hover video preview (Plan 1 M12).** Video bundle
  covers and linked video file cards now wait for a ~500 ms mouse dwell before
  mounting a muted direct-play preview. Storyboard indexes prefetch after a
  150 ms sub-dwell: cursor motion pauses the still-mounted video beneath the
  proportional sprite and performs no video seeks. After 250 ms rest, one video
  seek lands at the displayed sprite's sampled timestamp; the sprite remains on
  top until the sought frame is presented, then live playback resumes from it. Without a
  cached board, the seek uses the exact cursor position while the paused frame
  stays visible during motion. A
  click-isolated mute toggle remains
  available, and a shared page-wide owner guarantees one active preview. Leave
  or virtualized unmount clears the media source and reloads the element so
  range traffic stops. Non-direct MKV/codec combinations use the same sprite
  path; hover never calls playback-decision or HLS session routes. Touch/coarse
  pointers, drag-select, native DnD, context menus, missing/unprobed files, and
  audio cards preserve the static card; an image bundle cursor overlays its
  still image without starting media playback.

- **Player interaction polish (Plan 1 M9).** Video-surface right-click toggles
  play/pause; seek step (2/5/10/30 seconds) and pitch preservation are persisted
  player preferences; seek step and speed use compact settings sliders, with
  the pitch toggle beside speed instead of a separate control-bar selector; file
  loop is session-only and takes precedence over bundle auto-advance; frame step
  now uses `<`/`>` and speed uses `,`/`.`. Resolution caps live in a foldable
  submenu built from the probed source height, exposing 2160p/1440p for
  applicable files while omitting tiers above the source. Settings section
  titles share one compact uppercase visual hierarchy.
  The folded Resolution disclosure uses a vertically centered 24px row and expands
  only when its choices are visible.
  Cover actions use a stable two-button row: Set frame as cover and Reset cover
  to default, with reset disabled until a custom frame exists.
  The settings menu can set the current server-decoded video frame as the file
  and bundle cover, or clear it back to the previously selected/automatic cover.
  Additive `asset_files.cover_time` and prior-cover metadata plus POST/DELETE
  `cover-frame` endpoints are path-safe and regenerate only cached thumbnails;
  originals remain untouched. Requests at or just past reported duration clamp
  to a decodable frame immediately before EOF.

### Changed

- **File order is now playback order.** Initial open, previous/next, and
  end-of-video advance follow the Files in bundle sequence and skip file types
  without a viewer stage. The primary-file API/inspector control and primary
  playback/cover fallback are removed; the old database column remains unused
  for compatibility, and legacy `primary_video` roles display simply as video.

- **Short-clip storyboards.** The default
  `CAIRNDEX_STORYBOARD_MIN_DURATION` is now 10 seconds instead of 60 so hybrid
  card skimming has sprites for typical short clips. The format-v2 regeneration
  below also backfills cached boards for 10–60 second videos.

- **Storyboard cache format v2.** Sampling now anchors at t=0 and rounds to the
  source frame active at each cue boundary. The index fingerprint sidecar
  carries the format marker plus source fingerprint, so manifest checks do not
  read the full VTT; VTT responses revalidate, while sheet URLs version on the
  same inputs. Unversioned, v1, and pre-sidecar-marker indexes are stale by
  design; existing libraries need one Update/storyboards run to regenerate all
  boards. That run also performs the
  10–60 second backfill above.

### Fixed

- **Desktop D2 auth and relay review hardening.** Desktop no longer sends one
  scoped bearer to every library on its server, mounts a workspace after auth
  status fails, or presents a nonfunctional passphrase form in WKWebView.
  Pairing poll now returns the immutable grant used by both JSON and media
  transports. The relay no longer exposes write methods or general API paths,
  follows redirects, reflects arbitrary origins, leaves stalled reads unbounded,
  chunks large known-length ranges, or panics directly on startup failure. The
  previously stale generated TypeScript contract now includes the auth-status
  Authorization header and pairing scopes. Unused D2 keymap scaffolding was
  removed until D5 has real shortcut consumers. Desktop exit now awaits HLS
  session DELETE through the scoped fetch transport instead of sending a POST
  beacon into the read-only media relay; browsers retain the existing pagehide
  beacon. A failed re-pair also leaves the still-valid paired state visible.

- **Desktop D1 review hardening.** The Vite development origin is denied unless
  explicitly configured through `CAIRNDEX_CORS_EXTRA_ORIGINS`, and cross-origin
  cookie credentials are no longer advertised. Native fullscreen now toggles
  the Tauri window without relying on synthetic DOM activation. Window close,
  Cmd+Q, and OS application exit now share the Rust `ExitGate`; desktop waits
  for the ordinary typed progress PUT before flushing synchronous `pagehide`
  state and completing exit, while browser mode retains its same-origin typed
  JSON beacon. Explicit grid placement keeps the content pane usable when its
  persisted sidebar toggle is off. Locked-library screens continue to render
  Settings opened from the native menu instead of swallowing the action. The
  macOS bundle opts only webview content into cleartext HTTP and declares local
  network access so an owner-configured private LAN server works outside the
  localhost ATS exemption. Desktop modules are lazy chunks outside the browser
  entry, workspace-only menu items disable without a library, both Rust CI jobs
  cache their Cargo builds, and generated API artifacts retain the typed progress
  contract. Final review follow-up gives the network-backed exit flush a
  five-second watchdog, lowercases configured CORS origin authorities, and
  reports desktop chunk/menu bridge failures instead of leaving blank or silent
  UI. Bootstrap keeps Settings useful by selecting the server URL, disables Pair
  Device until connection succeeds, rejects HTTP 200 endpoints without the
  Cairndex capabilities D1 requires, and restores menu availability afterward.
  Native menu polish uses the physical `=` key for card-size increase and a
  cross-platform macOS-compatible Toggle Full Screen accelerator/label.

- **Device pairing security and review hardening.** Only Bearer-scheme
  authorization headers select device-token auth, so upstream Basic credentials
  no longer suppress a valid browser unlock cookie. Existing but unreadable,
  corrupt, or malformed manifests fail closed. Pairing starts are capped per
  source and reject capacity without evicting pending approvals; token rows are
  committed outside the pairing lock before one-time state is consumed.
  Unavailable libraries no longer prevent emergency device revocation, while
  adding or replacing a passphrase revokes every live token scoped to that
  library. Settings filters unavailable scopes, accepts only the unambiguous
  code alphabet, surfaces FastAPI validation detail, clears stale approval
  state, and polls only while waiting for an approved device to collect its
  token instead of throughout every Settings session.

- **Repeated grouping suggestions no longer reopen bundled files.** Manual
  **Suggest grouping** and Update now share the same durable confirmation
  boundary: confirmed bundles stay settled even when they do not belong to a
  collection. Regenerating inside grouping review only proposes still-unbundled
  files and new additions instead of switching to a broader categorization
  pass.

- **Empty grouping suggestions deselect after drag.** Moving the final file out
  of a bundle suggestion now clears and disables its acceptance checkbox. Moving
  the last file-backed bundle out of a suggested collection does the same for
  that collection, including recursively empty nested collections.

- **Flat-directory video artwork pairing.** Grouping heuristic v4 now matches
  sidecars against a unique normalized full video stem before using the coarse
  leading-name prefix. Long filenames that share an author/source prefix but
  differ by subject therefore produce one bundle per video with its matching
  image, while image-only folders remain split into individual items.

- **Image artwork no longer disables bundle hover scrub.** Static cover artwork
  and current media are resolved separately. A card with an image cover now
  previews the bundle's remembered video from its resume position; an image
  cursor appears as a still. Double-click uses the same cursor, so hover and
  opening cannot disagree about which media is current.

- **Missing files reconcile on bundle and directory access.** Bundle file-list
  and playback-manifest reads re-check every linked member of that bundle, while
  each File Browser directory read compares only the linked rows indexed to that
  directory and persists vanished paths as missing. The latter reports how many
  rows changed so the web client refreshes Bundle Browser and sidebar counts
  only when needed. The Missing Files value remains a compact numeric count of
  affected bundles, and the inspector's Files in bundle section reports its
  missing-file count and highlights/badges each missing member. The viewer gives
  missing state precedence over stale codec/container fallbacks. These bounded
  checks do not guess which unlinked path replaces a missing row; Update/scan
  remains responsible for high-confidence moved-file repair.

- **Scan reports the linked missing-file total.** Update and standalone Scan now
  show a completion message with the number of linked files that remain missing
  after reconciliation. This is the full persisted total, not only files newly
  marked missing during the latest run.

- **Collection counts include nested bundles.** Sidebar and collection-card
  counts now roll up distinct bundles from the collection’s entire descendant
  subtree. A bundle assigned to more than one nested collection is counted once
  for each ancestor, while empty collections still report zero.

- **Storyboard-to-video frame alignment.** Resting after a sprite skim now
  uses format-v2 sprites because ffmpeg's prior default `fps` timing could put a
  neighboring source frame in a tile whose VTT cue named the interval boundary.
  Sampling now anchors at t=0 and selects the frame active at each cue start.
  Rest resolves the current cue after the debounce, seeks once to that start,
  waits for the paused target frame beneath the sprite, and only then hands off
  to live playback. Cards without a storyboard retain exact cursor-time seeking.

- **Stable hover-preview frame handoff and geometry.** Direct previews now keep
  the cover or storyboard visible until both the seek completes and the browser
  reports that the paused target frame has been presented. Browsers without the
  callback API use seek completion as the best frame-ready signal; an exposed
  callback that omits its post-seek notification has a bounded fallback. Stale
  and late `seeked` events are ignored until `currentTime` reaches the requested
  target. Revealing the paused frame and resuming playback now occupy separate
  paint/task turns, while dwell and rest callbacks are identity-checked so stale
  callbacks or repeated activation cannot reset an already playing preview.
  Static video covers, storyboard crops, and live video now share one contained,
  black-letterboxed viewport, so
  portrait media is pillarboxed and transitions no longer stretch or shake the
  card. The card storyboard explicitly clips the 5×5 sprite sheet to the chosen
  cue before letterboxing, preventing adjacent rows from bleeding into the
  black bands. Hover activation starts from incomplete saved progress when
  available; completed, zero, and absent progress still start at the beginning.

- **Stable hover-preview resume and controls.** Returning from sprite skimming
  now waits for the one resting video seek and paused target-frame presentation,
  then removes the sprite and resumes playback. The sprite (or static cover when
  no board exists) stays over stale/first frames. A readiness check prevents a missing no-op
  `seeked` event from leaving playback stuck, and transient unmuted autoplay
  rejection retries without incorrectly demoting the card to storyboard-only.
  An intentional skim pause can no longer turn its pending initial `play()`
  cancellation into a false decode failure.
  The clock remains anchored at the lower right in every preview state, with
  the speaker control immediately to its left.

- **M12 review hardening.** Bundle hover gating now uses the cover file's
  probe-backed relative path, ffmpeg container list, video codec, and audio
  codec instead of an unpopulated MIME column; direct preview therefore works
  for real MP4-cover summaries and rejects unsupported audio. Direct playback
  rejection or decode failure falls back to cached storyboards, menu/drag hover
  guards can recover without pointer exit, and album tiles restore Space/Enter
  selection semantics. The unbundled File Browser query again filters hidden
  relative paths and sorts by path after its file-id projection changed. The
  final hybrid interaction supersedes motion-seek throttling: hover performs no
  video seek until the cursor rests, while SeekBar keeps its leading/trailing
  throttle helper.

- **M12 hybrid review hardening.** Hover now has one explicit skimming →
  transitioning → playing phase model and a 5-second metadata-readiness bound;
  a stalled direct source demotes to its storyboard instead of hanging. A
  150 ms storyboard-prefetch sub-dwell prevents rapid grid sweeps from issuing
  VTT requests. Resume-position filtering is shared across bundle and File
  Browser summaries, and storyboard freshness checks read only their small
  format-bearing fingerprint sidecar. The real-backend Playwright fixture waits
  for its own uvicorn process, a servable VTT plus first sheet, the playing
  phase, and page-request teardown instead of fixed sleeps or cross-worker port
  responses.

- **Parallel hover-preview verification.** The real-browser hybrid test now
  records the last committed skimming state instead of racing the 250 ms rest
  debounce, and it leaves the card by hovering a known outside tab instead of
  moving to an unverified viewport coordinate. A hook regression also pins
  teardown after the aligned target frame has queued its reveal but before that
  animation frame runs.

- **Seek drag teardown on unmount.** `SeekBar` now reports
  `onDragChange(false)` from its shared listener cleanup, so switching files or
  unmounting mid-drag cannot leave the player controls pinned visible.

- **M9 review hardening.** Ended playback is latched per transition so effect
  identity changes cannot skip a second file or make a loop toggle restart an
  already-ended video. Inspector/viewer cover URLs now version from bundle
  timestamps. Cover operations share `useFileMutations`, retain their optimistic
  file row, and refresh only version-bearing bundle/browse/collection data.
  Storyboard `showinfo` parsing strips ANSI; missing counts warn and fall back to
  emitted-sheet capacity. Collection cover refreshes reverse-walk only direct
  memberships, ancestors, and explicit selectors instead of every collection.
  Seek-bar window listeners are removed on unmount.

- **Collection covers refresh after a custom video frame is selected.** Setting
  or clearing a file cover now refreshes every collection whose explicit or
  auto-picked effective cover is that bundle, including ancestor collections.
  Collection thumbnail URLs use the refreshed collection timestamp, so the
  browser requests the regenerated image even when the bundle id is unchanged.

- **Off-track drag scrubbing and storyboard tail tiles (Plan 1 M9).** Seek-bar
  drags now retain capture through window-level pointer tracking and pin the
  control bar visible until release, preserving the existing 150 ms seek
  throttle and exact release commit. Storyboard generation counts sampled
  frames from the same ffmpeg pass and trims VTT cues before final-sheet padding
  tiles when stream duration is shorter than container duration.

- **Registry-pool exhaustion under drag-seek aborts (root cause of unreliable
  scrubbing).** Even after the content session was scoped, `get_library_access`
  still took the `get_registry_db` **yield** dependency, so every streaming
  request pinned a _registry_ connection until the body finished — and when a
  client abort cancels the request task, FastAPI never runs the yield-dep
  teardown at all, stranding the connection until GC (verified empirically on
  FastAPI 0.138). Drag-seeking aborts dozens of in-flight range requests, so
  the registry QueuePool (size 5 + overflow 10) drained: new gates blocked 30 s
  at resolution, `/stream` 500ed mid-drag, and Chrome's demuxer surfaced
  `PIPELINE_ERROR_READ` fatal media errors — reproduced live against a real 4K
  file and eliminated by the fix (600-request abort storm: pre-fix 240
  QueuePool tracebacks, post-fix zero). The gate now opens the registry session
  imperatively inside the sync dependency (cancellation-immune) and closes it
  before returning. The other burst-aborted `FileResponse` routes — previews,
  storyboard index/sheets, subtitle VTT, bundle/file thumbnails — moved to the
  same scoped `LibraryAccess` gate. A regression test drives the real,
  unoverridden dependency chain and asserts neither pool has a connection
  checked out once the body streams.

- **Silent player freeze when a load wedges (load watchdog).** A range request
  stuck on a half-open connection (e.g. after a proxy/server reset mid-drag)
  never produces a media `error` event, so the player used to sit on a black
  frame at `readyState 0` forever. A 15 s load watchdog now treats a source
  that never reaches metadata as a stage error: the bounded recovery path
  reloads on a fresh connection, and an exhausted budget surfaces the retryable
  "Playback interrupted" card. Verified live against a never-responding server:
  wedge → automatic reload → playing at the same playhead in one pass.

- **Native-recovery burst guard.** While a native recovery decision is in
  flight, additional `error` events from the dying pipeline (and continued drag
  seeks on the errored element) no longer each consume a recovery slot — one
  failure burst spends one slot, mirroring the HLS re-attach guard.

- **Playback DB-pool exhaustion under drag-seek.** Media byte-streaming routes
  (`/files/{id}/stream`, `/files/{id}/content`, HLS session artifacts) held a
  per-library **and** registry DB connection for the _entire_ response body,
  because their `LibrarySession` was a `yield` dependency FastAPI keeps open
  until the last byte is sent. Dragging the scrub bar fires many overlapping
  range requests, so the held connections drained the QueuePool; new requests
  (including the next `playback-decision`) then blocked for the 30s pool timeout
  and failed with a `QueuePool` 500, leaving the viewer stuck on "Preparing
  playback…". A new `LibraryAccess` dependency does the same registry/lock gate
  but hands back a short-lived `session()` scope that resolves the path and
  releases the connection _before_ the response streams — so no connection is
  pinned during transfer. A regression test asserts the per-library pool has
  zero checked-out connections mid-stream.

- **Finite playback-decision timeout.** The web player caps an unanswered
  `playback-decision` request (15s) instead of spinning on "Preparing
  playback…" indefinitely. On timeout — or a 5xx from an overloaded server — a
  non-degradable video now shows a distinct, retryable "Playback server is
  unavailable" card; directly-playable sources still fall back to the native
  stream.

- **Coalesced drag-seek requests.** Scrubbing the seek bar throttles the actual
  `seek()` (leading edge + a single trailing flush per ~150ms) and commits the
  exact position on release, instead of firing a `seek()` on every `pointermove`.
  The thumb and storyboard tooltip still track the pointer live, but a drag now
  issues a handful of byte-range requests rather than dozens of immediately
  cancelled ones.

- **Native playback error recovery.** A transient media error on a direct-play
  video — e.g. a range read that stalls or drops while seeking into an unbuffered
  region (common on network storage or heavy 4K decode) — used to dead-end on an
  unrecoverable "Preview failed" card with the controls gone. Native playback now
  reloads at the current playhead up to three times (mirroring the HLS re-attach
  budget, refunded on healthy progress) before giving up, and the terminal state
  is a retryable "Playback interrupted — Try again" card instead of a dead end.

- **Immediate library switching.** Changing the active library now removes the
  previous library's TanStack content queries before remounting the workspace,
  while preserving the global library registry and library-keyed auth caches.
  The Bundle Browser, counts, collections, tags, and other shell data refresh
  immediately instead of showing the old library until a page reload or cache
  expiry.

- **Network-library scan overflow.** Scanner filesystem identities now preserve
  unsigned 64-bit `st_dev`/`st_ino` values in SQLite's signed 64-bit integer
  range, preventing `Python int too large to convert to SQLite INTEGER` during
  **Update** while retaining exact same-filesystem moved-file repair.

### Added

- **Pinyin-aware local search.** Tag and collection pickers now match Chinese
  names from full pinyin, initials, partial pinyin, mixed Latin/pinyin, and
  polyphonic readings while preserving ordinary case-insensitive substring
  search and literal create-name semantics. The same shared matcher covers the
  All Tags page, tag filters, multi-bundle tag/collection pickers, File Browser
  names, and local file-selection filters. `pinyin-pro` is bundled offline as a
  lazy chunk; the server-backed whole-library FTS toolbar remains unchanged.

- **Multiple notes per bundle.** A bundle now carries an ordered list of
  freeform note/description blocks instead of a single note. The inspector
  renames the section to **NOTES** with a small `+` icon that appends another
  note box below the current ones; each box commits on blur and can be removed
  (hover ×). No predefined roles — the blocks are just clean separators. Note
  boxes auto-grow to fit their text by default (no scrollbar); only an explicit
  drag of the small bottom grip sets a fixed height (with a scrollbar when the
  text overflows, and no native resizer/scroll-corner box) — a stray click on
  the grip no longer locks the box out of auto-expand. Each note remembers its
  own height across sessions (`cairndex.noteHeights`, per bundle, aligned with
  the notes list). Double-clicking the grip returns that box to auto-fit.
  New `asset_bundles.notes` JSON column (added additively via
  `ensure_content_indexes`) is the single source of truth, exposed as
  `notes: string[]` on `BundleRead` and accepted on `BundleCreate`/`BundleUpdate`
  (OpenAPI + `schema.d.ts` regenerated). The `notes` filter now compiles to a
  per-note `EXISTS` over `json_each(notes)` and the `bundle_search` FTS index
  concatenates the notes, so both text search and the Notes filter match across
  every note. (Early-dev cleanup: the previous single `note` column/field and
  its compatibility shim were removed rather than kept as a shadow; libraries
  created earlier keep a harmless unused `note` column.)

### Changed

- **Roadmap re-sequenced (docs only, owner decision 2026-07-10).** Plan 1
  M8/M10/M11 (subtitle depth, web video wall, media exports) deferred to a
  future bucket; new order is M9 player polish → pairing/device tokens →
  macOS desktop shell (plan 3) → library write mode (plan 4, W5
  import-external promoted right after W0/W1 so Finder drag-and-drop into
  the app lands early) → Android client (plan 2). Plan 3 gained §2.1
  documenting the cross-platform posture that keeps a future Linux shell a
  packaging exercise rather than a port. Revised 2026-07-11: M9 recomposed
  into interaction polish (right-click play/pause, drag-scrub off-track fix,
  seek step, pitch-preserve, file loop, frame-step rebound to `<`/`>`,
  set-cover-to-frame) — range loop moved
  to M11 as the GIF range-picker, video adjustments (reframed color/tone)
  and slideshow deferred; new M12 Eagle-style thumbnail hover video preview
  specced (plan 1 §13) between M9 and the desktop shell.

- **Standalone Update stages.** The library maintenance overflow now exposes
  **Generate storyboards** alongside **Scan new files**, **Suggest grouping**,
  and **Collect metadata**, so every stage performed by **Update** has an
  independent trigger. Storyboard completion also refreshes cached playback
  manifests so newly generated trickplay becomes visible immediately.

- **Terminology: "Collection/Bundles View" → "Bundle Browser", "File View" →
  "File Browser" (breaking API rename).** Renamed the two browsing surfaces
  across the product. Breaking API change: the read-only filesystem route
  `GET .../file-view/entries` is now `GET .../file-browser/entries`, and the
  OpenAPI schemas `FileViewEntryRead`/`FileViewListingRead` are now
  `FileBrowserEntryRead`/`FileBrowserListingRead` (OpenAPI + `schema.d.ts`
  regenerated). Internal renames: backend `services/file_view.py` →
  `file_browser.py` (`FileViewEntry`/`FileViewListing` → `FileBrowser*`),
  `api/schemas/file_view.py` → `file_browser.py`,
  `previews.file_view_preview_cache_path` → `file_browser_preview_cache_path`;
  web `app/FileView.tsx` → `FileBrowser.tsx` (component + `useFileView` →
  `useFileBrowser`, `fileViewPreviewUrl`/`fileViewContentUrl` → `fileBrowser*`,
  `.file-view` CSS → `.file-browser`), and the `file-view` query keys →
  `file-browser`. Docs/prose updated (incl. the formal product-brief and
  architecture concepts). Preserved: historical branch names
  (`feat/collection-view`, `feat/collections-and-file-view`) and the stable
  ADR-0007 filename slug (its title/body now read "File Browser"). No
  behavior change; the surfaces work identically under the new names.

### Internal

- **Full-stack Playwright CI partition.** Browser-only Playwright coverage stays
  in the Node-only frontend job, while tests tagged `@fullstack` run in a
  dedicated job with Chromium, ffmpeg, `uv`, and the locked backend environment.
  This keeps frontend checks independent of Python while ensuring the Devices
  pairing, real storyboard-job, and real MKV-remux flows execute in CI instead
  of failing or skipping for missing backend tooling.
- **Docs reconciliation through media-player M5 (docs).** Marked plan 1 M5
  merged (#5, M6 next), retitled the `docs/STATUS.md` M5 section from "Current
  branch" to "Merged" and recorded the second review fix pass (discrete-tier
  effect keying + displayed-tier e2e assertions) with its independent live
  verification, and updated the README feature summary ("fullscreen image
  lightbox" → zoom/pan image viewer with progressive previews and
  HEIC/TIFF/BMP openability).
- **Docs reconciliation through media-player M4 (docs).** Marked plan 1 M3/M4
  merged (M5 next) and folded in the M9 storyboard padding-tile follow-up;
  refreshed the `docs/architecture.md` status header (was "PR 36"); updated the
  README feature summary to cover the custom media viewer, storyboard
  trickplay, and watch progress/resume; and cleaned up `docs/STATUS.md`
  (stacked "Latest session" headers → "Merged"/"Earlier", the "Next recommended
  tasks" list now points at M5, and the stale "Current milestone" section is
  marked historical).
- **Plan 1 milestone re-sequencing (docs).** After M2 shipped, the owner
  deprioritized subtitle depth: the subtitle-upgrade slice (embedded
  extraction, track menu, styling/timing) moved from third to M8 (after HLS),
  and dual simultaneous subtitles became a far-deferred M9+ item. New order:
  M3 storyboards, M4 watch progress, M5 image viewer v2, M6 HLS sessions,
  M7 web HLS, M8 subtitles. Milestone references in code comments updated.

### Added

- **Web HLS integration — MKVs now play in the browser via remux/transcode
  (Plan 1 M7, ADR-0014).** The web player consumes the M6 decision + session
  foundation, so a source the browser can't play directly is streamed over a
  server remux/transcode HLS session. Browser-verified end to end: an **MKV/H.264
  remux** session and a **480p libx264 transcode** session both play through the
  hls.js engine, and the **native-HLS** path plays in WebKit. HEVC and other
  transcode-only _sources_ route through the same session machinery but have not
  yet been run end to end, so they are not claimed as verified.
  - **Client capability profile** (`viewer/player/caps.ts`): computed once at
    startup and memoized, probing `HTMLVideoElement.canPlayType` **and**
    `MediaSource.isTypeSupported` for containers (mp4/webm), video codecs
    (h264/hevc/vp9/av1), audio codecs (aac/mp3/opus/vorbis/flac), and
    `native_hls` (Safari/WKWebView). Only probe-confirmed formats are
    advertised (AGENTS.md: no untested-format playback claims); `max_height`
    stays null (no browser API reports a decode ceiling).
  - **Per-file playback decision:** when a video starts, `MediaViewer` POSTs
    `.../files/{id}/playback-decision` with the caps profile. `direct` keeps the
    existing native progressive path unchanged; `remux`/`transcode` play the
    session playlist. A failed decision degrades gracefully to the manifest's
    direct stream. `GET /bundles/{id}/playback` stays the playlist manifest.
  - **`HlsEngine`** behind the existing `PlaybackEngine` seam: `native_hls`
    feeds the m3u8 straight to `video.src` (native engine); otherwise a lazy
    `import('hls.js')` (new dependency, shipped as a **separate ~157 kB gz
    chunk** so the main bundle stays flat) attaches over MediaSource. hls.js
    fatal errors surface through the existing fallback/re-attach path.
  - **Session lifecycle:** the session is torn down (DELETE) on player close,
    file switch, and unmount; a POST `.../playback-sessions/{sid}/teardown`
    alias lets `navigator.sendBeacon` reap it on `pagehide` (same pattern as the
    M4 progress beacon). A playlist/segment failure (e.g. a session idled out
    during a long pause) or an hls.js fatal transparently re-requests a decision
    and re-attaches at the current playhead (bounded budget, refunded once the
    playhead advances) instead of showing an error.
  - **Quality / audio / burn-in menus:** a settings menu offers a `max_height`
    ladder (Auto/1080/720/480), an audio-track picker (from the decision's
    `audio_streams`), and a burn-in toggle for non-native subtitle tracks
    (`burn_subtitle_track_id`). Switching any of these re-decides and starts a
    new session at the current position (in-stream ABR is out of scope);
    identical params reuse the live session, changed params tear down the old
    one. Watch progress/resume works unchanged over the 1:1 VOD timeline.
  - New POST teardown alias route (OpenAPI + `apps/web/src/api/schema.d.ts`
    regenerated); `hls.js` added as a lazy-only runtime dependency.
  - Review-fix pass (pre-merge): a decision that resolves after its effect was
    torn down (fast open→close) now **reaps** the session the server started
    instead of orphaning it until the idle reaper; the video stage starts in a
    `deciding` state so no frame of the "can't be previewed" card flashes while a
    playable file opens; the decision-failure degrade-to-direct path tears down
    the superseded session first; a capacity (429) decision is retried once
    (short delay) before surfacing the error; a burst of stage errors during an
    in-flight re-attach is swallowed (one budget slot, not a failure); and the
    re-attach budget is only refunded after ~10 s of continuous healthy playback
    so a flapping stream still falls back. Cleanups: shared `BaseVideoEngine`
    for the byte-identical media-delegating methods, one `setParam(key, value)`
    switch setter, a shared `beacon(url, body?)` helper (bodyless, CORS-safelisted
    teardown), a typed `HttpError` carrying the status.

- **Playback decisions + HLS remux/transcode session foundation (Plan 1 M6,
  ADR-0014).** Server-side only; the web hls.js integration is M7.
  - `POST /api/v1/libraries/{library_id}/files/{file_id}/playback-decision`
    (`{caps, audio_stream_index?, burn_subtitle_track_id?, max_height?}`) runs a
    pure decision matrix (`media/playback.decide_playback`) over M1
    `tech_metadata` versus the client's capability profile: container+codecs in
    caps → `direct`; codecs in caps but container not → `remux`; else
    `transcode`. A non-default audio track or unsupported audio codec forces at
    least remux; a burn-in subtitle or an over-height source forces transcode.
    Legacy rows missing M1 keys degrade safely (never 500). The response carries
    `method`, `reason`, `stream_url` (direct) or `session {id, playlist_url}`
    (else), plus `duration`, `audio_streams`, `subtitles`, `chapters`,
    `storyboard_url`, and resume `progress`.
  - New interactive HLS session manager (`media/hls.py` +
    `api/v1/playback_sessions.py`): `POST .../files/{id}/playback-sessions`
    (`{caps, start_s?, ...}` → `{session_id, playlist_url, kind}`), `GET
.../playback-sessions/{sid}/index.m3u8` (VOD fMP4 playlist computed up front
    from the known duration, 6 s target), `GET .../{sid}/init.mp4` and
    `.../{sid}/{n}.m4s` (fMP4/CMAF segments), and `DELETE .../{sid}` teardown.
    One ffmpeg per session writes segments sequentially into
    `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` (server-local ephemeral, never
    inside a library package); a segment ahead of the encoder waits (bounded), a
    far seek kills + restarts ffmpeg at the requested segment. Transcode uses
    `libx264 veryfast` + `force_key_frames` for exact 6 s segments and a capped
    ladder honoring `max_height`, with optional burn-in. Remux copies video with
    an AAC audio fallback and derives its playlist from a one-time keyframe scan
    so advertised segments match where copy-mux actually splits.
  - Bounds/lifecycle: `CAIRNDEX_TRANSCODE_MAX_SESSIONS` (default 2; a structured
    **429** `capacity_exhausted` beyond it), an idle reaper
    (`CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`, default 60 s → kill + delete dir),
    teardown on DELETE and server shutdown, and optional decode-only
    `CAIRNDEX_FFMPEG_HWACCEL` (`vaapi|qsv|videotoolbox`). Session routes reuse
    the `LibrarySession` gate; session ids are random and library-scoped; ffmpeg
    args come only from server-side-resolved paths. Regenerated OpenAPI +
    `apps/web/src/api/schema.d.ts`.
  - Review-fix pass (pre-merge): serve segments without holding the session lock
    across the stat-poll wait (parallel fetches serve concurrently; teardown
    kills ffmpeg promptly); burn-in sessions seek output-side so subtitles stay
    in sync after a far-seek restart; a non-direct decision on an un-probed row
    returns 200 with `session=null` instead of 422; `audio_stream_index` is
    validated whenever supplied (422 on unknown, including un-probed rows); a
    nonzero ffmpeg exit surfaces a structured **500** (`media_processing_failed`)
    instead of a restart→404 loop; a decision retry/reload with identical params
    reuses the live session instead of 429-ing against the bound. New knobs
    `CAIRNDEX_TRANSCODE_SEGMENT_WAIT`, `CAIRNDEX_TRANSCODE_AHEAD_WINDOW`,
    `CAIRNDEX_TRANSCODE_KEYFRAME_TIMEOUT`.

- **Image viewer v2 + preview derivatives (Plan 1 M5).** Added a lazy
  `/api/v1/libraries/{library_id}/files/{file_id}/preview?size=640|1600|2560`
  endpoint that writes deterministic WebP derivatives under
  `.cairndex/cache/previews/{file_id[:2]}/{file_id}_{size}.webp`, validates
  them by quick fingerprint, and serves them with versioned immutable-cache
  URLs. File View also has a path-scoped preview endpoint for unlinked
  non-native images. Browser-native images advance from thumbnail to original
  content; HEIC/TIFF/BMP decode through Pillow + pillow-heif, making
  preview-capable images openable in bundle/file metadata and File View. PSD is
  not advertised as openable until a tested decoder path exists. The web image
  stage now supports fit/fill/100% cycling,
  wheel/pinch zoom to cursor, drag pan, keyboard zoom shortcuts, zoom clamping,
  progressive source swaps, 2560px zoom-in requests, background toggles, and
  source-change transform reset.
- **Watch progress + resume (Plan 1 M4).** Added per-library
  `playback_progress` storage with additive bootstrap, idempotent video progress
  upserts, manifest-embedded progress, a paginated `continue-watching` endpoint,
  and web viewer resume/reporting. The viewer resumes unfinished videos once
  after metadata loads, shows a transient "Resumed at …" restart affordance, and
  reports progress on a throttled cadence, pause/close, and `pagehide` beacon.
  Continue-watching rows now include the in-progress `{file_id, position_s,
duration_s}`, restart explicitly writes position zero, completion requires a
  known duration, and progress `bundle_id` syncs from the central `AssetFile`
  reparent hook.
- **Storyboard trickplay + chapter ticks (Plan 1 M3).** Added a deduplicated
  library-wide `storyboard` background job that generates WebVTT indexes and
  5×5 JPEG tile sheets under `.cairndex/cache/storyboards/`, skipped by default
  for videos under 60 seconds and disable-able with `CAIRNDEX_STORYBOARDS=off`.
  Playback manifests now expose `storyboard_url` and probed chapters; cached-only
  storyboard endpoints return 404 until artifacts exist. The web Update flow now
  runs scan → probe, then starts storyboards as non-blocking background work, and
  the seek bar lazily shows trickplay previews plus visual chapter ticks/title
  text in the hover tooltip. Storyboard URLs and VTT sheet payloads are versioned
  by quick fingerprint and served with immutable cache headers.
- **Probe enrichment for the media-player M1 foundation.** `ffprobe` now stores
  additive `tech_metadata` keys for all audio streams, subtitle streams,
  chapters, HDR classification, and video bit depth while preserving the
  existing width/height/duration/video-codec and embedded-subtitle keys. Probe
  output is version-stamped, so the existing **Collect metadata** job refreshes
  legacy rows once and then returns to incremental skips for current metadata.
- **Unified media viewer + custom direct-play video controls (Plan 1 M2).**
  Bundle double-clicks, the inspector play affordance, and bundle-album file
  opens now use a fullscreen `MediaViewer` with previous/next navigation,
  previous/next controls, info panel toggle, simple image stage, unsupported /
  missing-file fallback cards, and a hand-built video player. Direct-play video
  now has auto-hiding controls, buffered seek/scrub UI with hover time hook for
  future storyboards, play/pause, volume/mute, 0.25–3× speed, external-subtitle
  on/off toggle, PiP, viewer-root fullscreen, snapshot PNG download,
  MediaSession metadata/actions, and the M2 keyboard map. Volume, mute, speed,
  and subtitle-on state persist in the existing `cairndex.prefs` localStorage
  object. No backend API or OpenAPI surface changed.
- **Media viewer playback regression coverage.** The M2 Playwright coverage now
  includes an unmocked tiny ffmpeg-generated MP4 smoke test that verifies real
  `currentTime` advancement and a visible clock update, with a clear skip when
  ffmpeg is unavailable.
- **Client platform & media experience plans (docs only).** New planning suite
  under `docs/plans/` — a first-class web video player & image viewer
  (storyboard scrubbing, embedded-subtitle extraction, watch progress, image
  previews, HLS remux/transcode sessions), a native Android TV client
  (Kotlin/Compose + Media3, multi-video wall) in a future `cairndex-android`
  repo, and a macOS desktop app as a Tauri 2 shell at a future `apps/desktop`.
  Consequential decisions gathered in
  [ADR-0012](docs/adr/0012-client-platform-strategy.md), **accepted
  (owner-ratified) 2026-07-04** after review; the player's UX bar is
  desktop-native players (Movist/Elmedia/IINA), not Eagle's built-in player.
  Post-ratification owner additions: GIF-from-snippet and contact-sheet
  exports (plan 1 §10/M11 — server-side export tasks, download-only,
  desktop-first, TV excluded), and a fourth plan — **library write mode**
  (`docs/plans/04-library-write-mode.md`, owner-prioritized after the core
  player): opt-in per-library gate, trash-first deletion, `file_operations`
  journal, repair-free in-app move/rename, exports-into-library, external
  import; decisions in [ADR-0013](docs/adr/0013-library-write-mode.md),
  **accepted (owner-ratified) 2026-07-04**. Also indexed the previously missing ADR-0011 in the
  ADR README. No code changes.
- **File Browser "Date Added" column + sort.** Entries now carry a creation time
  (`created_at`, from `st_birthtime` where available, else the inode change time),
  distinct from the modified time, shown as its own list column and offered as a
  sort field.
- **Drag hint.** While an item is being dragged, a hint pinned to the lower-left
  reminds you that a plain drop **moves** and holding **⌥ Option copies** (for a
  bundle, adds it to the collection without removing it from the current one).
- **Manual ordering for collections and bundles (drag-reorder + "Clean up by…").**
  Collections carry a manual order shared by the sidebar tree and the
  main-browser folder cards — drag a folder in either surface and both update
  (`PUT /libraries/{id}/collections/reorder`). Bundles gain a **Manual** sort
  (the new default) with drag-reorder (`PUT …/bundles/reorder`); inside a single
  collection the order is per-collection (membership `sort_order`), while
  All/system/descendant views use a global per-bundle `manual_order`. Drag-reorder
  uses **gap insertion** — an accent line shows where the item will slot in
  before/after its neighbour (iOS-home-screen style), never a drop-onto-target.
  A **"Clean up by…"** action (in the folder-section and empty-grid right-click
  menus, and on the sidebar Collections heading) rewrites the whole scope's manual
  order to a chosen sort — collections offer Title A–Z / Z–A
  (`POST …/collections/cleanup-order`), bundles reuse the five toolbar sorts ×
  asc/desc (`POST …/bundles/cleanup-order`).
- **Sort control popover with per-collection memory.** The toolbar sort is now a
  popover holding the sort field, an ascending/descending toggle, and a **Remember
  sort per collection** checkbox; when enabled, each collection/view keeps its own
  last-used sort (persisted).
- **Foldable sidebar sections.** The **Collections** and **Smart Collections**
  headings fold/unfold; the label is a highlighted "text box" with a hover caret.
- **Folder-card context menu + multi-delete.** Right-clicking a collection card
  in the main browser opens a menu with **Delete Collection** (or **Delete N
  Collections** for a Shift/Ctrl multi-selection), mirroring the sidebar; the
  confirm dialog asks about cascading subcollections once for the whole set.
- **Flatten subcollections on "Show subcollection contents".** Inside a
  collection, turning the toggle on flattens every descendant collection into the
  Subcollections section (depth-first, manual order), matching the grid that
  shows the whole subtree's bundles.
- **Shift-range selection** for both bundle cards and folder cards: Shift+click
  selects the inclusive range from the last plain click to the clicked card.
- **Drag collections and bundles between parents.** Dragging a collection onto
  another reparents it (drop on the center) or reorders (drop on an edge), in both
  the sidebar and the main browser. Dragging bundles onto a collection (folder card
  or sidebar row) moves them there — removing them from the collection in view,
  unless **Alt/Option** is held (add without removing). A highlight marks the
  "move into" target; the accent line marks a reorder gap.
- **File selection in the bundle album.** Files inside an opened bundle can be
  single-click selected, drag-selected, and Shift-range selected; double-click
  opens the fullscreen viewer. The right inspector keeps showing the bundle.
- **"Locate in File Browser"** on a right-clicked file in the bundle album jumps
  to the File Browser at that file's folder.
- **Drag-select in list layout.** In list views (bundle + file), pressing and
  dragging over rows now rubber-band-selects them live (previously you could only
  drag-select from empty space, which list rows leave none of).
- **Shift-range selection for files** in the File Browser.

### Changed

- **Media viewer preferences and dev-server tooling.** Player preference updates
  now flow through the single app-level `cairndex.prefs` writer with functional
  updates, debounced localStorage persistence, and unload/pointer-up flushes.
  The Vite dev server honors `PORT` when provided, and the Claude launch config
  uses automatic port assignment.
- **Sidebar collection tree redesigned** (Eagle-style): compact rows with a slim
  caret close to the edge, and **hierarchy guide rails** — a vertical rule per
  ancestor level plus an elbow connector that bends into the last child of a
  group. The same guides (`PickGuides`) are shared by the tag / collection
  pickers.
- **Distinct system-view icons:** Uncategorized is a folder-with-“?”, Untagged a
  tag-with-“?”, and All Tags a plain tag (previously Untagged and All Tags shared
  one icon).
- **File inspector** now shows **Date Added** and **Date Modified** (renamed from
  “Modified”), both down to the minute (`formatDateTime`).
- The drag hint is terser — bundles: “Drag to move · hold ⌥ to copy”;
  collections: “Drag and drop to reorder or nest”.
- Removed the **“openable”** file badge (attention badges — unsupported /
  unlinked / unbundled — remain).
- **The All tab no longer behaves like a collection.** It always shows every
  top-level collection plus every bundle (flattened) — the "Show subcollection
  contents" toggle is gone from the All view (it remains inside a specific
  collection). Bundle reorder / "Clean Up Order…" are disabled in the All view
  (reordering "everything" is meaningless).
- **Sidebar order:** the system section is now All, Recently Added,
  Uncategorized, Untagged, **Unbundled**, Missing Files, with **All Tags moved to
  the bottom** of the section.
- **Fold arrows are a slim disclosure triangle** (`IconChevron`) — narrow on
  purpose (width < height) so the caret barely widens a row, sized larger on the
  Collections / Smart Collections section headings.
- **"Review grouping" is now "Suggest grouping"** (ADR-0011). Manual and
  Update-triggered suggestions share the confirmed-grouping boundary: they
  propose still-unbundled files and new additions without reopening confirmed
  bundles based on collection membership. The internal provisional/confirmed
  state is unchanged, but the user-facing **"Needs review" badge is removed** —
  there is no review state to track.
- **Collections now order by manual `sort_order`** (name as the stable tie-break)
  in both the sidebar and the main browser, instead of always alphabetically.
- **Folder and bundle card sizes are decoupled** on the shared zoom slider:
  folder cards follow a smaller curve (topping out ~240px around two-thirds of the
  slider), and the slider floor dropped to 80px so both card kinds can shrink
  further.
- **Card text no longer highlights** (native text selection) during multi-select.

- **Eagle-style ad-hoc toolbar filters (Tags + Rating).** A funnel button in the
  bundle toolbar reveals a filter row. **Tags** opens a popover with search, tag
  groups (display-only scoping), and a tag tree: left-click includes a tag,
  right-click excludes it (visually distinct blue check vs. red struck minus),
  with a per-category **Any / All / Equal** rule and a **subtags** (descendant)
  toggle. Equal is exact _direct_ membership only (a directly-applied parent tag
  still matches; no descendant expansion). **Rating** offers a star row with a
  `=` / `≥` / `≤` operator and an **Unrated** row (clicking the selected star or
  Unrated again clears it). Filters stack under AND with the active Smart
  Collection, the current view/collection, and the text search — all via the one
  canonical FilterExpression AST. Popover counts are **faceted**: scoped to the
  current browse context and the other active filter categories (a new
  `POST /filters/facets` endpoint), never global static counts. Ad-hoc filters
  are local UI state (not persisted to localStorage or the URL yet).

- **Rating "Unrated" filter (`rating is_null`).** A rating-specific compiler
  operator matches unrated bundles (`rating IS NULL`); the Smart Collection
  editor's rating row now uses the same star picker and gains an "is unrated"
  operator, so saved collections round-trip it. See `docs/filter-language.md`.

- **All Tags management page.** A new sidebar entry (right below **Untagged**)
  opens a management surface — not a bundle collection, not a folder. A left
  panel scopes the view (**All** / **Uncategorized** / tag groups, each with a
  tag count); the main panel is an Eagle-style, **pinyin-segmented, multi-column
  accordion grid** of top-level tags. A tag with children shows a chevron and
  **expands in place** to a full-width row listing its children (recursively);
  folded it shows its **rolled-up subtree count**, expanded its **direct** count.
  **Drag a tag onto another to nest it** (reparent) or onto empty space to make
  it top-level — the tree is name/pinyin-ordered, so there's no manual sibling
  order to keep. Right-click a tag to **Rename** or **Delete** it (deleting a
  parent that still has children is blocked with a friendly message; a leaf
  deletes and drops its assignments via cascade — no file or bundle touched).
  Double-clicking a tag jumps to **All** bundles, clears the search, and applies
  a global Equal/direct tag filter. The right inspector is hidden on this page so
  the grid gets the full width.

- **Create a tag or collection directly from the picker.** In the tag and
  collection pickers (single-bundle editors and the multi-bundle bulk
  editor), typing a search offers a **Create "…"** row whenever the search
  doesn't already name an existing tag/collection exactly — even if it's a
  substring of one (e.g. searching "Act" while "Action" exists still offers
  to create "Act" as its own tag, alongside the "Action" partial match).
  Clicking it creates the tag/collection (top-level) and assigns it
  immediately — no need to leave the picker to add a new one first.

- **Multi-bundle bulk editor.** Selecting 2+ bundles no longer shows a top
  "batch bar" — the right panel becomes a bulk editor instead: a title field
  that overwrites every selected bundle, a rating control (shows the shared
  value, or unset when they differ) that likewise overwrites all, and
  tag/collection pickers where items common to every selected bundle show as
  assigned; toggling one adds or removes it across the whole selection via the
  batch endpoint. Files/size are rolled up (sum). No note field — a note is
  inherently per-bundle prose, not something to overwrite in bulk.

- **Subcollection cards: drag-select, click-to-deselect, and root-level
  browsing.** The folder cards above the bundle grid now support the same
  left-click marquee drag and empty-space-deselects behavior as the bundle
  grid, kept as a separate selection track — a subcollection selection and a
  bundle selection are mutually exclusive, since acting on both at once isn't
  meaningful. The **All** view now also shows every root-level collection as
  cards above the bundle grid, not just inside a collection. Folder cards got
  a subtle stacked-sheet treatment (offset shadow layers) so they read as
  folders rather than bundles, and their footer now shows both the direct
  bundle count and the subcollection count.

- Collection and bundle titles commit on **Enter** (in addition to blur), like
  the sidebar's inline rename box.

- **Collection cover cards.** Subcollections now render as folder cards with a
  cover image — the collection's chosen cover bundle, or an auto-picked bundle
  from anywhere in its subtree — and scale with the toolbar zoom slider like
  bundle cards. Right-click a bundle in a collection → **Set as collection
  cover**. Adds a `collections.cover_bundle_id` column (additive; falls back
  gracefully if the cover bundle is deleted), `GET /collections/{id}/thumbnail`,
  and `cover_bundle_id` on `CollectionUpdate`/`CollectionRead`. The cover also
  shows atop the collection inspector.

- **Collection inspector (title, note, counts).** Single-clicking a
  subcollection in a collection's view selects it and shows a right-pane
  inspector with an editable title and a freeform **note**, plus counts:
  bundles directly in the collection, total distinct bundles across the whole
  subtree, and direct subcollections. Double-click still navigates in. Adds a
  `collections.note` column (bootstrapped additively on library open — no
  migration), `GET /collections/{id}/stats`, and `note` on
  `CollectionUpdate`/`CollectionRead`.

- **Unbundled staging + manual bundling assistant (follow-up to ADR-0009).** A
  scan stages every newly discovered file as a _provisional_ one-file bundle; the
  library browser now treats those as **unbundled** files (`grouping_state =
provisional` + `grouping_source = scan_suggestion`) and confines them to a
  dedicated **Unbundled** system view. They are hidden from All, Recently Added,
  Uncategorized, Untagged, Missing, and every collection until the owner confirms
  them — so unaccepted scan suggestions no longer masquerade as real bundles.
  `GET /bundles/counts` gained an `unbundled` count and browse a `view=unbundled`.
  A new `cairndex.manual_bundling` service turns unbundled files into confirmed
  bundles by hand, all **metadata-only** (files are re-parented and emptied
  provisional bundles reaped; nothing on disk is moved/copied/renamed/deleted):
  - **Add to Bundle** — fold selected unbundled files into an existing _confirmed_
    bundle (roles assigned, sequences appended, external subtitles auto-linked).
  - **Create Bundle** — confirm a new bundle from one or more selected unbundled
    files (heuristic title/roles, cover/primary chosen), optionally pulling in
    suggested nearby files.
  - **Create empty Bundle** — make a confirmed empty bundle, then add suggested
    files.
  - **Add Files** (from a bundle's inspector) — pull suggested unbundled files
    into that bundle.
    Suggestions (target bundles for selected files; unbundled files for a bundle; a
    bundle draft from a seed) are generated automatically when a dialog opens, ranked
    with a confidence + human reason, and come only from the library DB and FTS index
    — never a filesystem scan. **Applying is always explicit.** The suggester's
    name-parsing/role heuristics and the file-membership + source-reaping logic are
    reused from grouping (extracted to `grouping/membership.py`). New library-scoped
    routes under `/libraries/{id}/manual-bundling/*`; OpenAPI + frontend types
    regenerated. Web UI adds the Unbundled view (now a file-first Files surface —
    see _Changed_), an empty-space/toolbar "Create Bundle…", the inspector "Add
    Files…" action, and four suggestion dialogs with empty/loading/error states and a
    success toast. Covered by `test_browse.py` (view/counts/hiding),
    `test_manual_bundling.py` + `test_manual_bundling_api.py` (suggestions, all
    mutations, subtitle auto-link, confirmed bundles undisturbed, metadata-only), and
    `e2e/manual-bundling.spec.ts` (Unbundled view, create-from-files, add-to-bundle).

- **Optional per-library owner passphrase lock (ADR-0010).** Each library can
  independently require an owner passphrase — a lightweight private-LAN/Tailscale
  guardrail, **not** public-internet hardening and **not** multi-user auth. Only a
  PBKDF2-HMAC-SHA256 hash is stored, in the library's portable `manifest.json`
  (`auth` block), set/cleared with `python -m cairndex.devtools.set_passphrase`
  (never through a content API, never logged). Unlocking is a server-side session
  bound to an opaque HTTP-only `SameSite=Lax` cookie whose record maps to a set of
  unlocked library ids, each with its own expiry — so unlocking library A never
  unlocks library B, and each protected library is unlocked on its own. New routes
  `GET/POST /libraries/{id}/auth/status|unlock|lock` stay reachable while locked;
  the content gate lives in the one `get_library_session` dependency every
  library-scoped route already uses, returning 401 for a protected library with no
  valid unlock. Wrong passphrases return a generic 401. The registry library list,
  health, static assets, and the auth endpoints remain accessible while locked. In
  the UI, a protected+locked active library shows a passphrase screen (with a
  library switcher) before any content query runs; the sidebar gains a Lock action;
  switching to a different protected library shows its own lock screen. Covered by
  `test_auth.py` (hashing, session scoping/expiry, manifest config, and the full
  API gate incl. A-doesn't-unlock-B, unprotected-C, wrong-passphrase, manual lock)
  and an `e2e/library.spec.ts` unlock flow. OpenAPI + frontend types regenerated;
  `.env.example` and `docs/deployment.md` updated. Sessions are in-memory
  (single-owner, single-process), so a restart re-locks.

- **Whole-library indexed metadata search (SQLite FTS5).** The toolbar search box
  now searches the entire active library — bundle title/note, each file's display
  title, original filename, relative path, source URL and media kind, plus tag
  and collection names — instead of filtering only the loaded/paginated rows. Each
  library DB carries a per-library `bundle_search` FTS5 table kept fresh by SQLite
  triggers over the underlying tables, so every write path (interactive edits,
  scan, moved-file repair, grouping apply, deletion, tag/collection rename) updates
  the index automatically; a `python -m cairndex.devtools.reindex_search` command
  rebuilds it for one library (initial fill / drift recovery). Browse gained a `q`
  parameter (GET and POST `/bundles/browse`) that composes as a non-correlated FTS
  semijoin, so search stacks with the active system view, collection, Smart
  Collection/filter, sort, and pagination. User input is tokenized into safe quoted
  prefix terms, so FTS operators can't cause a syntax error. The frontend debounces
  the search box (250 ms) into the backend query, shows Searching/No-matches states,
  and no longer does client-side window filtering. Covered by `test_search.py`
  (coverage, freshness on edit/delete/tag-rename, filter composition, escaping,
  rebuild, API) and an `e2e/library.spec.ts` flow proving search finds a bundle not
  in the first loaded page. OpenAPI + frontend types regenerated.

- **Job progress & observability.** Background jobs (scan/probe/thumbnail) now
  report a coarse **phase** (`discovering` → `reconciling` → `grouping` →
  `finalizing` for a scan; `probing`/`thumbnailing` for the others) and an
  optional human **message** alongside the existing processed/total counts and
  terminal `result`/`error`. The registry `job_queue` gained nullable `phase`
  and `message` columns (added additively to existing registry DBs — no manual
  migration); `JobRead` exposes both and OpenAPI/frontend types were
  regenerated. The worker's `JobContext` gained `set_phase(...)` (phase changes
  flush immediately) and throttles the hot `checkpoint(...)` registry write to
  at most one commit per 0.5s — so a multi-terabyte scan no longer commits the
  registry once per batch — while still checking cancellation every call and
  always flushing 100%. Handler errors are sanitized before storage
  (`jobs/errors.py`): the exception type is kept but the library root and any
  absolute paths are redacted, so a failed job never leaks private filenames.
  The sidebar renders a live progress bar under **Update** — determinate when a
  total is known, indeterminate otherwise — with the current phase/count, and a
  redacted error line if a maintenance job fails. Covered by backend
  `test_jobs.py` (phase/message, terminal phase clear, path redaction, API
  exposure) and an `e2e/library.spec.ts` flow asserting the bar appears with
  phase and counts during Update.

- **Large-library performance baselines + targeted indexes.** Two devtools under
  `cairndex.devtools`: `synthetic_library` generates a real on-disk library and
  bulk-populates it (batched core inserts; 100k bundles / ~300k files in ~6s, no
  real media touched), and `benchmark_queries` times the hot browse/count/filter
  paths over `--iterations` runs with an optional `--explain` that dumps the
  actual SQLite `EXPLAIN QUERY PLAN`. Profiling a synthetic library showed the
  browse/count/filter paths doing a full `asset_files` scan per bundle (SQLite
  does not auto-index a foreign key) and the sidebar count group-bys falling back
  to a temp B-tree. Three measured indexes were added — `asset_files.bundle_id`
  (the dominant fix), and reverse indexes on `asset_bundle_collections.collection_id`
  and `asset_bundle_tags.tag_id` for the count group-bys — taking browse from
  ~5.4 s to ~12 ms and view-counts from ~12 s to ~14 ms on a 5k-bundle library
  (see `docs/performance.md`). Indexes are defined on the models (new libraries
  get them via `create_all`) and backfilled idempotently into existing library
  DBs on open via `persistence.engine.ensure_content_indexes`, since library DBs
  have no migration chain.

- **Dedicated product brief.** Product mission, fixed decisions, canonical domain
  model, File View direction, grouping behavior, UI direction, future
  compatibility notes, and first-release anti-goals now live in
  `docs/product-brief.md` instead of being embedded in `AGENTS.md`.

- **Right-click context menus + bundle/collection deletion.** Bundle cards and
  list rows now have a right-click menu with **Open**, **Remove from this
  collection** (when browsing inside a collection), and **Delete Bundle**; the
  collection tree and Smart Collection rows have menus for **Delete collection**
  and **Edit/Delete**. Deletion is metadata-only and wired to the existing
  `DELETE /bundles/{id}` and `DELETE /collections/{id}` endpoints — no file on
  disk is ever touched, and every destructive action confirms in a styled dialog
  first. Deleting bundles opens `DeleteBundlesDialog` (acting on the whole
  selection when a multi-selected card is right-clicked) with an **Also delete
  contained files** checkbox; it defaults off and is a forward-looking
  placeholder — filesystem deletion is not enabled in the metadata-only
  milestone, so files are always kept for now. Deleting a collection that has
  subcollections opens `RemoveCollectionDialog` with an **Also delete
  subcollections** checkbox, checked by default; unchecking it floats the
  subcollections to the top level instead. The subcollection choice is backed by
  a new `cascade` query parameter on `DELETE /collections/{id}` (default
  `false`) whose service bulk-deletes the descendant subtree while keeping
  bundles/files. A new reusable `ContextMenu` component (`useContextMenu`)
  renders a cursor-anchored, viewport-clamped menu in a portal that closes on
  outside click / Escape / scroll, and `useDeleteBundles` / `useDeleteCollection`
  refresh the affected browse, count, and tree queries (clearing the view when
  the in-view collection is deleted).

- **External subtitle auto-link across grouping flows (ADR-0009, phase 6).**
  Grouping a video with its sidecar `.srt`/`.vtt` now links them everywhere a
  bundle is formed, not only via the grouping-plan apply: **fast-add** with
  single-bundle grouping runs `auto_link_external_subtitles` and reports
  `subtitles_linked`, so the ADR-0003 data-model claim ("external subtitles
  auto-link to a same-directory video by basename, language/forced parsed from
  the suffix") holds for the scan/grouping and manual-grouping flows alike.

- **Re-scan additions into confirmed bundles (ADR-0009, phase 5).** When a file
  is discovered in a directory already owned by a _confirmed_ bundle, the
  suggester now proposes folding it into that bundle (an **addition** proposal,
  `target_bundle_id` set) rather than spawning a fresh one — so a re-scan that
  drops `cosmos.fr.srt` next to a confirmed _Cosmos_ bundle suggests "add to
  Cosmos", never disturbing the confirmed grouping. Applying an addition moves
  the file in, assigns a role, links subtitles, removes the emptied provisional
  bundle, and is idempotent + conflict-aware (a file the user moved into a
  different confirmed bundle is left alone). The apply result reports
  `files_added_to_bundles`; the review UI shows additions as "Add to …".

- **Grouping review UI (ADR-0009, phase 4).** A new sidebar **⧉ Group** action
  opens a review modal that suggests a grouping for the active library and shows
  the plan — proposed bundles and the logical containers that would hold them,
  with each file's role, a confidence badge, and a reason — then applies it on
  confirmation (confirming bundles, creating collections, and linking subtitles;
  nothing on disk changes). The apply result reports how many bundles/collections/
  subtitle links were made and surfaces any conflicts (files that moved, vanished,
  or were already grouped by hand). `useGroupingPlans` / `useGroupingPlan` /
  `useGenerateGroupingPlan` / `useApplyGroupingPlan` wrap the ADR-0009 phase-3
  routes; applying invalidates the browse/collection views. (Interactive
  edit-before-apply — merge/split/reclassify/rename — is a follow-up; this lands
  the review + accept-all + apply slice.)

- **Grouping plan apply service + API (ADR-0009, phase 3).** Durable
  `grouping_plans` / `grouping_proposals` / `grouping_proposal_files` tables store
  a reviewable snapshot of the suggester's output (parent links by
  `parent_proposal_id`; proposal files reference `asset_file_id` as a snapshot id,
  not an FK, so a vanished file surfaces as a conflict rather than cascading). New
  library-scoped routes: `POST /grouping/plans` (suggest + persist, superseding
  the prior open plan), `GET /grouping/plans`, `GET /grouping/plans/{id}`, and
  `POST /grouping/plans/{id}/apply`. Apply is the only step that confirms
  groupings: it merges/splits provisional bundles **preserving `AssetFile.id`**
  (so moved-file repair, subtitles, thumbnails, and notes stay stable), assigns
  roles, selects cover/primary, links external subtitles, and creates the logical
  collections a CONTAINER suggests — never touching the filesystem. It is
  idempotent (re-applying a settled plan is a clean no-op) and conflict-aware (a
  proposal whose files vanished or were manually regrouped is reported as a
  localized conflict and skipped, never overriding a confirmed user decision).

- **Read-only grouping suggester (ADR-0009, phase 2).** A pure heuristic
  (`cairndex.grouping`) turns the files observed in a library into a
  `GroupingPlan` of BUNDLE / CONTAINER proposals with per-file roles, ordering,
  a confidence, and a human-readable reason — leading with content signals and
  using names only as a hint. A folder with one video plus sidecars (or a
  multipart video) reads as a **bundle**; a folder of unrelated items or one
  holding sub-bundles reads as a **container** (a logical-collection suggestion,
  never a filesystem move); nested folders recurse. Roles are derived as ADR-0003
  prescribes (primary video, cover = `cover`/`poster`/`thumb…` image else first
  image, external subtitles, sequence by natural order). Files already in a
  _confirmed_ bundle are excluded, so confirmed decisions win over heuristics.
  This phase is read-only: a thin DB adapter (`grouping.service`) snapshots the
  current library and returns a plan; persisting and applying it is phase 3.

- **Bundle grouping review state (ADR-0009, phase 1).** `asset_bundles` now
  carries `grouping_state` (`provisional` | `confirmed`), `grouping_source`
  (`legacy` | `scan_suggestion` | `manual` | `fast_add` | `import`),
  `grouping_rule_version`, and `confirmed_at`. The scanner stages newly
  discovered files into `provisional` / `scan_suggestion` bundles awaiting
  review; fast-add and manual creation produce `confirmed` bundles (the user
  already chose the grouping). Bundles created before this change backfill as
  `confirmed` / `legacy` via server defaults. `grouping_state` /
  `grouping_source` are exposed on `BundleRead`. This is schema-and-state only:
  the suggester, apply-plan service, and review UI land in later ADR-0009
  phases, and browse behaviour is unchanged for now.

- **Frontend wiring for optimistic concurrency + per-library maintenance jobs.**
  The bundle inspector and Smart Collection editor now send the entity `version`
  as `If-Match` on edits; a 409 conflict surfaces an inline notice ("changed
  elsewhere — save again to apply over the latest") and the view refetches
  current server state instead of silently overwriting another client's change.
  The sidebar gained a **Library maintenance** row with **Scan** and **Probe**
  (ffprobe technical metadata) actions; each disables while running and refetches
  affected views.

- **Optimistic concurrency for metadata edits (ADR-0008, phase 9).** The
  frequently edited entities (`asset_bundles`, `asset_files`, `tags`,
  `collections`, `smart_folders`, `subtitle_tracks`) now carry a `version`
  integer (starts at 1, bumped on each edit). Single-entity `PATCH` routes —
  bundles, files, tags, collections, and smart collections — accept an optional
  `If-Match: <version>` header: a stale value is rejected with **409**
  (`version_conflict`) before anything is mutated, while omitting the header
  keeps the previous last-write-wins behaviour (back-compatible). `version` is
  exposed on the read models; OpenAPI and frontend types were regenerated.
  Increment is explicit in the service layer (`persistence/concurrency.py`) so
  internal scan/repair writes never risk `StaleDataError` under the single-writer
  model.

### Fixed

- **Image viewer M5 review fixes.** Fit mode no longer upscales small images
  past 100%, progressive tier failures keep the last loaded image visible, and
  probed `tech_metadata` dimensions remain the natural-size basis when preview
  tiers decode smaller. Progressive loading keys effects on discrete source
  tiers, so viewport fit measurement cannot cancel the only in-flight decode.
  Wheel zoom now uses a non-passive native listener,
  custom pan is clamped to the viewport, File View non-native images open through
  `/file/preview`, and preview generation catches Pillow decompression bombs,
  rejects oversize dimensions, uses `Image.draft` for large JPEGs, and decodes
  behind a bounded semaphore.
- **Media viewer M2 review fixes.** Cold opens now bind the native video engine
  through a callback-ref/state mount path, so listener attachment, duration/time
  updates, play state, and persisted volume/mute/rate are applied when the video
  element mounts or remounts. Subtitle tracks share one filtered source list,
  select native text tracks by `<track>` element identity, and honor default
  tracks. Shortcuts are scoped to the focused viewer root, `Esc` exits
  fullscreen before closing, arrow keys navigate files when no playable video is
  active, seek/frame-step read live media time, the inline file filmstrip was
  removed to avoid control-bar overlap, the center play overlay was removed,
  shared fallback cards remove duplicated viewer/File View states, and SVG icons
  replaced emoji control glyphs.
- **The marquee selection box no longer sticks after a drag.** In a
  non-reorderable list view a row is still draggable (to move bundles into a
  collection); starting a native drag swallowed the `mouseup` that ends the
  marquee, leaving its box on screen. The marquee is now cancelled when a native
  drag takes over.
- The File Browser sort option and column now read **"Date Modified"** (was
  "Modified"), matching the inspector.
- The sidebar **end-of-list drop zone grows while a collection is dragged**, so
  dropping "past the last collection" is a large, forgiving target.
- **Dropping a reorder past the content edge now works.** A drop that lands in
  the empty margin around the cards (below the last / above the first) is caught
  by the container and routed to the end / beginning, so you no longer have to
  pinpoint a card edge inside the "invisible boundary" of the content box (bundle
  grid and folder grid).
- **Collection drag-reorder could silently misfire (~1 in 8) or drop a move.**
  The drop zone is now recomputed from the cursor at drop time (a stale hover
  slot no longer turns an intended reorder into a reparent). Dropping a
  collection on the gap before/after a row in a **different** parent group now
  reparents it into that group at that slot — so a subcollection can be moved out
  to the **top level** — and a drop zone below the last sidebar row catches a
  drag aimed "behind the last collection".
- **Bundle drag with Option/Alt held was rejected on macOS.** The drag now
  advertises `copyMove` (and reflects copy vs move as the cursor), so
  Option-drag to _add_ bundles to a collection (without removing them from the
  current one) works.
- **A "drop into" highlight could stick on the last-hovered folder card / sidebar
  row** after a bundle drag (which begins in the Browser and never fired those
  surfaces' `onDragEnd`). The highlight is now gated on the live drag.
- **File Browser directories now take part in drag-select and Shift-range
  select** like files (bundling targets still filter to files only).
- **Marquee drag-select could inflate the scroll area with empty space,
  runaway-growing without bound.** The drag-selection overlay's size was
  computed straight from raw mouse coordinates; dragging past the loaded
  content (in either the bundle grid or the collection cards) let it grow
  past its container's real content size — and since it's absolutely
  positioned inside an `overflow: auto` container, that inflated the
  container's scrollable area. Because auto-scroll then had more room to
  advance into, and advancing let the overlay grow further, the two fed each
  other every animation frame: a single ~400px drag paused near the bottom
  edge for about a second inflated one container from 232px to over 14,000px
  of scrollable height. The overlay's rectangle is now clamped to the
  content's true size (measured once at drag start), which keeps the overlay
  inside real content and breaks the feedback loop.

- The empty-inspector placeholder ("Select a bundle to see its details.") now
  also mentions collections, since single-clicking a collection card shows
  its details there too.

- **Bundle cards no longer show a duration badge on image bundles.** The
  runtime badge (bottom-right of the card thumbnail) rendered whenever the
  primary file's `tech_metadata` happened to carry a stray `duration`, even for
  a JPG/PNG bundle showing an image type badge — it's now gated on the
  bundle's `media_kind` being video.

- Right-click context menu items are consistently Title Case (e.g. "Set as
  Collection Cover", "Remove from This Collection", "Delete N Bundles", "Add N
  Files to Bundle…").

- **`synthetic_library` no longer takes hours at 100k+ bundles.** The devtool
  regressed when whole-library FTS5 search landed: every bulk insert into
  `asset_bundles`/`asset_files`/the tag/collection association tables fired a
  search-index maintenance trigger (one per row, even inside an
  executemany-style batch), and many small individual FTS5 DELETE+INSERT
  operations fragment the index and get progressively slower as it grows — 20k
  bundles didn't finish in 3+ minutes. The generator now suspends those
  triggers for the bulk load (`search.drop_maintenance_triggers`) and restores
  them plus rebuilds the index in one set-based pass
  (`ensure_search_schema` + `search.rebuild`) afterward. 100k bundles is back to
  ~7s; a new regression test (`test_generate_rebuilds_search_index_and_restores_triggers`)
  asserts the index is fully populated and triggers are live for subsequent
  writes.

- **Removing a file from a bundle now returns it to Unbundled instead of
  unlinking it.** The bundle inspector's per-file remove (×) previously deleted the
  file's `AssetFile` row, dropping it from the library entirely (only re-scanning
  brought it back). It now re-stages the file into its own provisional/
  `scan_suggestion` one-file bundle (metadata-only, `AssetFile.id` preserved, and
  any cover/primary pointer on the source cleared), so the file falls back into the
  **Unbundled** view — mirroring what deleting its bundle does. Shared with
  `delete_bundle` via a new `_restage_file` helper. The remove mutation now also
  invalidates the `unbundled-files`, `file-view`, and `view-counts` caches so the
  Unbundled list, File View badges, and sidebar count update at once instead of
  only after a manual refresh. Covered by
  `test_manual_bundling.py::test_removing_a_file_from_a_bundle_restages_it_as_unbundled`.

- **A new cover shows immediately instead of after a manual refresh.** The bundle
  thumbnail URL (`/bundles/{id}/thumbnail`) is stable, so the browser served a
  stale cached image after the cover changed. Browse summaries (and the inspector)
  now carry a `cover_key` — the id of the file the cover is derived from — which
  the client appends as a cache-busting `?c=` param; it changes when the cover
  changes, so the grid card and inspector cover update at once. Covered by
  `test_browse.py::test_summary_cover_key_tracks_the_selected_cover`.

- **The Unbundled list now refreshes after applying a grouping plan or deleting a
  bundle.** Applying a grouping plan (which confirms bundles, so files leave
  Unbundled) and deleting a confirmed bundle (which re-stages its files back into
  Unbundled) now invalidate the `unbundled-files` and `file-view` query caches — so
  the Unbundled Files list and File View badges update immediately instead of only
  after a manual page refresh (the sidebar count already updated).

### Changed

- **Unbundled is now a file-first Files-surface view; the two top-left tabs are
  Bundles + Files.** Scan-staged files were previously shown as _bundle cards_ in
  a browse view; they are now presented as **files**. The "Collections" tab is
  renamed **Bundles** (the bundle-first surface: system views, Smart Collections,
  the Collections tree, Tags); **Files** is the filesystem browser. Clicking
  **Unbundled** switches to the Files surface showing a flat, cross-library list
  of the not-yet-bundled files (a new `GET /manual-bundling/unbundled-files`),
  with the _file_ inspector rather than bundle metadata. File View entries carry a
  new `unbundled` flag and show **`unlinked`** / **`unbundled`** / `openable`
  badges (the old `linked` badge is gone; a file in a confirmed bundle shows no
  status badge). Any File-View file can be right-clicked to **Add to Bundle… /
  Create Bundle…**; unlinked files are auto-linked (staged as provisional) at
  apply time. The manual bundling apply/suggest endpoints accept `relative_paths`
  in addition to `file_ids`. Covered by extended `test_file_view.py`,
  `test_manual_bundling*.py`, and a rewritten `e2e/manual-bundling.spec.ts`
  (Unbundled Files surface + create-from-files; File-tree unlinked → add-to-bundle).

- **Deleting a confirmed bundle now dissolves it back to Unbundled.** Instead of
  forgetting the bundle's file rows, `delete_bundle` re-stages each still-linked
  file into its own provisional/`scan_suggestion` one-file bundle (metadata-only,
  `AssetFile.id` preserved), so the files fall back into the **Unbundled** view and
  can be re-bundled — matching what a scan would stage. Deleting an already
  unbundled (provisional) bundle, or an empty bundle, still removes its rows (the
  way to drop a loose file from the library). Files on disk are never touched. The
  delete-confirmation dialog explains the Unbundled fallback. Covered by
  `test_manual_bundling.py` (`test_deleting_confirmed_bundle_restages_files_as_unbundled`,
  `test_deleting_unbundled_bundle_removes_the_file`).

- **Membership filters use a non-correlated semijoin.** Tag/collection filters
  (and their "include descendants" variants) now compile to
  `AssetBundle.id IN (SELECT bundle_id FROM assoc WHERE member_id IN (…))` — the
  match set computed once via the association-table index — instead of a
  per-bundle correlated `EXISTS`. Applied in both `filters.compiler` (Smart
  Collections / toolbar filters) and `services.browse` (collection browsing);
  semantically identical. Measured (perf/M2): tag-descendant filter ~7.2 s →
  ~0.13 s and collection-descendant ~2.6 s → ~0.07 s at 100k bundles.

- **Agent documentation cleanup.** `AGENTS.md` is now focused on agent execution
  rules: required reading, source-of-truth order, safety constraints, stack and
  dependency rules, API/data-safety rules, performance requirements, gates,
  testing expectations, Git workflow, documentation discipline, and definition of
  done. `CLAUDE.md` now points Claude-based agents to the same source split.

- **Documentation refresh for the current development state.** README,
  `docs/STATUS.md`, architecture, data-model, development, deployment,
  `AGENTS.md`, and `CLAUDE.md` were refreshed to reflect the implemented
  per-library package + registry model, current Update/grouping-review workflow,
  selected-accept semantics, hidden/cache exclusions, removed Eagle importer,
  and absence of global storage-root content APIs.
