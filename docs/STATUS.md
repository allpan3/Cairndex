# Project status

## In review: playback DB-pool exhaustion fix

Branch `fix/playback-pool-exhaustion` (off `main`).

### Follow-up pass: registry-pool abort leak (actual root cause) + load watchdog

After the first three fixes below, sustained scrubbing still eventually broke
playback. Reproduced live against a real 6.8 GB 4K file (NAS-backed library):
the drag's aborted range requests produced `/stream` **500s**, which Chrome's
demuxer surfaced as fatal `PIPELINE_ERROR_READ` media errors, draining the
native-recovery budget.

Root cause (two mechanisms, both verified empirically on FastAPI 0.138):

1. `get_library_access` still took the `get_registry_db` **yield** dependency.
   Yield-dep teardown runs only after the response body finishes — and when a
   client abort cancels the request task, the teardown **never runs at all**,
   stranding the registry connection until GC. Drag-seeking aborts dozens of
   in-flight range requests → the registry QueuePool (5+10) drained → new gates
   blocked 30 s at resolution → 500s mid-drag. A 600-request abort-storm against
   a real server produced **240** QueuePool tracebacks pre-fix and **zero**
   post-fix.
2. A range request wedged on a half-open connection emits no media `error`
   event, so a recovery reload could stall at `readyState 0` forever — a silent
   black frame with no card (observed live).

Changes in this pass:

- **Backend.** `get_registry_access`/`RegistryAccess` in `api/deps.py`:
  `get_library_access` now opens the registry session imperatively inside the
  sync dependency (cancellation-immune) and closes it before returning; no
  yield dependency remains in the streaming gate chain. The other burst-aborted
  `FileResponse` routes — `/preview`, `/storyboard.vtt`,
  `/storyboard/{sheet}.jpg`, `/subtitles/{id}/vtt` (`api/v1/playback.py`) and
  bundle/file thumbnails (`api/v1/bundles.py`) — moved to the same scoped
  `LibraryAccess` gate. New regression test
  `test_stream_releases_registry_connection_before_body` drives the real,
  unoverridden dependency chain and asserts neither pool has a connection
  checked out once the body streams (the cancellation strand itself is masked
  in-process by refcounting GC; it was proven with the live abort-storm A/B).
- **Frontend.** `MediaViewer`: 15 s **load watchdog** (`LOAD_WATCHDOG_MS`) — a
  source that never reaches `HAVE_METADATA` is treated as a stage error, so the
  bounded recovery path reloads on a fresh connection instead of freezing;
  verified live against a never-responding server (wedge → auto-reload →
  playing). Plus a **burst guard** (`nativeRecoveringRef`, mirroring the HLS
  `reattachingRef`): extra error events during an in-flight recovery no longer
  each consume a budget slot.

Verification: backend `ruff`/`mypy`/`pytest` (**390 passed**, +1); frontend
`lint`/`format:check`/`typecheck`/`test` (**69 passed**); live e2e — a 120 s
automated scrub of the real 4K file through the real dev stack recovered from a
dev-proxy 502 and the wedged-load case automatically; abort-storm A/B as above.
Note for local testing: uvicorn's worker can wedge if its stdout pipe stops
draining while it spews tracebacks (SIGTERM-immune, needs SIGKILL) — another
reason the pre-fix traceback storms could hard-hang the server.

Fixes a viewer hang where dragging the scrub bar eventually wedged playback with
repeated 30s `QueuePool` timeout 500s and a stuck "Preparing playback…" screen.

Root cause: media byte-streaming routes took their content session via the
`LibrarySession` `yield` dependency, which FastAPI holds open until the response
body finishes. A streaming `FileResponse` therefore pinned a per-library **and**
registry connection for the whole transfer; overlapping drag-seek range requests
drained both QueuePools (SQLAlchemy defaults: size 5 + overflow 10, 30s timeout),
so the next `playback-decision` blocked on a registry connection and 500ed.

Changes:

- **Backend (essential).** New `LibraryAccess` dependency + `get_library_access`
  in `apps/server/src/cairndex/api/deps.py`: same registry-resolution +
  passphrase-lock gate as `get_library_session`, but returns a handle whose
  short-lived `session()` scope the endpoint closes *before* returning the
  `FileResponse`. `stream_file`, `file_content`
  (`api/v1/playback.py`), and the HLS `playback_session_artifact`
  (`api/v1/playback_sessions.py`; it never used the session — pure auth gate)
  now use it, so no DB connection is checked out while bytes stream. Test
  override added in `tests/conftest.py`; regression test
  `test_stream_releases_db_connection_before_body` asserts zero checked-out
  connections on the real per-library pool mid-stream (verified failing before
  the fix).
- **Frontend (resilience).** `useHlsSession` now caps the decision request at a
  finite `DECISION_TIMEOUT_MS` (15s) and adds a distinct `'unavailable'` status
  + `retry()`. On timeout or a 5xx, a non-degradable video shows a retryable
  "Playback server is unavailable" card (`MediaViewer`/`MediaFallback`);
  directly-playable sources still degrade to the native stream.
- **Frontend (efficiency).** `SeekBar` coalesces drag scrubbing: the real
  `seek()` is throttled (leading edge + one trailing flush per ~150ms) and the
  exact position is committed on pointer release, instead of a `seek()` per
  `pointermove`. The thumb/tooltip track the pointer live via a local drag
  override. A drag now issues a handful of range requests instead of dozens of
  cancelled ones.
- **Frontend (native error recovery).** A transient media error on a direct-play
  video (a stalled/dropped range read while seeking into an unbuffered region —
  the reported "seek to an unbuffered spot → stuck → Preview failed" bug) used to
  dead-end on an unrecoverable card. `MediaViewer` now reloads native playback at
  the current playhead up to `MAX_NATIVE_RECOVER` (3) times before giving up
  (mirroring the HLS re-attach budget, refunded on healthy progress via the same
  forward-progress effect), and the terminal card is a retryable "Playback
  interrupted — Try again" (`MediaFallback` action) instead of a dead end.

Verification: backend `ruff`/`mypy`/`pytest` green (**389 passed**, +1);
frontend `lint`/`format:check`/`typecheck`/`test` (**69 passed**, +5)/`build`;
Playwright `player.spec.ts` (**15 passed**) exercises real MP4/MKV-remux
streaming end to end. The native error-recovery flow was verified live against a
real backend + a generated 4K MP4: forcing a media error mid-play auto-reloaded
and resumed at the playhead (36s→48s, no card); exhausting the budget surfaced
the retryable "Playback interrupted" card; and its **Try again** restored
playback. (The mocked e2e harness swallows media `error` events by design, so
this path is proven by live verification rather than a Playwright spec.)

## In review: media-player M7 — web HLS integration

