# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Added

- **Player interaction polish (Plan 1 M9).** Video-surface right-click toggles
  play/pause; seek step (2/5/10/30 seconds) and pitch preservation are persisted
  player preferences; the speed ladder and pitch toggle live together in the
  settings menu instead of occupying a separate control-bar selector; file loop
  is session-only and takes precedence over
  bundle auto-advance; frame step now uses `<`/`>` and speed uses `,`/`.`.
  The settings menu can set the current server-decoded video frame as the file
  and bundle cover, or clear it back to automatic extraction. The new additive
  `asset_files.cover_time` metadata and POST/DELETE `cover-frame` endpoints are
  path-safe and regenerate only cached thumbnails; originals remain untouched.

### Fixed

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
  request pinned a *registry* connection until the body finished — and when a
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
  per-library **and** registry DB connection for the *entire* response body,
  because their `LibrarySession` was a `yield` dependency FastAPI keeps open
  until the last byte is sent. Dragging the scrub bar fires many overlapping
  range requests, so the held connections drained the QueuePool; new requests
  (including the next `playback-decision`) then blocked for the 30s pool timeout
  and failed with a `QueuePool` 500, leaving the viewer stuck on "Preparing
  playback…". A new `LibraryAccess` dependency does the same registry/lock gate
  but hands back a short-lived `session()` scope that resolves the path and
  releases the connection *before* the response streams — so no connection is
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
  transcode-only *sources* route through the same session machinery but have not
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
- **"Review grouping" is now "Suggest grouping" and is categorization-driven**
  (ADR-0011). The manual action re-proposes grouping for **every bundle that
  isn't filed into a collection** — including a previously confirmed one whose
  collections were later removed — plus still-unbundled files; bundles already in
  a collection are left untouched. Routine **Update**/scan keeps its narrower
  scope (only files not yet in a confirmed grouping). The internal
  provisional/confirmed state is unchanged (it still protects confirmed bundles
  at apply time and drives re-scan additions) but the user-facing **"Needs
  review" badge is removed** — there's no "review" state to track.
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
  Option-drag to *add* bundles to a collection (without removing them from the
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
