# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

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
  ffmpeg/ffprobe builds, which are GPL-2.0-or-later and carry their own source
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
  set-cover-to-frame) — A-B loop moved
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