Branch `feat/web-hls` (off `main`, after the M6 playback-sessions merge #7).
Latest commit subject: `feat: web HLS integration (hls.js/native-HLS engine)`
plus a review-fix pass (below). Implements plan 1 M7 — the web player now
consumes the M6 decision + session foundation, so a source the browser can't
play directly streams over a server remux/transcode HLS session. Browser-verified
end to end: an **MKV/H.264 remux** session and a **480p libx264 transcode**
session both play via hls.js, and the **native-HLS** path plays in WebKit. HEVC
and other transcode-only *sources* use the same machinery but have not been run
end to end, so they are not claimed as verified (AGENTS.md).

- **Capability profile (§6.3).** `apps/web/src/app/viewer/player/caps.ts`:
  memoized once per tab, probing `HTMLVideoElement.canPlayType` **and**
  `MediaSource.isTypeSupported` for containers (mp4/webm), video codecs
  (h264/hevc/vp9/av1), audio codecs (aac/mp3/opus/vorbis/flac), and `native_hls`.
  Only probe-confirmed formats are advertised (AGENTS.md: no untested-format
  claims); `max_height` is null (no browser decode-ceiling API). Pure
  `computeCapabilities(probe)` is unit-tested with mocked probes.
- **Per-file decision + engine (§6.3).** `useHlsSession` POSTs
  `.../files/{id}/playback-decision` when a video starts. `direct` → existing
  `NativeEngine` path (unchanged; a decision failure also degrades to the
  manifest's direct stream). `remux`/`transcode` → the session playlist via the
  new `HlsEngine` (lazy `import('hls.js')`; native-HLS uses `NativeEngine` with
  the m3u8). `createEngine()` picks the engine; hls.js is a **separate build
  chunk** (~157 kB gz) so the main bundle stays flat (verified in `build`). The
  manifest (`GET /bundles/{id}/playback`) is unchanged and still carries the
  per-video metadata (subtitles/chapters/storyboard/duration/progress).
- **Session lifecycle (§6.3).** Teardown (DELETE) on player close, file switch,
  and unmount; a new **POST `.../playback-sessions/{sid}/teardown`** alias lets
  `navigator.sendBeacon` reap the session on `pagehide` (mirrors the M4 progress
  beacon; OpenAPI + `schema.d.ts` regenerated — `gen:api` reached the registry).
  On a playlist/segment failure (idled-out session) or an hls.js fatal error the
  client transparently re-requests a decision and re-attaches at the current
  playhead; the re-attach budget (3) is refunded only when the playhead actually
  advances (not on the `play` intent), so a persistently broken stream falls
  back to the "can't play" card instead of looping.
- **Quality/audio/burn-in menus.** A settings menu (gear) offers a `max_height`
  ladder (Auto/1080/720/480), an audio-track picker (from `decision.audio_streams`),
  and a burn-in toggle for non-native subtitle tracks (`burn_subtitle_track_id`).
  Each switch re-decides + starts a new session at the current position (no
  in-stream ABR); identical params reuse the live session (M6 F6), changed
  params tear down the old one. Watch progress/resume is unchanged over the 1:1
  VOD timeline.

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check` /
  `ruff format --check` / `mypy src` / `pytest` all green (**387 passed**, same
  pre-existing Starlette/httpx deprecation warning). New: a POST-teardown-alias
  test in `tests/test_hls_sessions.py`. The only server change is the beacon alias.
- Frontend: `lint` / `format:check` / `typecheck` / `test` (**58 passed**, +11:
  `caps.test.ts`, `engine.test.ts` engine-selection matrix, `useHlsSession.test.tsx`
  teardown/switch/re-attach/direct) / `build` (hls.js is its own chunk, main
  bundle unchanged) / `test:e2e` (**52 passed**, +3 in `player.spec.ts`: mocked
  decision→hls.js path with real fMP4 bytes + quality/audio menus + a 720p switch
  re-decide; transparent re-attach on 404 segments → fallback after the budget;
  and a real-backend H.264 **MKV** that scans/probes then plays over a remux
  session with the session DELETE firing on close). e2e ran escalated (the
  sandbox blocks Vite's `::1:5173` bind).
- Live (real uvicorn on an isolated port + a throwaway generated **720p 2-audio
  MKV** library in `/tmp` — never the Demo library): a Chromium-like caps profile
  decided **remux** ("mkv container is not in client capabilities") and started a
  session; `max_height:480` decided **transcode** and `audio_stream_index:2`
  decided **remux**, each a **distinct** session id (switch semantics); the POST
  **teardown alias** returned 204 and removed the session dir; the **idle reaper**
  (`CAIRNDEX_TRANSCODE_IDLE_TIMEOUT=8`) removed untouched session dirs. The full
  browser play/seek/re-attach/switch/close-DELETE path is covered by the
  real-backend + mocked Playwright specs above (Chrome-extension driving was
  unavailable this session, so the interactive walkthrough was replaced by the
  deterministic real-browser e2e + live curl checks, which exercise the same
  server + client paths). The throwaway library/data dir were removed afterward;
  the owner's Demo backend on :8000 was left untouched.

### Review-fix pass (pre-merge, same branch)

Addressed 8 findings (3 confirmed session-lifecycle bugs, 1 docs violation, rest
hardening/cleanup):

1. **Abort-orphan (confirmed, reproduced live).** A decision that resolves after
   its effect was torn down (fast open→close) now DELETEs the session the server
   started, instead of leaving it to the idle reaper.
2. **Fallback flash (confirmed).** The hook starts in `deciding` (and the Stage
   treats `idle` as loading too), so a playable file never shows a frame of the
   "can't be previewed" card while opening.
3. **Degrade-to-direct leak (confirmed).** The decision-failure `.catch` tears
   down the superseded session before swapping to native playback.
4. **Rapid-switch 429s.** A capacity rejection is retried once (~350 ms) — the
   superseded session's teardown usually frees a slot in that window — before the
   error card shows.
5. **Re-attach window race.** An in-flight re-attach is tracked; a burst of stage
   errors is swallowed (one budget slot) instead of returning false on the nulled
   ref and surrendering to the fallback.
6. **Docs (AGENTS rule).** Scoped the playback-support wording (this section +
   CHANGELOG): MKV remux and 480p transcode + native-HLS are browser-verified;
   HEVC-source playback is not claimed. Fixed the stale "~90 kB" hls.js size.
7. **Cleanup.** Extracted a shared `BaseVideoEngine` for the 7 byte-identical
   media-delegating methods (Native/Hls keep only load/destroy).
8. **Cleanup.** Removed the dead `method` field; collapsed the three switch
   setters into `setParam(key, value)`; shared one `beacon(url, body?)` helper
   (bodyless teardown, CORS-safelisted) and dropped the gratuitous Blob type; a
   typed `HttpError` carries the HTTP status.

Tuning applied (reviewer note): the re-attach budget refunds only after ~10 s of
continuous healthy playback past a re-attach (was ~1 s), so a flapping stream
still exhausts the budget and falls back.

Fix-pass verification: frontend `lint`/`format:check`/`typecheck`/`test`
(**61 passed**, +3 hook tests: abort-orphan reap, double-error burst = one slot,
429 retry-once)/`build` (hls.js still its own chunk, main bundle flat)/`test:e2e`
(**54 passed**) all green. No backend source changed in this pass. Live
verification runs through the real-browser + real-backend Playwright specs: the
real-MKV remux spec now also asserts the server's `{DATA_DIR}/transcode` is
**empty after close** (no orphaned session dir), and a new spec proves a playable
file opening shows the loading state with **no fallback-card flash** (a
MutationObserver records any `.media-fallback` mount). The abort-orphan reap is
additionally pinned by a unit test (a decision that resolves post-abort DELETEs
its session).

Known issues / out of scope: embedded text-subtitle **extraction** to servable
tracks and the multi-track subtitle menu/styling are M8 (M7 still shows only the
default external track and burns in non-native tracks on transcode); `max_height`
has no browser probe so it is advertised null (the ladder is user-driven); in-
stream ABR is deliberately not implemented (switches re-create the session). Next
recommended media-player task: **plan 1 M8 — subtitle upgrade**.

## Fixed: library switch refreshes the browser shell

Branch `codex/library-switch-refresh` (off local `main` after the three approved
enhancements were fast-forwarded directly). The workspace already remounted on a
library-id change, but its TanStack query keys were not library-scoped, so the
shared query client reused the previous library's still-fresh 30-second content
cache. The switch handler now points requests at the next library, removes only
active-library content queries, then changes the selected id. Registry and
library-keyed auth queries are preserved.

Verification: the focused Playwright regression fails before the fix and passes
after it, with two libraries returning different bundle titles. Live browser
verification against the real local app switched `lex` (4 items) → `Demo` (21
items and its own collection tree) → `lex` (4 items) without a page reload; the
original selected library was restored afterward. Full frontend `lint`,
`format:check`, `typecheck`, `test` (**51 passed**), `build`, and Playwright
(**53 passed**) are green.

## In progress: pinyin-aware picker search

Branch `codex/pinyin-picker-search` (stacked on the two preceding Update fixes).
Chinese tag and collection names now match full pinyin, initials, partial
pinyin, mixed Latin/pinyin, and polyphonic readings in the single- and
multi-bundle add pickers. The same shared local matcher also covers tag filters,
All Tags, File Browser entry names, and local file-selection filters. Normal
case-insensitive substring search and literal exact-name/create behavior are
unchanged.

`pinyin-pro` 3.28.1 is frontend-only and offline. It is split into a ~142 kB
gzip lazy chunk loaded when a search-bearing surface mounts; the initial app JS
remains ~131 kB gzip. Whole-library Bundle Browser search is still server-backed
SQLite FTS and intentionally does not gain pinyin aliases in this low-cost
slice, since that would require new indexed data and a per-library FTS rebuild.

Verification: frontend `lint`, `format:check`, `typecheck`, `test` (**51
passed**), `build`, and Playwright (**52 passed**) are green. Unit coverage
checks literal, full/initial/partial, mixed, and polyphonic matching. The new
browser case searches `摄影` with `sheying` and `电影` with `dianying` in the
actual single-bundle tag and collection pickers.

## In progress: standalone Update stages

Branch `codex/standalone-update-actions` (stacked on the network-library scan
overflow fix). **Update** runs scan/move repair + new-scope grouping suggestions,
metadata collection, then non-blocking storyboard generation. Its maintenance
overflow now exposes each capability independently as **Scan new files**,
**Suggest grouping**, **Collect metadata**, and **Generate storyboards**.
Standalone and Update-triggered storyboard completion invalidate cached playback
manifests so trickplay availability refreshes without a page reload.

Verification: frontend `lint`, `format:check`, `typecheck`, `test` (**48
passed**), `build`, and Playwright (**51 passed**) are green. The new browser
case opens the maintenance overflow, verifies all four standalone labels, and
confirms **Generate storyboards** sends its own storyboard-job request.

## Fixed: network-library scan overflow

Branch `codex/fix-unsigned-filesystem-identity` (off `main`). **Update** no
longer fails when a mounted/network filesystem reports an unsigned 64-bit inode
or device identifier above SQLite's signed `INTEGER` maximum. The scanner stores
the same 64 bits in signed two's-complement form, preserving exact equality for
moved-file repair without a schema migration. Regression coverage exercises an
initial scan and same-volume move with an inode above `2^63 - 1`.

Verification: backend `ruff check`, `ruff format --check`, `mypy src`, and
`pytest` (**387 passed**) are green. A read-only scan of the mounted `lex`
library into an in-memory database discovered and persisted all 4 supported
media files without touching its real library database.

## In review: multiple notes per bundle

Branch `feat/bundle-multiple-notes` (off `main`, i.e. after the M6 playback
sessions merge #7). Owner-requested feature ahead of the next milestone: a
bundle can hold several freeform note/description blocks instead of a single
note, used as clean separators (no predefined roles under the hood).

- **Data model.** New `asset_bundles.notes` JSON column (ordered `list[str]`),
  added additively via `ensure_content_indexes` so existing libraries gain it on
  open (verified live). It is the **single source of truth** — the old scalar
  `note` column/field and its compatibility shim were removed (early-dev cleanup
  per owner); libraries created earlier keep a harmless unused `note` column. A
  `notes IS NULL` row reads back as `[]`. Both note-aware read paths were
  re-pointed at the array: the `notes` **filter** (field key renamed `note` →
  `notes`) compiles to a per-note `EXISTS` over `json_each(notes)`, and the
  **`bundle_search` FTS index** concatenates `json_each(notes)` into its `notes`
  column. `ensure_search_schema` rebuilds the FTS table + triggers (and always
  recreates the source view) when the column set no longer matches, so an
  existing library migrates its search index on open — verified live on the Demo
  library (existing titles stayed searchable, a new note indexed).
- **Service/API.** `create_bundle`/`update_bundle` accept `notes` only (blank/
  whitespace-only blocks dropped, order preserved, ≤50). `BundleRead.notes` is
  always a list; the `note` field is gone from `BundleCreate`/`Update`/`Read`.
  OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (`gen:api` reached the
  registry).
- **Frontend.** The inspector "Note" section became **NOTES** with a small `+`
  **icon** (`IconPlus`) that appends a note box below the current ones; each box
  commits on blur, and a hover `×` removes one (at least one empty box always
  remains). A synchronously-updated `notesRef` mirrors the list so a blur landing
  in the same tick as the last keystroke still commits the latest text. Each note
  box (`NoteBox`) **auto-grows** to fit its content by default (no scrollbar);
  only an explicit **drag** (>3 px) of a small centered bottom grip switches it
  to a fixed height with `overflow-y: auto` — a stray click on the grip stays in
  auto-expand, and `resize: none` on the textarea means there is **no native
  resizer/scroll-corner box** — and each note remembers **its own** height across
  sessions (`cairndex.noteHeights`, per bundle, aligned with the notes list by
  index; add/remove keep the arrays in step; double-click the grip to return that
  box to auto-fit).

Verification:

- Backend: `ruff check` / `ruff format --check` / `mypy src` clean; `pytest`
  **386 passed** (`test_bundles.py`: multi-note roundtrip incl.
  reorder/blank-strip/clear, create-with-notes, `notes IS NULL` reads `[]`,
  `notes` filter matching a non-first note + `not_contains`, non-string
  rejection; `test_search.py` gained a stale-FTS-schema rebuild test;
  `test_search.py`/`test_scan_repair.py` updated to `notes`). Same pre-existing
  Starlette/httpx deprecation warning.
- Frontend: `lint` / `format:check` / `typecheck` / `test` (**47**) / `build` /
  `test:e2e` (**50**, +1 new `edit.spec.ts` case: `+` adds a second note box and
  both persist in the PATCH body) all green.
- Live (real uvicorn + web dev server against the Demo library): the NOTES
  section renders (uppercase label + `+`); typing note 1, clicking `+`, typing
  note 2, and blurring persisted `notes = ["Synopsis…","Cast…"]` (confirmed via
  the API and a page reload); no console errors. After the single-source-of-truth
  cleanup, a fresh backend against the (existing) Demo library recreated the FTS
  view and both indexed notes: `q=xylophone` and a `note contains "penguins"`
  filter each returned only the bundle whose *notes* held those terms; the
  throwaway bundle was then deleted (Demo back to 21).
  The box refinements were also verified live: the `+` renders as a centered
  14×14 SVG icon; an auto-mode box grew to fit multi-line text (117 px, no
  clip); dragging each of two boxes to different heights stored
  `cairndex.noteHeights = {<bundle>: [121, 71]}` and both survived a same-origin
  reload, and removing the first box left the second keeping its own 71 px height
  (the stored array spliced to `[71]`). All Demo edits were reverted afterward, so
  the Demo library is unchanged for review. (Note: synthetic browser
  `input`/`blur` events don't drive React's controlled inputs / focusout
  `onBlur`; the real path is covered by `preview_fill`/`preview_click` and the
  Playwright case.)

Known issues / out of scope: `MultiBundleInspector` still has no notes field
(bulk-overwriting prose is intentionally omitted); collections keep their single
`note`. Next: the pre-M7 owner may proceed to plan 1 M7 (web HLS integration).

## In review: media-player M6 — playback decisions + HLS session foundation

Branch `feat/playback-sessions` (off `main` after the browser-terminology
rename). Implements plan 1 M6 server-side only — the web hls.js/native-HLS
engine integration is M7. Commit subject: `feat: playback decisions + HLS
remux/transcode session foundation`.

- **Decision matrix (§6.1).** Pure `media/playback.decide_playback` +
  `CapabilityProfile` decide `direct`/`remux`/`transcode` from the client's caps
  versus the source's M1 `tech_metadata` (container from extension, video/audio
  codecs, height). Container+codecs in caps → direct; codecs in caps but
  container not → remux; else transcode. A non-default audio track or
  unsupported audio codec forces at least remux; a burn-in subtitle or an
  over-height source forces transcode. Legacy rows missing M1 keys degrade
  safely (unknown codec optimistic, never 500). Container/codec alias
  normalization (`m4v`→`mp4`, `avc1`/`h265`→`h264`/`hevc`, `mp4a`→`aac`, …).
- **Decision endpoint (§6.1).**
  `POST /api/v1/libraries/{lib}/files/{id}/playback-decision`
  (`{caps, audio_stream_index?, burn_subtitle_track_id?, max_height?}`) returns
  `method`, `reason`, `stream_url` (direct) or `session {id, playlist_url}`
  (else), plus `duration`, `audio_streams`, `subtitles`, `chapters`,
  `storyboard_url`, and resume `progress`. Non-direct decisions **start** a
  session. `GET /bundles/{id}/playback` stays the playlist-level manifest.
- **HLS session manager (§6.2, ADR-0014).** New `media/hls.py`
  (`SessionManager`, in-process dict+locks, **not** the job queue) +
  `api/v1/playback_sessions.py`. `POST .../files/{id}/playback-sessions`
  (`{caps, start_s?, …}` → `{session_id, playlist_url, kind}`),
  `GET .../{sid}/index.m3u8` (VOD fMP4 playlist computed up front from duration,
  6 s target), `GET .../{sid}/{init.mp4|{n}.m4s}`, `DELETE .../{sid}`. One
  ffmpeg per session writes segments into
  `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` (server-local ephemeral, never
  inside a library package). Segment ahead of the encoder → bounded wait; far
  seek or backward seek → kill + restart at `t=n*6` (`-ss` + `-start_number`).
  Remux copies video with an AAC audio fallback (keyframe drift accepted);
  transcode is `libx264 veryfast` + `force_key_frames` for exact 6 s segments +
  a capped ladder honoring `max_height`, optional burn-in.
- **Bounds/lifecycle/security.** `CAIRNDEX_TRANSCODE_MAX_SESSIONS` (default 2;
  structured **429** `capacity_exhausted` beyond it), idle reaper
  (`CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`, default 60 s → kill + delete dir),
  teardown on DELETE and server shutdown (lifespan hook), optional decode-only
  `CAIRNDEX_FFMPEG_HWACCEL`. Session routes reuse the `LibrarySession` gate;
  random library-scoped session ids; ffmpeg args from server-side-resolved
  paths only; every ffmpeg call has a timeout/bounded wait and is killed on
  teardown (M3 no-timeout lesson applied). New `CapacityError` → 429.
- **Docs/artifacts.** ADR-0014 (proposed; owner ratification pending) + index;
  `docs/architecture.md` (new endpoints + transcode dir; resolved the
  transcode-cache-location debt item); CHANGELOG. Regenerated OpenAPI +
  `apps/web/src/api/schema.d.ts` (this time `npm run gen:api` reached the
  registry, so no manual patch was needed).

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check` /
  `ruff format --check` / `mypy src` / `pytest` all green (**368 passed**, one
  pre-existing Starlette/httpx deprecation warning). New tests:
  `tests/test_playback_decision.py` (caps × source matrix incl. legacy rows,
  normalization, session-kind, HTTP direct decision) and
  `tests/test_hls_sessions.py` (fake-ffmpeg stub covering
  start/serve/wait/far-seek restart/backward-seek restart/idle-reap/concurrency
  bound/teardown/library-scoping; ffmpeg argv builder unit tests; a real-ffmpeg
  integration test over a tiny generated MKV doing remux **and** transcode,
  skipped with a clear message when ffmpeg is absent; HTTP decision→session,
  playlist/segment serving, DELETE, and 429 capacity).
- Frontend: `npm run lint` / `format:check` / `typecheck` / `test`
  (**47 passed**) / `build` / `test:e2e` (**49 passed**) all green. No frontend
  source changed (M6 is server-side); e2e ran non-escalated this session.
- Live (real uvicorn against a temp data dir): the Demo library's MP4s
  (`space_race`, `deep_ocean`, `waves`) decided **direct**. A throwaway 300 s
  h264+aac MKV in a temp `/tmp` library (never the Demo or any Eagle library)
  was scanned+probed, then decided **remux** ("mkv container not in client
  capabilities"); the remux session served a VOD playlist (`no-store`),
  `init.mp4`, and media segments, and `DELETE` 404'd the playlist. (The
  keyframe-derived segment count is re-verified in the review-fix pass below;
  this initial run predated that fix.)
  A forced-transcode session far-seeking to segment 40 left `[40,41,42,43]` on
  disk with a gap before 40 — proving ffmpeg was killed and restarted at the
  seek point — and `DELETE` removed the dir. A left-idle session's transcode
  dir was removed and its playlist 404'd after the idle timeout (reaper), and
  server shutdown completed cleanly (sessions torn down).

### Review-fix pass (pre-merge, same branch)

Addressed 8 review findings (4 confirmed merge-blockers) on top of the M6 slice:

1. **Lock discipline (F1).** `serve_artifact` no longer holds the session lock
   across the stat-poll wait — only to read/update state and (re)start ffmpeg —
   so parallel init+segment fetches serve concurrently and teardown kills ffmpeg
   promptly (new test: teardown during an in-flight wait completes in <3 s, not
   `segment_wait`).
2. **Burn-in + seek (F2).** Burn-in runs now seek output-side (`-ss` after
   `-i`), keeping captions in sync after a far-seek restart; non-burn-in keeps
   the fast input seek. Unit-tested command placement.
3. **Unknown-duration decision (F3).** A non-direct decision on an un-probed
   row returns 200 with `session=null` and an annotated reason instead of 422.
4. **Audio-index validation + ffmpeg failure (F4).** `audio_stream_index` is
   validated whenever supplied (422 on unknown, including un-probed rows); a
   nonzero ffmpeg exit surfaces a structured **500** (`media_processing_failed`)
   instead of a restart→404 loop.
5. **Remux tail thrash (F5).** Measured: a 120 s clip with 36 s GOPs advertised
   20 uniform segments and triggered **6** ffmpeg restarts fetching them
   sequentially. Fix: remux derives its playlist from a one-time keyframe scan
   (ffprobe `-skip_frame nokey`), mirroring copy-mux splits → same clip now
   advertises **4** segments with **0** restarts (uniform grid remains a
   fallback when the scan fails). Transcode keeps the exact 6 s grid.
6. **Session reuse (F6).** A decision retry/reload with identical
   `(file_id, params)` reuses the live session instead of 429-ing against the
   bound; a real quality/audio switch changes `params` → a new session.
7. **Docs (F7).** `docs/deployment.md` documents the new env vars and the
   `{DATA_DIR}/transcode` scratch dir (ephemeral, safe to wipe, sizing).
8. **Refactors (F8).** Promoted `playback.effective_max_height`; extracted the
   shared resolve→decide→build→create endpoint helpers; removed dead
   `HlsSession.playlist_path`; cache the VOD playlist string on the session;
   `_segment_name` helper; wired `ahead_window`/`segment_wait`/keyframe timeout
   from `Settings`.

Fix-pass verification: full backend gate green (**380 passed**, +12 new tests,
same pre-existing deprecation warning); frontend `lint`/`format:check`/
`typecheck`/`test` (**47**)/`build`/`test:e2e` (**49**) all green (no frontend
source changed; OpenAPI + `schema.d.ts` unchanged — the fixes were behavioral).
Live re-run (fresh uvicorn): Demo MP4s decided **direct**; two identical remux
decisions returned the **same** session id (reuse); the remux playlist for the
throwaway 300 s MKV advertised **12 keyframe-derived** segments (a uniform grid
would be 50) and all 12 + init served sequentially with no restart thrash;
DELETE 404'd the playlist; a forced-transcode far-seek to segment 40 left
`[40,41,42,43]` on disk (restart observed); the idle reaper removed a left-idle
session's dir; shutdown was clean.

Known issues / out of scope: no web engine wiring yet (M7); embedded
subtitle extraction to servable text tracks is M8; hardware acceleration is
decode-only in this MVP (encode stays `libx264`); audio is copied only when the
source is already AAC, else transcoded to stereo AAC; the remux keyframe scan
adds a bounded one-time ffprobe cost at first play on large files (falls back to
the uniform grid on timeout). Next recommended media-player task: **plan 1 M7 —
web HLS integration** (`PlaybackEngine`/hls.js, quality/audio menus, burn-in
option).

## In review: browsing-surface terminology rename (Bundle Browser / File Browser)

Branch `refactor/browser-terminology` (off `main` after M5). Renamed the two
browsing surfaces product-wide: "Collection/Bundles View" → **Bundle Browser**,
"File View" → **File Browser**. Owner-requested full rename including the public
API.

- **Breaking API rename:** `GET .../file-view/entries` → `.../file-browser/entries`;
  OpenAPI schemas `FileViewEntryRead`/`FileViewListingRead` →
  `FileBrowserEntryRead`/`FileBrowserListingRead`. OpenAPI + `schema.d.ts`
  regenerated. The old route now 404s (verified).
- **Backend:** `services/file_view.py` → `file_browser.py` (+ `FileViewEntry`/
  `FileViewListing` → `FileBrowser*`), `api/schemas/file_view.py` →
  `file_browser.py`, `previews.file_view_preview_cache_path` →
  `file_browser_preview_cache_path`, endpoint `list_file_view_entries` →
  `list_file_browser_entries`, `tests/test_file_view.py` → `test_file_browser.py`.
- **Frontend:** `app/FileView.tsx` → `FileBrowser.tsx` (component `FileView` →
  `FileBrowser`, `useFileView` → `useFileBrowser`, `fileViewPreviewUrl`/
  `fileViewContentUrl` → `fileBrowser*`, `FileViewEntry`/`FileViewListing`
  types), `.file-view` CSS classes → `.file-browser`, `file-view` query keys →
  `file-browser`, `e2e/file-view.spec.ts` → `file-browser.spec.ts`.
- **Docs:** prose updated across product-brief, architecture, data-model,
  plans, ADR bodies, README, AGENTS. Preserved historical branch names
  (`feat/collection-view`, `feat/collections-and-file-view`) and the stable
  ADR-0007 filename slug (title/body now read "File Browser").

Verification: backend `ruff`/`ruff format --check`/`mypy`/`pytest` (`333
passed`); frontend `lint`/`format:check`/`typecheck`/`test` (`47`)/`build`;
Playwright (`49 passed`). Live: started the real backend against the Demo
library, confirmed `GET .../file-browser/entries` returns 200 and the old
`.../file-view/entries` 404s, and drove the web File Browser tab — directory
entries render via the new route with `.file-browser__*` styling and no console
errors. No behavior change; the surfaces work identically under the new names.

## Merged: media-player M5 image viewer v2 + preview derivatives (#5)

Branch `feat/image-viewer`, merged as **#5**. Implemented plan 1 M5's image
viewer v2 and preview derivative slice, then two review fix passes (the second
fixed a progressive-upgrade stall the first pass missed — see Verification):

- Added lazy WebP preview derivatives at
  `/api/v1/libraries/{library_id}/files/{file_id}/preview?size=640|1600|2560`
  with an allowlisted size ladder, safe source re-resolution, deterministic
  linked-file cache paths under
  `.cairndex/cache/previews/{file_id[:2]}/{file_id}_{size}.webp`, quick
  fingerprint sidecars, versioned `?v={quick_fingerprint}` URLs, and immutable
  cache headers. File Browser can also request
  `/api/v1/libraries/{library_id}/file/preview?path=...&size=...`; those
  unlinked path previews use a deterministic path-hash cache key and a
  stat-derived quick fingerprint.
- Extracted shared derived-cache helpers for immutable cache headers,
  version-param escaping, `.fingerprint` sidecars, and current-cache checks.
  Image previews and storyboards now use that shared sidecar convention;
  previews use per-artifact `fcntl` locks, atomic replacement, and a bounded
  decode semaphore.
- Added Pillow + pillow-heif as lazy preview-generation dependencies. They are
  pure-wheel runtime dependencies used only when a derivative must be generated,
  and they unlock HEIC/HEIF, TIFF, BMP, and sized WebP previews for browser and
  future TV clients. PSD is not advertised openable until a tested decoder path
  exists. Preview generation remains lazy-only in this slice; no
  Update/precompute job was added.
- Preview-capable images now count as supported/openable in bundle/file payloads
  and File Browser entries. HEIC/TIFF/BMP can therefore open in the media viewer
  through preview derivatives even when the browser cannot display the original
  source bytes. Preview-only cover thumbnails route through the Pillow preview
  pipeline instead of ffmpeg, so selected HEIC/TIFF/BMP covers do not fail the
  card thumbnail path.
- Replaced the bare image stage with a transform stage: fit/fill/100% mode
  cycling, wheel zoom to cursor, pointer-drag panning, two-pointer pinch zoom,
  keyboard `+`/`-`/`0`/`1` shortcuts scoped to the viewer, zoom clamping,
  viewport-clamped pan bounds, zoom-percent display, dark/light/checkerboard
  backgrounds, resize-aware fit capped at 100% for initial fit, progressive
  source swaps after `Image.decode()`, and keyed transform/source reset when the
  selected file changes. The loader keys its effect on the discrete wanted tier,
  preserving an in-flight decode across viewport scale-only rerenders. Native
  images load thumbnail → original; non-native images load thumbnail → 1600px
  preview and request 2560px only when zoomed past 100%.
- Regenerated OpenAPI and `apps/web/src/api/schema.d.ts` for the preview route
  and new file/browse support hints. `schema.d.ts` was patched manually for this
  pass because `npm run gen:api` could not reach the npm registry in the
  sandbox after OpenAPI regeneration.

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check`,
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff format --check`,
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run mypy src`, and
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run pytest` passed
  (`333 passed`, one existing Starlette/httpx deprecation warning).
- Frontend: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`47 passed`, existing jsdom media-method warnings), and
  `npm run build` passed.
- Focused review-fix checks also passed:
  `uv run pytest tests/test_previews.py tests/test_thumbnails.py
  tests/test_storyboards.py tests/test_file_view.py` (`44 passed`) and
  `npm run test -- ImageStage` (`6 passed`).
- OpenAPI was regenerated with
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run python -m
  cairndex.devtools.openapi > ../web/src/api/openapi.json`. `npm run gen:api`
  could not complete in this sandbox because `npx` waited on the registry path,
  so `apps/web/src/api/schema.d.ts` was patched manually to match the small
  OpenAPI delta.
- Playwright: non-escalated `npm run test:e2e` still fails before tests run
  because Vite cannot bind `::1:5173` (`listen EPERM`), but the escalated
  `npm run test:e2e` gate passed (`49 passed`). Native and non-native image e2e
  coverage now asserts the displayed `.mv-image` tier and source rather than
  only observing a request.
- Live Demo-library verification used `Photos/Vacation2025/Paris/eiffel.jpg`
  (600×800) at an 800×600 browser viewport. The actual image stage measured
  672×456 and opened at fit scale 0.57. With no interaction after open, a 10 ms
  sampler observed the displayed image advance from the bundle-file thumbnail
  to `data-tier="original"` with the `/files/{file_id}/content` source in about
  31 ms.
- Independent reviewer verification before merge (fix pass 2): all gates re-run
  green (backend 333, frontend unit 47, Playwright 49), and the same Demo
  `eiffel` bundle opened at fit 72% reached `data-tier="original"`
  (naturalWidth 600, `/content` source) with zero interaction, reproduced twice
  including a cold-cache first open. Review history: the first fix pass left
  `renderedTransform.scale` in the tier-load effect deps, so the mount →
  viewport-measure scale change cancelled the only in-flight `/content` decode
  and images never upgraded past the 480px thumbnail; the second pass keys the
  effect on a discrete `wantedTier` memo, stops cancelling in-flight decodes on
  re-run (a lifetime symbol invalidates them only on unmount; `key={file.id}`
  remounts on file switch), and the e2e now asserts the displayed `.mv-image`
  `data-tier`/src advance instead of only observing a network request.

## Merged: media-player M4 watch progress/resume (#4)

Branch `feat/watch-progress`. Implemented plan 1 M4's watch progress and resume
slice, then applied the review fix pass:

- Added `playback_progress` to each library DB via the existing additive
  bootstrap path, with `file_id` as the primary key/FK to `asset_files` and
  indexes for bundle lookup and continue-watching ordering. SQLite foreign keys
  are enabled by the shared engine pragma, so deleting an `AssetFile` cascades
  progress cleanup.
- Added `PUT /api/v1/libraries/{library_id}/files/{file_id}/progress` for
  idempotent video progress upserts, plus a POST alias for
  `navigator.sendBeacon`'s POST-only pagehide transport. The API schema
  validates finite non-negative seconds; the service clamps position to known
  duration, marks completion at `position_s / duration_s >= 0.95` only when
  duration is known and positive, and stamps `updated_at` via
  `core.time.utcnow()`. The web reporter sends the media element duration
  whenever it is finite and only sends `duration_s = null` when duration is truly
  unknown.
- Playback manifests now embed `progress` per `PlayableVideo`, batch-loading all
  listed videos' progress rows in one query. OpenAPI and
  `apps/web/src/api/schema.d.ts` were regenerated.
- Added
  `GET /api/v1/libraries/{library_id}/continue-watching?limit=20&offset=0`,
  returning the existing browse-summary row shape plus
  `progress: {file_id, position_s, duration_s}` for bundles with unfinished,
  non-zero video progress, newest progress first with a deterministic file-id
  tie-breaker.
- Moved-file repair continues to preserve progress for free because progress is
  keyed by stable `AssetFile.id`. The denormalized progress `bundle_id` is now
  aligned from a single `AssetFile.bundle_id` re-parent hook rather than
  per-call-site updates, and bundle/file deletion cascades progress cleanup
  through the active SQLite foreign keys.
- The web media viewer resumes unfinished videos once after `loadedmetadata`,
  shows a transient "Resumed at mm:ss — Click to restart" affordance, and reports
  progress every ~10 seconds of playback plus pause, close/unmount, and pagehide
  beacon. Changing files resets player time/duration/loading state before the
  next reporting window, restart explicitly writes position zero, and successful
  progress writes invalidate continue-watching only when completion state changes
  or when the viewer closes/unmounts. Bundle/file deletion invalidates
  continue-watching too.

Known issues / deferred: no dedicated Continue Watching web view was added in
this slice. The optional bundle-card progress strip was deferred because normal
browse payloads do not yet carry progress; only the required continue-watching
endpoint and viewer resume/reporting are wired. No HLS, image preview, or
multi-user behavior changed; `user_id = NULL` remains the owner convention.

Verification:

- Backend: focused review-fix check `uv run pytest tests/test_playback.py
  tests/test_scan_repair.py` passed (`19 passed`, one existing Starlette/httpx
  deprecation warning). Full backend gate also passed: `uv run ruff check`,
  `uv run ruff format --check`, `uv run mypy src`, and `uv run pytest`
  (`317 passed`, same existing warning).
- Frontend: focused review-fix check `npm run test -- usePlayer
  usePlaybackProgressReporter` passed (`11 passed`). Full frontend gate also
  passed: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`36 passed`), `npm run build`, and `npm run test:e2e`
  (`48 passed`).
- Manual Demo-library verification: ran the local app against
  `/Users/owner/DemoLibrary`, seeded Cosmos resume progress through the API,
  opened the viewer, verified the resume seek/affordance, captured
  `/private/tmp/cairndex-m4-resume-affordance.png`, clicked restart, and verified
  the manifest reported `position_s = 0` and Cosmos no longer appeared in
  continue-watching. The Demo library has no bundle with multiple video files, so
  live file-switch verification used Cosmos video → poster image and confirmed no
  progress write targeted the image file; the multi-video stale-position case is
  covered by the Playwright regression.

## Merged: media-player M3 storyboards/trickplay (#3)

Branch `feat/storyboards`. Implemented plan 1 M3's storyboard/trickplay and
chapter-tick slice:

- Added a registry-backed `storyboard` job type and worker handler. It scans
  available video files with probed duration, skips videos below
  `CAIRNDEX_STORYBOARD_MIN_DURATION` (default 60 seconds), can be disabled with
  `CAIRNDEX_STORYBOARDS=off`, dedupes queued storyboard jobs per library, reports
  `storyboarding` progress, and cooperatively honors cancellation before each
  file. Running storyboard jobs do not dedupe; a follow-up queued job can sweep
  files the in-flight pass missed.
- Storyboards are generated into deterministic portable cache paths:
  `.cairndex/cache/storyboards/{file_id[:2]}/{file_id}/index.vtt` plus
  `index.fingerprint` and `sb_*.jpg` 5×5 tile sheets. The sidecar stores the source
  quick fingerprint for cheap request-path validation; the VTT keeps the same
  fingerprint in a `NOTE` for artifact self-description.
- Added cached-only storyboard endpoints:
  `/api/v1/libraries/{library_id}/files/{file_id}/storyboard.vtt` and
  `/storyboard/{sheet}.jpg`. They never generate on request and return 404 when
  absent/stale/disabled. Served artifacts use immutable cache headers.
- Extended playback manifests with `storyboard_url` (null until a current cache
  exists, versioned with `?v={quick_fingerprint}`) and `chapters` from M1
  `tech_metadata`; regenerated OpenAPI and `apps/web/src/api/schema.d.ts`.
- Updated the web Update flow to run scan → probe as the blocking mutation, then
  enqueue storyboards fire-and-forget while reusing the existing sidebar job
  progress UI. Storyboard failures surface as their own job error state instead
  of failing Update. No new sidebar button was added.
- Added `StoryboardPreview` and a constrained WebVTT parser for seek-hover
  trickplay. The tooltip lazy-fetches once with `retry: false`, treats 404 as
  optional/no-preview, resolves VTT payloads like
  `storyboard/sb_001.jpg?v=...#xywh=...` by standard relative-URL rules, crops
  and scales tiles via CSS background positioning/sizing, and preloads
  neighboring sheets while scrubbing.
- Seek bar chapter starts now render visual ticks, and the hover tooltip shows
  the current chapter title beside the timestamp only inside chapter ranges or
  at/after the last chapter start. No chapter-skip keys were added.

Verification:

- Backend: `uv run ruff check`, `uv run ruff format --check`,
  `uv run mypy src`, and `uv run pytest` passed (`311 passed`, one existing
  Starlette/httpx deprecation warning).
- Frontend: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`26 passed`), `npm run build`, and `npm run test:e2e`
  (`45 passed`) passed.
- Playwright includes mocked hover coverage, 404 fallback coverage, and a real
  FastAPI/Vite integration test that generates a >60s fixture, runs the probe and
  storyboard jobs through the API, opens the viewer, and verifies the preview.
- Manual Demo-library verification: ran the local app against
  `/Users/owner/DemoLibrary`, clicked **Update**, opened `trailer_neon`, hovered
  the seek bar, verified the storyboard preview loaded from a versioned URL, and
  captured `/private/tmp/cairndex-storyboards-demo.png`. Demo videos are 4–6 seconds, so this manual run used
  `CAIRNDEX_STORYBOARD_MIN_DURATION=1`; production default remains 60 seconds.

Known issues / out of scope: no HLS/remux/transcode work, no subtitle upgrade, no
image zoom/pan, and no chapter-skip keys. Next recommended media-player task:
plan 1 M4 — watch progress/resume.

## Merged: media-player M2 unified media viewer (#2)

Branch `feat/media-viewer`. Implemented plan 1 M2's direct-play web viewer
slice without new runtime dependencies and without backend/API changes:

- Added `apps/web/src/app/viewer/MediaViewer.tsx` plus `VideoStage`,
  `ImageStage`, and `viewer/player/*` (`PlaybackEngine`/`NativeEngine`,
  `usePlayer`, `ControlBar`, `SeekBar`, shortcuts, idle-hide). The `HlsEngine`
  slot remains a later M8 extension.
- Replaced the old bundle playback modal and bundle-file lightbox entry points:
  bundle double-click, the inspector play affordance, and bundle-album file
  double-click now open the unified viewer. `Player.tsx` and `FileViewer.tsx`
  were removed.
- Direct-play videos now use custom auto-hiding controls, root fullscreen,
  PiP, MediaSession metadata/actions, snapshot PNG download, speed 0.25–3x
  with pitch preservation, volume/mute, buffered seek/scrub UI, subtitle
  on/off over existing external VTT tracks, and the M2 keyboard map scoped to
  the open viewer.
- Player preferences (`volume`, `muted`, `rate`, `subtitlesOn`) persist inside
  the existing `cairndex.prefs` localStorage object with legacy-default
  merging. Review fix pass: Workspace/App remains the single prefs writer,
  player updates are functional so same-tick writes compose, localStorage writes
  are debounced and flushed on pointer-up/page unload, and raising volume
  un-mutes consistently from keyboard or slider paths.
- The viewer handles loading, empty bundles, query errors, missing files,
  unsupported/unplayable videos, and image preview errors with structured
  fallback states. The inline bottom file filmstrip was removed after owner
  review because it overlapped the video control bar; current M2 navigation is
  previous/next only.
- Review fix pass hardened the native player mount path: `usePlayer` now keys
  engine creation, listener attachment, and persisted volume/mute/rate
  application on the actual `<video>` element identity; controller commands read
  live media time where needed; `PlaybackEngine` exposes an `on(event, cb)`
  listener seam for the future M8 HLS engine; MediaSession commands use refs
  while metadata depends only on title/artwork.
- Review fix pass also scoped shortcuts to the focused viewer root, made `Esc`
  exit fullscreen before closing, lets left/right step files when no playable
  video is active, shares one filtered subtitle source list with native
  `<track>` identity/default-track selection, uses shared fallback cards for
  Media Viewer and File Browser, and replaced emoji control glyphs with SVG icons.
- Reviewer verification pass (live, against the local Demo library): cold-cache
  open shows a live clock/seek bar/play state (the original mount-race is
  fixed); player prefs survive subsequent browse-pref writes; muted slider
  drags land exactly and unmute; image files arrow-step between bundle files;
  Esc closes the viewer when not fullscreen (entering fullscreen can't be
  exercised in the headless preview — that branch is code- and unit-test
  verified; worth one manual spot check). One residual bug found and fixed in
  the same pass: Chromium's automatic text-track selection could flip a
  second language to `showing` after its cues loaded, stacking two subtitle
  lines on initial open — `VideoStage` now re-asserts track modes on each
  `<track>` load event (verified live on the two-subtitle DeepOcean bundle:
  only the selected track shows, and disabled tracks skip their cue fetch).
- File Browser still uses `FileEntryViewer` with path-based URLs and native
  browser controls, but now shares the fallback card component. Follow-up:
  migrate File Browser onto the same viewer/stage primitives when plan 1 reaches
  the path-based File Browser completion work.
- Follow-up recorded in plan 1: replace the removed inline file list with an
  expandable bundle-files side panel, and expand the right-side metadata panel
  into a first-class file/bundle metadata drawer.
- Dev tooling: `apps/web/vite.config.ts` honors a `PORT` environment override,
  and `.claude/launch.json` uses automatic port assignment.

No Pydantic/OpenAPI surface changed, so OpenAPI and
`apps/web/src/api/schema.d.ts` were not regenerated. Next recommended task for
the media-player track: plan 1 M3 — **storyboards/trickplay** (the owner
re-sequenced plan 1 after M2: subtitle depth moved to M8 behind HLS, and dual
subtitles are far-deferred to M9 at the earliest).

Verification: frontend `npm run lint`, `npm run format:check`,
`npm run typecheck`, `npm run test` (18 tests), `npm run build`, and
`npm run test:e2e` (41 Playwright tests) passed. Player e2e now includes an
unmocked tiny ffmpeg-generated MP4 smoke test that verifies real media time and
the visible clock advance; it skips with a clear message when ffmpeg is
unavailable. Manual verification against the local Demo library
(`/Users/owner/DemoLibrary`) used a cold browser page on `trailer_neon` and
confirmed the real stream advanced to `0:01 / 0:04` with persisted
`volume=0.5`, `muted=true`, and `rate=1.25`; screenshot captured at
`/private/tmp/cairndex-media-viewer-demo.png`. Backend gates were not run
because this slice did not touch backend code.

## Merged: media-player M1 probe enrichment (#1)

Branch `feat/probe-enrichment`; latest commit subject:
`feat: enrich media probe metadata`. Implemented plan 1 M1 server probe
enrichment for the first-class media-player foundation:

- `ffprobe` now runs with `-show_chapters` and stores additive
  `AssetFile.tech_metadata` keys: `audio_streams` (all audio streams with
  index/codec/channels/language/title/default), `subtitle_streams`
  (index/codec/language/title/default/forced), `chapters` (float-second
  start/end/title), `hdr` (`hdr10`/`hlg`/`dv`/`null`), `bit_depth`, and
  `probe_version`.
- Existing metadata keys used by current playback and browse flows remain
  present and compatible: `width`, `height`, `duration`, `video_codec`,
  `audio_codec`, `embedded_subtitles`, etc. `embedded_subtitles` remains in the
  legacy shape consumed by embedded subtitle-track sync.
- The existing **Collect metadata** probe job still uses the `probe` job type but
  keeps its normal empty payload. Routine probes skip only rows whose
  `tech_metadata.probe_version` matches the current probe version, so rows
  probed before M1 refresh once and future Updates stay incremental. Internal
  callers can still use `probe_library(..., reprobe=True)` for explicit full
  re-probes.
- No database schema, migration, OpenAPI, or frontend API type changes were
  needed because `tech_metadata` remains an opaque JSON dictionary on the
  existing API surface.

Tests/verification: backend `uv run ruff check`, `uv run ruff format --check`,
`uv run mypy src`, and `uv run pytest` are clean (`301 passed`, one existing
Starlette/httpx deprecation warning). Focused tests cover canned HDR
classification, generated multi-audio/subtitled/chaptered media, the existing
Collect metadata version-refresh path, current-version incremental skips, and
legacy `tech_metadata` playback-manifest degradation. Manual verification probed
a throwaway generated library and showed the new keys on a
multi-audio/chaptered/subtitled MKV.

Known issues: none for M1. M2 has since merged; next recommended media-player
task is plan 1 M3 — storyboards/trickplay (subtitle depth was owner-deferred
to M8 behind HLS; dual subtitles to M9+).

## Earlier: client platform & media experience plans (docs only)

Branch `docs/client-platform-plans` (repo renamed VaultLeaf → Cairndex; this is
the first work in the new repo). Owner-requested detailed technical plans for
three post-first-release initiatives, plus the cross-cutting server foundations
they share:

- `docs/plans/README.md` — strategy overview, reuse map, repo strategy
  (desktop shell in this monorepo at a future `apps/desktop`; Android TV in a
  future separate `cairndex-android` repo), shared server foundations, and the
  recommended phase order (server foundations → web player/viewer → HLS →
  desktop shell → TV → multi-video wall).
- `docs/plans/01-web-media-player-and-viewer.md` — unified media viewer,
  custom headless player (probe enrichment, embedded-subtitle extraction,
  storyboards/trickplay, watch progress, image preview derivatives, playback
  decision endpoint, bounded HLS remux/transcode sessions, hls.js
  integration, zoom/pan image stage), 9 milestone slices.
- `docs/plans/02-android-tv-client.md` — technology study (native
  Kotlin/Compose for TV + Media3 chosen over web/RN/Flutter), repo/module
  layout, device pairing/bearer tokens, 10-foot browse UX, player, and the
  priority **video wall** (1×2/2×2) with decoder-budget policy, 8 milestones.
- `docs/plans/03-macos-desktop-app.md` — Tauri 2 shell hosting `apps/web`,
  platform abstraction seam, manifest-UUID-validated library path mappings,
  reveal/open-with (ADR-0007), drag-out/drag-in, native menus, 5 milestones.
- `docs/adr/0012-client-platform-strategy.md` — **accepted (owner-ratified
  2026-07-04)** after a decision-by-decision review: Tauri 2/WKWebView
  confirmed for macOS (Electron is the recorded fallback), custom headless
  player confirmed with the UX bar set to desktop-native players
  (**Movist/Elmedia/IINA** — Eagle's own player is explicitly *not* the
  playback reference), and a separate `cairndex-android` repo confirmed for
  the TV client. Plan 1 gained the Movist/Elmedia-inspired features (dual
  simultaneous subtitles, subtitle styling, A-B loop, snapshot capture,
  video adjustments, configurable seek step) and a new M9 polish slice.
  Also fixed the stale ADR index (0011 was missing).

Post-ratification owner additions (same day): confirmed seek-bar hover
trickplay is covered (plan 1 §4.2/M4), and requested two non-priority export
features now specced as plan 1 §10 + milestone M11 — **GIF-from-snippet** and
**contact-sheet generation** (metadata header + timestamped frame grid),
server-generated via bounded interactive export tasks, download-only (never
written into the library root), desktop-first with native save/notification
hooks in plan 3 D5, web included, TV excluded.

Owner then prioritized **library write mode** as the next major initiative
after the core player (ahead of desktop/TV), so it is now planned in full:
`docs/plans/04-library-write-mode.md` + **ADR-0013 (accepted — owner-ratified
2026-07-04)**. Design pillars: per-library opt-in gate stored in the
registry (never the portable manifest) + deployment master switch;
trash-first deletion into `.cairndex/trash/` with a `trashed` availability
state so restores are lossless; a `file_operations` journal in `library.db`
(intent-before-action, reconciler on open, Undo); in-app move/rename updates
`relative_path` preserving `AssetFile.id` (no repair needed by construction);
no in-place overwrites — path collisions surface an Eagle/Finder-style
**Replace / Skip / Keep both** prompt (owner requirement) where Replace is
journaled trash-then-write, recoverable until Empty Trash; bulk ops as jobs
on the existing single-worker queue.
Slices W0–W6; W2 closes the exports-into-library open item (save contact
sheet/GIF, link to bundle, set as cover); W5 enables the desktop drag-in
copy. Note: W0 must amend the AGENTS.md/CLAUDE.md "never rename/move/delete"
safety wording to carve out journaled write-mode operations (recorded in
ADR-0013 consequences).

No code changes; no gates run (docs-only). Next recommended task for this
track: plan 1 M1 (probe enrichment). The pre-existing next tasks below still
stand for the core web app.

## Latest merged: collection & bundle ordering UX (#47)

Merged as **#47** (`feat/collection-bundle-ordering`). Six reviewable slices plus
five rounds of review-feedback follow-ups (summarized below):

- **Slice 0 — data model.** New `asset_bundle_collections.sort_order`
  (per-collection bundle order) and `asset_bundles.manual_order` (global bundle
  order), both `server_default 0`, patched into existing library DBs via the
  additive `ensure_content_indexes` bootstrap (no migration chain).
- **Slice 1 — collection ordering.** Collections order by `sort_order` (name
  tie-break) in both the sidebar tree and the main-browser folder cards; native
  drag-reorder in either surface updates both (`PUT …/collections/reorder`).
  `create_collection` appends after siblings. "Clean up by… Title" A–Z/Z–A
  (`POST …/collections/cleanup-order`). Shared `moveBefore()` + `CleanupOrderDialog`.
- **Slice 2 — bundle manual order.** `BundleSort.MANUAL` (membership order inside
  one collection, global `manual_order` elsewhere); Toolbar **Manual** sort +
  drag-reorder in `Browser`; "Clean up by…" over the five toolbar sorts × asc/desc
  (`PUT …/bundles/reorder`, `POST …/bundles/cleanup-order`). Drag is best-effort
  over the loaded window; cleanup is the deterministic full-scope rewrite.
- **Slice 3 — flatten subcollections.** "Show subcollection contents" now also
  flattens every descendant collection into the Subcollections section
  (depth-first, manual order).
- **Slice 4 — folder-card context menu.** Right-click folder cards → Delete
  Collection / Delete N Collections (multi-select); generalized
  `RemoveCollectionDialog` for multi-delete.
- **Slice 5 — decoupled sizing.** Folder cards follow their own smaller curve off
  the shared zoom slider (`collectionCardWidth`, max ~180px by mid-slider); slider
  floor dropped to 80px.
- **Slice 6 — Shift-range select** for bundle cards and folder cards.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` **288
passed** (new: engine ensure-columns in `test_models`, collection reorder/cleanup/
append in `test_taxonomy`, bundle MANUAL ordering + reorder/cleanup in
`test_browse`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build` clean;
Playwright **37 passed** (new `e2e/ordering.spec.ts`). Manually verified against
the local Synthetic Library via the browser preview (decoupled sizing, Manual sort
+ Clean up button, flatten → 165 descendants, folder Delete-Collection menu,
Shift-range select) plus a reversible live `collections/reorder` round-trip
(swapped then restored the root order). OpenAPI + `schema.d.ts` regenerated.

Out of scope / known limitation: bundle drag-reorder only rewrites the loaded
window (use "Clean up by…" for a full deterministic order); reparenting collections
by drag is not a gesture here (drag reorders within a sibling group only).

**Follow-up refinements (same branch, review feedback):** bigger folder
thumbnails (cap ~2/3 of the slider — see `collectionCardWidth` in
`apps/web/src/app/layout.ts`); "Clean up…" moved out of an inline button into the
folder-section / empty-grid right-click menus and the sidebar Collections heading;
foldable **Collections**/**Smart Collections** sidebar sections (hover caret +
highlighted label); the **Show subcollection contents** toggle now also appears in
the All view; drag-reorder reworked to **gap insertion** with an accent
insertion-line (replacing the edge highlight) across the bundle grid, folder
cards, and sidebar; **Manual** is now the first/default sort (persisted prefs
remember any later choice); a new **sort-control popover** (`SortControl.tsx`) with
sort field, asc/desc, and a **per-collection** scope checkbox (each
collection/view remembers its own sort); card text no longer highlights during
multi-select; double-click-to-open / single-click-metadata confirmed. New
`cairndex.sidebar.*` + expanded `cairndex.prefs` (sortScope/collectionSorts)
persisted keys; `e2e/ordering.spec.ts` updated (6 specs). All gates green;
Playwright 39 passed.

**Second follow-up round (review feedback):** chevron fold icons (bigger on the
sidebar section headings); the **All tab** now shows top-level collections +
*uncategorized* bundles by default and flattens to everything with the toggle
(there is no global manual order — reorder/"Clean up…" are disabled and greyed
when flattened); **cross-surface drag** to reparent collections (center = into,
edge = reorder) and move bundles into a collection (Alt = add without removing),
in both the sidebar and the main browser (`app/dnd.ts` `DragItem`/`dropZone`,
App-level `dragItem`, `PATCH …/collections/{id}` `parent_id` reparent, batch
add/remove for bundle moves); bundle-album file selection (click/drag/Shift, the
inspector keeps the bundle) + **"Locate in File Browser"**; drag-select on **list
rows** (bundle + file views) and Shift-range file selection. All frontend gates
green; Playwright 39 passed. Verified in the browser against the Synthetic Library
(incl. a reversible live reparent + move round-trip).

**Third follow-up round (review feedback):**

- Fold arrows reverted to a **solid disclosure triangle** (slightly larger, kept
  narrow) — `IconChevron` in `app/icons.tsx`, `.chevron`/`.chevron--lg` sizes.
- **Collection drag-reorder reliability:** the drop zone is recomputed from the
  cursor at drop time (a stale hover slot no longer turns a reorder into a
  reparent); cross-parent edge drops reparent+reorder (`moveCollection` in
  `App.tsx` = `PATCH parent_id` then `collections/reorder`), so a subcollection
  can be dropped out to the **top level**; a `CollectionListEnd` drop zone below
  the last sidebar row catches drags "behind the last collection".
- **Alt/Option bundle drag** fixed on macOS (drag advertises `copyMove` +
  reflects copy/move cursor) so add-to-collection-without-removing works.
- **Stuck "drop into" highlight** fixed by gating folder-card / sidebar-row drop
  feedback on the live `dragItem` (a bundle drag begins in the Browser and never
  fires those surfaces' `onDragEnd`).
- **File Browser directories** now join drag-select + Shift-range select like
  files (bundling targets still filter to files).
- **"Review grouping" → "Suggest grouping" (ADR-0011):** the manual action now
  re-proposes grouping for every **uncategorized** bundle (incl. confirmed ones
  whose collections were removed) + unbundled files; **Update**/scan keeps the
  narrower `new` scope. Suggestion scope added to `grouping/service.py`
  `gather_observations(scope=…)` + `plan_store.generate_plan(scope=…)`; the
  manual `POST …/grouping/plans` selects `uncategorized`. Internal
  provisional/confirmed state kept (apply still protects confirmed bundles); the
  user-facing **"Needs review" badge removed**.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 291 passed** (new
`tests/test_grouping_scope.py`). Frontend `lint`/`format`/`typecheck`/`vitest`/
`build` clean. Browser-verified the triangle icon and the "Suggest grouping"
rename / removed review badge against the Synthetic Library; native DnD and the
File Browser weren't exercisable there (synthetic files aren't on disk), and the
manual suggest pass is too heavy to run live over 33k uncategorized bundles —
covered by unit/service tests instead.

**Fourth follow-up round (review feedback):**

- Fold caret made **much narrower** (`.chevron` 9×13, `--lg` 11×15;
  `.collection-row__toggle` 12px) so it barely widens a row.
- **All tab reverted** to "every top-level collection + every bundle flattened";
  the "Show subcollection contents" toggle is gone from the All view (kept inside
  a collection), and bundle reorder / Clean Up are disabled there (`isAllView`
  gating in `App.tsx`; `browseView` no longer special-cases `uncategorized`).
- **Reorder past the content edge** now lands at the beginning/end via
  container-level drop handlers (`Browser` root, `CollectionHeader` `.collhead`),
  plus the existing sidebar `CollectionListEnd`.
- **Drag hint** pinned lower-left (`.drag-hint`, driven by App `dragItem`): plain
  = move, ⌥ Option = copy (bundles).
- **File Browser list drag-select** no longer draws a rubber-band box (row
  highlight only in list; box kept in grid) — `Browser`/`FileView` gate the
  `.marquee` on non-list / grid layout.
- **File Browser "Date Added"** column + sort: `created_at` added to
  `services/file_view.FileViewEntry` (+ schema, OpenAPI/client regenerated) from
  `st_birthtime`/`st_ctime`; FileView shows a column and a sort option. New
  `test_file_view` assertion.
- **Sidebar order:** Unbundled moved above Missing Files (`SYSTEM_VIEWS`); All
  Tags moved to the bottom of the system section.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 292 passed**; frontend
gates clean, **Playwright 39 passed** (updated the empty-space Clean Up spec to
enter a collection first). Browser-verified the narrow caret, the All-tab counts
(313 top-level collections + 100k bundles, no toggle), the sidebar order, the
lower-left drag hint, and the File Browser "Date Added" sort option against the
Synthetic Library. The reorder-past-edge and list drag-select (real files) rest
on the gates + code review (native DnD / on-disk files aren't exercisable in the
Synthetic Library).

**Fifth follow-up round (review feedback):**

- **Sidebar collection tree redesign:** compact rows (`.collection-row` gap 3 /
  4px inset), and hierarchy guide rails via a rebuilt shared `PickGuides`
  (ancestor `trail: boolean[]` + `isLast` → per-level vertical rule + elbow that
  bends into the last child). Threaded `trail`/`isLast` through `CollectionBranch`.
  `.pick-guide` CSS now centres the line and draws the elbow; `--guide-bleed`
  joins rails across rows. Same guides shared by the tag/collection pickers.
- Distinct icons (`icons.tsx`): `IconFolderQuestion` (Uncategorized),
  `IconTagQuestion` (Untagged); All Tags keeps the plain tag.
- File inspector: **Date Added** + **Date Modified** (renamed) with time
  (`formatDateTime`). Removed the **"openable"** list badge (updated two e2e
  specs to assert its absence). Restored the list-view marquee box (the prior
  removal was wrong). Terser drag hint.
- **Edge-drop:** the sidebar end-of-list drop zone expands to 72px min-height
  while a collection drag is live.

Verified: frontend `lint`/`format`/`typecheck`/`vitest`/`build` clean,
**Playwright 39 passed**. Browser-verified the compact tree + guide rails
(elbow/last-bend via classes; line aligns to the parent caret, matching Eagle),
the distinct Uncategorized/Untagged/All-Tags icons, and the drag hint text
against the Synthetic Library. No backend changes this round.

## Previously merged: ad-hoc filters + tag management (#46)

Eagle-like ad-hoc filtering + tag management, merged as **#46**
(`feat/adhoc-filters-tag-mgmt`), in three reviewable slices on top of `main`
(which already included the collection-view GUI rework, #45).

- **Slice 1 — ad-hoc Tags filter.** A funnel button in the bundle toolbar reveals
  a filter row with a **Tags** chip. Its popover has an Any/All/Equal rule + a
  subtags toggle, tag-group tabs (display-only scoping), search, and a tag tree:
  left-click includes, right-click excludes (mutually exclusive; browser context
  menu suppressed). Counts are **faceted** — a new
  `POST /filters/facets` endpoint returns tag/rating counts scoped to the current
  browse context and the *other* active categories (never global static counts),
  with parent-tag counts rolled up as distinct-bundle counts in Any/All or direct
  in Equal. `apply_scope()` was extracted in `services/browse.py` so the grid,
  its counts, and facets scope identically. Tag Equal/direct needs no new AST —
  it maps to `contains_any` with `include_descendants=false`.
- **Slice 2 — Rating filter.** A rating-specific `is_null` compiler operator
  (Unrated). Toolbar Rating chip = star row + `=`/`≥`/`≤` + an Unrated row; the
  Smart Collection editor's rating row uses the same star picker and an "is
  unrated" operator, so saved collections round-trip it.
- **Slice 3 — All Tags page.** A sidebar entry (below Untagged) opens a
  management surface (`mode='tags'`): left panel (All / Uncategorized / groups,
  each with a tag count) + an Eagle-style, pinyin-segmented, multi-column
  **accordion grid** of top-level tags that expand in place to reveal children
  (folded = rolled-up subtree count, expanded = direct). **Drag reparents** a tag
  (onto another = nest; onto empty space = top level); the tree is name/pinyin
  ordered, so manual sibling ordering was dropped (the `PUT /tags/reorder` and
  `PUT /tag-groups/{id}/tags/order` endpoints were removed). Backend safe tag
  delete blocks a
  parent with children. Double-clicking a tag applies a global Equal/direct
  filter. (Initial cut was a single-column drag-reorder tree; reworked per review
  into the accordion grid with reparent-by-drag.)

Both toolbar filters and Smart Collections compile to the one canonical
FilterExpression AST and stack under AND with the view/collection and text search.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` green
(new `test_facets.py`; rating/tag/reorder cases in `test_filters.py`/
`test_taxonomy.py`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build`
clean; Playwright green (new `e2e/filters.spec.ts`, `e2e/all-tags.spec.ts`, plus
the Smart Collection unrated round-trip). Manually exercised against the local
Demo Vault (Tags include/exclude, Rating stars + Unrated=22, All Tags page,
double-click→global Equal filter) — all metadata-only, no demo data mutated.

Out of scope (explicit follow-ups): Types filter, Collections toolbar filter,
Starred tags, exact tag-set equality, URL/localStorage persistence of ad-hoc
filters.

## Earlier: `feat/collection-view` (merged, #45)

GUI-only work. Treat this section as the collection/browse UI history; the rest
of this doc is backend/maintenance history.

Latest session's changes (frontend-only, no backend files touched):

- **Subcollection cards get the same left-click marquee drag-select as the
  bundle grid** (`useMarqueeSelect`, scoped to `.collcard__grid`/`.collhead`
  so a drag there can't also pick up bundle cards), plus click-on-empty-space
  deselects. Subcollection selection (`selectedCollectionIds: Set<string>`)
  and bundle selection (`selectedIds`) are mutually exclusive — selecting one
  clears the other.
- **The "All" view now shows root-level collections as cards** above the
  bundle grid, via the same `CollectionHeader` component used inside a
  collection (generalized with a `sectionLabel` prop: "Collections" at the
  root, "Subcollections" inside a collection).
- Folder cards got a **stacked-sheet visual** (offset box-shadow "sheets")
  and their footer shows **both** the direct bundle count and the
  subcollection count.
- **Collection and bundle titles commit on Enter**, not just blur.
- Fixed: bundle cards showed a duration badge on image bundles when the
  primary file's metadata had a stray `duration` — now gated on `media_kind
  === 'video'`.
- **Removed the top "batch bar"** (`BatchBar.tsx`, deleted) for 2+ selected
  bundles. Replaced with a right-panel `MultiBundleInspector`: title
  overwrites all, rating shows the common value (or unset) and overwrites all,
  tags/collections common to every selected bundle show as assigned and
  toggling adds/removes across the whole selection (via the existing
  `POST /bundles/batch` endpoint — no backend change needed), size/files are
  summed. No note field (bulk-overwriting prose doesn't make sense). New
  hooks: `useCommonBundleTags`, `useCommonBundleCollections`,
  `useBulkUpdateBundles` (parallel PATCH per id, no `If-Match` — a bulk
  overwrite is an explicit one-shot action and per-row versions aren't loaded
  in the browse grid).
- Right-click context menu items are now consistently Title Case.

Verified: frontend `lint`/`format:check`/`typecheck`/`vitest` (9)/`build`
clean; Playwright **24/24** passed (added a subcollection-marquee test and
rewrote the multi-select test for the new right-panel editor). Manually
exercised in the browser preview (marquee + deselect on both bundles and
subcollections, Enter-commit on both title fields, bulk rename/rating/
tag-picker/collection-picker on a real 2-bundle selection against the local
demo library, then reverted those demo-data edits via direct API calls so the
demo library is unchanged for review).

**Follow-up fixes session (same day):**

- **Fixed a marquee-drag runaway-scroll bug.** The drag-selection overlay was
  sized from raw, unclamped mouse coordinates; dragging past the loaded
  content inflated the container's scrollable area (since the overlay is an
  absolutely-positioned child of an `overflow: auto` container), and because
  that gave auto-scroll more room to advance — which let the overlay grow
  further — the two fed each other every animation frame. A ~400px drag
  paused near the bottom edge for ~1s inflated one container's scrollable
  height from 232px to 14,198px, confirmed via direct DOM measurement before
  and after the fix. Fixed in `useMarqueeSelect.ts` by clamping every
  content-space point to the wrapper's true `scrollWidth`/`scrollHeight`,
  measured once at drag start (before the overlay exists) — applies to both
  the bundle grid and the collection cards (shared hook). No dedicated
  automated test added (hard to assert scrollHeight growth reliably in
  Playwright); verified via direct `scrollHeight` measurement in the browser
  preview before/after, with mouseup/mousemove sequences reproducing the
  original bug.
- **"Create '<search>'" in the tag/collection pickers.** Typing a search (in
  the single-bundle TagEditor/CollectionPicker, and the multi-bundle bulk
  editor's pickers) shows a "+ Create "…"" row whenever the search doesn't
  already name an existing tag/collection *exactly* — including when it's a
  substring of one (searching "Act" while "Action" exists still offers to
  create "Act", alongside the "Action" partial match; first cut only showed
  it when there were zero matches at all, corrected same-day per feedback).
  Clicking it creates a top-level tag/collection and assigns it immediately.
  New `POST /tags` client call + `useCreateTag` hook (the endpoint already
  existed; only the frontend was missing). e2e-covered (both single-bundle
  pickers, incl. the partial-match case); the multi-bundle picker's create
  path shares the same `BulkPicker` component and is exercised the same way
  manually.
- Empty-inspector placeholder now says "Select a bundle or collection…".
- Confirmed (not a bug): a collection with only subcollections and no direct
  bundles already resolves its cover correctly from anywhere in its subtree
  (`resolve_cover_bundle_id` walks the full recursive descendant set, not
  just direct children) — covered by
  `test_collection_cover_prefers_chosen_bundle_then_auto_picks`.

Verified: frontend gate green again (lint/format/typecheck/vitest 9/build);
Playwright **27/27** (3 create-tag/create-collection tests, incl. the
partial-match case). Manually verified the runaway-scroll fix and all create
flows (incl. partial-match) in the browser preview against the real demo
library, then reverted the demo-data mutations (2 created tags + 1 created
collection, across both rounds) via direct API `DELETE` calls.

Not yet a PR — branch also carries the prior collection-view slices (picker
redesign, empty-collection sidebar fix, collection inspector, cover cards)
from earlier sessions.

## Latest merged milestones

Maintenance-readiness sequence, merged as four independent PRs (#38–#41):

- **#38 — Job progress & observability (`feat/job-progress-observability`).**
  Scan/probe/thumbnail jobs report a coarse `phase` + `message` with throttled
  registry progress writes and path-redacted terminal errors; the sidebar shows
  a live determinate/indeterminate progress bar under Update.
- **#39 — Large-library perf baselines + indexing (`perf/large-library-baselines`).**
  `cairndex.devtools.synthetic_library` + `benchmark_queries` devtools; measured
  SQLite indexes (`asset_files.bundle_id` + association-table reverse indexes,
  backfilled by `ensure_content_indexes` on library open) and a non-correlated
  membership **semijoin** in the filter compiler and browse. Browse went from
  ~5.4 s to ~12 ms and view-counts ~12 s to ~14 ms at 5k bundles; all paths stay
  interactive at 100k. Baselines in `docs/performance.md`.
- **#40 — Whole-library indexed search (`feat/indexed-metadata-search`).**
  Per-library `bundle_search` FTS5 index (title/note, file
  title/filename/path/source/media-kind, tag + collection names) kept fresh by
  SQLite triggers; browse gained a `q` param composed as an FTS semijoin;
  `cairndex.devtools.reindex_search` rebuilds it. The toolbar search now covers
  the whole library, not the loaded window.
- **#41 — Per-library passphrase lock (`feat/per-library-passphrase-lock`, ADR-0010).**
  Optional owner passphrase per library (PBKDF2 hash in the manifest), unlocked
  via a library-scoped in-memory server session (opaque HTTP-only cookie), gated
  in `get_library_session`; `set_passphrase` CLI + frontend LockScreen. A private
  LAN/Tailscale guardrail, not public-internet hardening or multi-user auth.

Before this sequence, PR #37 (`feat/remove-and-context-menu`) added web-UI
removal of bundles/collections and right-click context menus (metadata-only,
`cascade` param on `DELETE /collections/{id}`).

## Earlier branches

ADR-0008 / ADR-0009 work landed on `feat/scan-grouping-review`.

ADR-0008 is implemented: Cairndex now uses portable per-library metadata
packages (`<root>/.cairndex/{manifest.json,library.db,cache/}`) plus a separate
server-local registry DB for registered libraries and the runtime job queue. The
old global storage-root content model and Eagle importer are removed from the
current product path.

ADR-0009 (suggestion-based bundle grouping, Option A+) is functionally rolled
out. The scanner still performs conservative discovery/repair first and stages
new files as provisional bundles. Scan jobs now also persist a durable grouping
plan without applying it, so grouping remains a user-reviewed decision.

PR 36 was the UI/workflow follow-up before the removal/context-menu milestone:
the sidebar exposes one primary **Update** action, with individual **Scan new
files**, **Collect metadata**, and **Review grouping** actions in the overflow
menu. Update waits for scan/grouping plan generation and ffprobe metadata
collection, invalidates affected queries, and opens grouping review when a scan
produced suggestions.

## Earlier milestone: unbundled staging + manual bundling assistant

> Historical note (long merged). The current work is the media-player
> foundation — see the M1–M4 sections at the top of this file and
> `docs/plans/` for the roadmap.

**Unbundled staging + manual bundling assistant (branch
`feat/manual-bundling`).** Scan-staged provisional bundles are now surfaced only
in a dedicated **Unbundled** view (hidden from All/Recent/Collections), and a new
`cairndex.manual_bundling` service + `/manual-bundling/*` API + web dialogs let
the owner turn unbundled files into confirmed bundles by hand with automatic,
never-auto-applied suggestions. All metadata-only; see the notes below and
`CHANGELOG.md`. Two follow-up fixes on top: removing a file from a bundle (the
inspector ×) now re-stages it back into **Unbundled** instead of unlinking it
(shared `_restage_file` helper with `delete_bundle`), and a changed cover now
shows without a manual refresh via a `cover_key` cache-buster on browse summaries
and the inspector thumbnail URL. Backend `uv run ruff check/format --check/mypy`
clean, `pytest` 265 passed; frontend typecheck/lint/format/test/build clean and
Playwright 17 specs pass (incl. `e2e/manual-bundling.spec.ts`). Not yet merged.

**Maintenance-readiness sequence complete (#38–#41).** Job progress, large-library
browse indexing + benchmark tooling, whole-library FTS5 search, and an optional
per-library passphrase lock all landed. The next candidates are richer
edit-before-apply grouping review, File Browser write-mode planning, and search
relevance ranking (see *Next recommended tasks*).

The grouping/maintenance flow it builds on is unchanged — the normal maintenance
path matches the intended product model:

1. scan the active library root;
2. repair high-confidence moves without changing original files;
3. stage new files in provisional bundles;
4. generate and persist a reviewable grouping plan;
5. collect technical metadata;
6. let the user accept selected grouping proposals.

Applying a grouping plan is the only operation that confirms scan-staged
bundles, creates suggested logical collections, assigns roles, selects
cover/primary files, links external subtitles, or adds newly discovered files to
an existing confirmed bundle. It never moves, renames, deletes, or rewrites
original files.

## Current implementation notes

- **Primary maintenance flow:** **Update** is the main sidebar action. It runs
  scan + grouping-plan generation first, then probe. The overflow menu keeps
  scan-only, probe-only, and review-only actions for exception cases.
- **Grouping review:** The modal shows the persisted plan, explains that
  regeneration reruns the same heuristic against current library state, and
  supports checkboxes, cascading parent toggles, **Select all**, **Deselect all**,
  and **Accept selected**.
- **Selected accept semantics:** `POST /grouping/plans/{id}/apply` accepts an
  optional `proposal_ids` list. When supplied, only those proposals are applied;
  the plan is then marked applied, so unchecked proposals are intentionally left
  unapplied for that plan. Regenerate suggestions after library changes if the
  owner wants a fresh plan.
- **Unbundled staging (file-first):** scan-created provisional bundles
  (`grouping_state = provisional`, `grouping_source = scan_suggestion`) are treated
  as *unbundled files* and hidden from All/Recent/Uncategorized/Untagged/Missing
  and every collection (browse keeps a `view=unbundled` + count for the hiding
  logic). The two top-left tabs are **Bundles** (renamed from Collections) and
  **Files**; the sidebar **Unbundled** view opens the **Files** surface as a flat,
  cross-library list of not-yet-bundled files (`GET /manual-bundling/unbundled-files`)
  with the file inspector. File Browser entries carry a derived `unbundled` flag and
  badge each path `unlinked` / `unbundled` / (openable).
- **Manual bundling assistant:** `cairndex.manual_bundling` confirms unbundled
  files by hand — add to an existing confirmed bundle, create a bundle from
  selected files, create an empty bundle, or add suggested files from a bundle’s
  inspector — reachable by right-clicking files in either Files surface.
  Suggestions (target bundles / unbundled files / a bundle draft) are automatic on
  dialog open, ranked with a confidence + reason, and computed only from the DB +
  FTS index; applying is always explicit and metadata-only (files re-parented,
  emptied provisional bundles reaped, subtitles auto-linked). Apply/suggest accept
  `relative_paths` as well as `file_ids`; an unlinked File-View path is staged as
  provisional at apply, and a path in a confirmed bundle is rejected. Shared
  membership logic lives in `grouping/membership.py`.
- **Hidden/cache exclusions:** scan and grouping ignore dot-directories/files and
  known hidden/cruft names such as `.cairndex`, `.DS_Store`, `__pycache__`,
  `node_modules`, and `Thumbs.db`. Rescan cleans up scan-staged provisional rows
  that were previously created for now-hidden paths. Browse hides hidden-only
  bundles while preserving legitimate empty bundles.
- **Thumbnail UI:** the global sidebar thumbnail button was removed. The backend
  thumbnail job/API and lazy bundle/file thumbnail endpoints remain; cover
  fallback is explicit cover → first image → selected primary video → first video
  → placeholder/no thumbnail.
- **Production deployment:** the library root mount must be writable because the
  per-library package stores `.cairndex/{manifest.json,library.db,cache/}` under
  that root. Normal MVP flows still avoid changing original media files. Backups
  should cover `/data/registry.db` plus each library's `.cairndex/library.db`;
  derived cache files are regenerable.

## Completed in ADR-0009

- **Phase 1 — bundle grouping review state (merged, #29).** Added
  `grouping_state`, `grouping_source`, `grouping_rule_version`, and
  `confirmed_at`; scan creates provisional bundles while fast-add/manual actions
  create confirmed bundles.
- **Phase 2 — read-only grouping suggester (merged, #30).** Added the pure
  heuristic and DB adapter that produce BUNDLE/CONTAINER proposals with roles,
  confidence, reasons, and stable ordering.
- **Phase 3 — apply-plan service + API (merged, #31).** Added durable grouping
  plans/proposals, apply semantics, conflict reporting, role assignment,
  collection creation, subtitle linking, and generated OpenAPI/frontend types.
- **Phase 4 — grouping review UI (merged, #32).** Added the review modal and
  frontend hooks for generating, reading, and applying grouping plans.
- **Phase 5 — re-scan additions (merged, #33).** New files found under a
  directory already owned by a confirmed bundle are proposed as additions instead
  of disturbing the confirmed grouping.
- **Phase 6 — external subtitle auto-link across grouping flows.** Fast-add
  single-bundle grouping now runs the same external-subtitle auto-link behavior as
  grouping-plan apply.
- **Follow-up — scan grouping review workflow (merged, #36).** Scan jobs persist
  open grouping plans; Update is the primary maintenance flow; hidden/cache paths
  are excluded; grouping review supports selected accept; the global thumbnail
  action is removed from the sidebar.

## Completed in ADR-0008

- Registry database and library package skeleton.
- Per-library engine/session cache and library-scoped content route migration.
- Clean-break schema collapse: no content `storage_roots` table and no
  `asset_files.storage_root_id`; each `library.db` is scoped by its library root.
- Registry-owned `job_queue` and in-process worker that opens the target
  library DB for scan/probe/thumbnail handlers.
- Per-library portable cache under `.cairndex/cache/{thumbnails,subtitles}/`.
- Optimistic concurrency for frequent metadata edits via `version` + optional
  `If-Match`.
- Eagle import removal; ADR-0004 remains only as superseded history.

## Tests and validation

For the maintenance-readiness sequence (#38–#41), each branch ran the full gates
locally and on GitHub CI (Backend / Frontend / Docker build) before merge:

- backend: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy src`,
  `uv run pytest` (`235 passed` on `main` after #41);
- frontend: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run test`, `npm run build`, and Playwright `npm run test:e2e` (15 specs).

New coverage added by the sequence: `test_jobs.py` (phase/message, path
redaction), `test_devtools_perf.py` (generator + benchmark), `test_search.py`
(FTS coverage/freshness/escaping/API), `test_auth.py` (hashing, session
scoping/expiry, the full lock gate), and e2e flows for the progress bar,
whole-library search, and the passphrase unlock.

For `feat/manual-bundling` (not yet merged): backend `pytest` is `253 passed`
locally with all static gates clean; frontend gates clean and Playwright is 17
specs. New coverage: `test_browse.py` (Unbundled view/counts + hiding from normal
views/collections), `test_manual_bundling.py` (all mutations, role/cover/primary
assignment, subtitle auto-link after add, confirmed bundles undisturbed, unbundled
source guard, metadata-only invariance, suggestion ranking),
`test_manual_bundling_api.py` (end-to-end over a real scan through the API), and
`e2e/manual-bundling.spec.ts` (Unbundled view + create-from-files + add-to-bundle
dialogs).

## Known issues / environment gaps

- Optional per-library owner passphrase lock (ADR-0010) is implemented: a library
  can require a passphrase (hash in its manifest; set via
  `cairndex.devtools.set_passphrase`), gated by a library-scoped server session
  (opaque HTTP-only cookie). It is a private LAN/Tailscale guardrail, not
  public-internet hardening and not multi-user auth. Branch
  `feat/per-library-passphrase-lock`. Sessions are in-memory (re-lock on restart);
  no rate limiting/lockout.
- Job progress is now observable: scan/probe/thumbnail jobs report a coarse
  phase + message with throttled progress writes, and the sidebar shows a live
  (determinate/indeterminate) progress bar under Update plus redacted error
  text. Branch `feat/job-progress-observability`. Cancellation is wired but has
  no dedicated UI button yet.
- Grouping review can select/deselect proposals but does not yet provide rich
  edit-before-apply controls for merge/split/reclassify/rename.
- Whole-library indexed metadata search (SQLite FTS5) is implemented: the toolbar
  search box queries a per-library `bundle_search` FTS5 index (kept fresh by
  triggers; rebuildable via `cairndex.devtools.reindex_search`) over
  bundle/file/tag/collection metadata, composing with views/collections/filters.
  Branch `feat/indexed-metadata-search`. Ranking is match-only for now (results
  keep the active sort, not a relevance score).
- Browse-summary queries are profiled with synthetic-library + benchmark
  devtools; targeted indexes (`asset_files.bundle_id` + association-table reverse
  indexes) plus a non-correlated membership semijoin take browse/counts/filters
  from seconds to single-digit/low-tens of ms at 5k and keep all paths
  comfortably interactive (browse ~120 ms, filters <150 ms) at 100k bundles (see
  `docs/performance.md`). Branch `perf/large-library-baselines`.
- Same-volume high-confidence moved-file repair is implemented; cross-filesystem
  repair candidates, duplicate/copy handling, and manual repair are future work.
- File Browser is read-only. Write mode, reveal/open-with-default-app, and desktop
  helper/Tauri integration are not yet implemented but are now **planned and
  design-ratified**: library write mode in `docs/plans/04-library-write-mode.md`
  (ADR-0013, accepted), and the macOS desktop/host-handoff path in
  `docs/plans/03-macos-desktop-app.md` (ADR-0012, accepted).
- Remux/transcode fallback and embedded subtitle extraction are deferred —
  scheduled as plan 1 M6/M7 (HLS sessions) and M8 (subtitle upgrade); see
  `docs/plans/01-web-media-player-and-viewer.md`.

## Next recommended tasks

1. **Plan 1 M6 — playback decisions + HLS/remux/transcode session foundation**
   (M5 merged as #5). Subtitle depth remains owner-deferred to M8 behind HLS,
   and dual subtitles to M9 — see
   `docs/plans/01-web-media-player-and-viewer.md`. M6 needs the HLS session
   model / transcode-cache location ADR recorded at implementation time
   (flagged in plan 1 §12 and ADR-0012).
2. Add richer grouping review editing: merge/split/reclassify/rename before
   apply, while preserving the current safe apply/conflict model.
3. Continue File Browser planning toward guarded write mode and safe desktop-native
   handoff. *(Planning now done: `docs/plans/04-library-write-mode.md` +
   proposed ADR-0013; desktop handoff in `docs/plans/03-macos-desktop-app.md`.)*
4. Consider relevance ranking for text search (results currently keep the active
   sort).
5. Consider hardening the passphrase lock for wider exposure (rate limiting,
   lockout, persistent sessions) if it ever needs to face more than a trusted LAN.
6. File Browser toolbar/search follow-ups (the toolbar now mirrors the bundle
   browser — breadcrumb + count + search + sort + layout + zoom; single-click
   selects and drives the inspector, double-click navigates/opens):
   - File search is currently a **client-side name filter of the loaded
     listing**. Add whole-library/recursive file search (file titles are
     already in the `bundle_search` FTS index, but that returns bundles, not
     File-View entries — needs a file-entry-shaped search path).
   - Enrich File-View metadata in the inspector: for a **directory**, show its
     child count (needs the backend `list_entries`/entry schema to carry a
     `child_count`). (A collection's note is already editable — see the
     collection inspector, `feat/collection-view`.)

## Unresolved decisions

- Authentication mechanism: shared owner secret vs. per-user accounts.
- Native/desktop host integration design for `open with default app`, reveal in
  file manager, and future File Browser write mode.
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
