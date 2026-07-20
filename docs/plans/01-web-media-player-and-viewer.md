# Plan 1 — First-class web video player & image viewer

> Status: planning document (2026-07-04). See [README.md](README.md) for how
> this fits the overall client strategy and build order.

## 1. Where we are

Playback today (`apps/server/src/cairndex/media/`, `api/v1/playback.py`,
`apps/web/src/app/Player.tsx`, `FileViewer.tsx`):

- **Direct play only.** `assess_playability()` allows containers
  `mp4/m4v/webm` and codecs `h264/vp8/vp9/av1/theora`; everything else (MKV,
  HEVC, AVI, WMV, MOV…) shows a fallback card. Streaming is Starlette
  `FileResponse` with HTTP Range — correct and sufficient for direct play.
- **`Player.tsx` is a modal with a bare `<video controls>`** — browser-default
  controls, no keyboard shortcuts, no track menu, no seek preview, no resume,
  no speed, no PiP, no fullscreen management, and a crude playlist strip.
- **Subtitles:** external SRT/VTT converted to cached WebVTT and attached as
  `<track>` elements. Embedded streams are _detected_ (`SubtitleTrack` rows
  with `stream_index`) but not extractable/servable. ASS/SSA not convertible.
- **`FileViewer.tsx` (lightbox):** full-res `<img>` or bare `<video>`,
  arrow-key stepping, Escape. No zoom/pan, no fit modes, no slideshow, no
  EXIF panel, no non-native format support (HEIC/TIFF fall to an info card).
- **Probe** stores only the _first_ audio stream and no chapters.
- No watch positions, no storyboard thumbnails, no image preview derivatives.

## 2. Target experience

Reference points — the owner's stated bar for the player is desktop-native
macOS players, **Movist and Elmedia** (Eagle's own built-in player — no
subtitles, no PiP — is explicitly _not_ the playback reference; Eagle stays
the reference for browsing and the image viewer only):

- Movist: dual simultaneous subtitles, deep subtitle styling, A-B repeat,
  snapshots, video adjustments, configurable seek steps;
- Elmedia/IINA: playback polish, on-screen-controller aesthetic, floating/PiP
  behaviors, speed control;
- YouTube: control bar, keyboard map, storyboard seek preview;
- Jellyfin/Plex: server-decided direct/remux/transcode, per-track menus,
  resume;
- mpv: frame stepping, speed ramp.

A single **unified media viewer** replaces today's two modals (`Player` and
`FileViewer`): one full-screen surface that hosts an **image stage** or a
**video stage** per file, with shared previous/next navigation plus expandable
side panels for the bundle's file list and selected-file/bundle metadata. The
file list must not live as an inline bottom filmstrip because it competes with
the video control bar. "Play bundle" opens it on the primary video; "view file"
opens it on that file.

### Video stage — feature list (acceptance criteria for the UI milestones)

- Custom control bar (auto-hiding): play/pause, seek bar with buffered ranges
  - chapter ticks, time/duration, volume slider + mute, settings menu
    (speed 0.25–3× with pitch-preserve toggle, quality when transcoding, loop,
    A-B loop, video adjustments, seek-step size), subtitle menu, audio-track
    menu, PiP, theater/fullscreen.
- Seek bar: click/drag scrubbing, hover time tooltip with **storyboard
  thumbnail**, chapter markers from container metadata.
- Keyboard: `Space`/`K` play-pause, `←/→` ± seek step (default 5 s,
  configurable), `J/L` ±10 s, `↑/↓` volume, `M` mute, `F` fullscreen, `I`
  info panel, `C` cycle subtitles, `<`/`>` frame step back/forward while
  paused, `,`/`.` speed down/up (owner 2026-07-11: swapped from the original
  map — M2 shipped frame step on `,`/`.` and speed on `<`/`>`; M9 rebinds),
  `0–9` seek to N×10 %, `S` snapshot, `[`/`]` set A-B loop points (M11),
  `Esc` close. Same map reused by the desktop shell.
- Subtitle experience (Movist-inspired): external + embedded text tracks,
  on/off + track pick, styling settings (size, color, background/edge,
  vertical offset — persisted), timing offset nudge (±). Owner-deprioritized:
  the depth lands at M8, after HLS. **Dual simultaneous subtitles** (primary +
  secondary track, e.g. two languages, rendered stacked) are far-deferred
  (M9 at the earliest).
- Snapshot capture: save/copy the current frame via a canvas grab (streams
  are same-origin, so the canvas stays untainted).
- A-B loop between two marked points (2026-07-11: moved to M11 as the GIF
  range-picker); video adjustments (2026-07-11: deferred, reframed as
  color/tone — see §11 future rows).
- Resume: reopening a partially-watched file offers/starts at the saved
  position; progress saved throttled + on pause/close.
- Playlist behavior inside a bundle: auto-advance toggle, next/previous.
- Unsupported-format fallback: replaced by remux/transcode (§6); the explicit
  "can't play" card remains only for genuinely unplayable sources.
- MediaSession API integration (OS media keys, artwork, title).

### Image stage — feature list

- Zoom/pan: wheel-zoom to cursor, pinch, drag pan, double-click cycles
  fit → 100 % → fill; `+/-/0/1` bindings; zoom % indicator.
- Fit modes and window resize handling; optional checkerboard/dark/light
  background toggle for transparency.
- Progressive load: cached thumbnail → sized preview → full resolution.
- Non-native formats (HEIC, TIFF, BMP) displayed via
  server-side preview derivatives (§5).
- Slideshow (interval, shuffle — 2026-07-11: deferred to future), rotation
  (view-only, non-destructive), EXIF/tech panel from `tech_metadata`,
  neighbor preloading.
- GIF/animated formats play natively; video files in the filmstrip open the
  video stage.

## 3. Server foundation A — probe enrichment

`media/ffprobe.py` `summarize()` currently keeps one video + one audio stream.
Extend the stored `tech_metadata` (additive keys, no schema change):

```jsonc
{
  "audio_streams": [
    {"index": 1, "codec": "aac", "channels": 6, "language": "eng",
     "title": "Surround", "default": true}
  ],
  "subtitle_streams": [...existing...],
  "chapters": [{"start": 0.0, "end": 512.3, "title": "Intro"}],
  "hdr": "hdr10" | "hlg" | "dv" | null,        // from color_transfer/side data
  "bit_depth": 8
}
```

Add `-show_chapters` to the ffprobe invocation. Re-probe is the normal
"Collect metadata" job; old rows lacking the new keys degrade gracefully
(empty lists). HDR/bit-depth matter for the TV client's direct-play decision.

Tests: extend `test_probe`/ffprobe fixtures with a multi-audio + chaptered
synthetic file (generated by ffmpeg in the test, as existing media tests do).

## 4. Server foundation B — subtitles and storyboards

### 4.1 Embedded text-subtitle extraction

Extend `media/playback.build_vtt_for_track()`: when `track.source_file_id is
None` and `track.stream_index` is set, extract with

```bash
ffmpeg -i <video> -map 0:s:<rel_index> -f webvtt <cache>/subtitles/<id[:2]>/<id>.vtt
```

for text codecs (`subrip`, `ass`, `ssa`, `webvtt`, `mov_text`). Same cache
layout and endpoint as external tracks — `_track_read()` in
`api/v1/playback.py` simply stops special-casing embedded tracks for these
codecs. Bitmap subs (`hdmv_pgs_subtitle`, `dvd_subtitle`) stay unservable with
a reason string; they become a **burn-in option** on transcode sessions (§6)
and are handled natively by ExoPlayer on TV.

ASS/SSA note: `ffmpeg -f webvtt` drops styling/positioning; acceptable MVP.
Full fidelity later via JASSUB (libass-wasm) rendering raw ASS client-side —
keep the raw-subtitle endpoint (`.../subtitles/{id}/raw`) in mind but do not
build it yet.

Extraction can take seconds on big NAS files → run it in the existing lazy
per-request style but with a per-track file lock (same pattern as thumbnail
generation), never on the manifest request path.

### 4.2 Storyboard (trickplay) job

New job type `storyboard` beside scan/probe/thumbnail:

- For each video file (duration known from probe), pick an interval so the
  board has ~100–400 frames: `interval = clamp(duration/300, 2, 30)` seconds.
- One ffmpeg pass per file:
  `ffmpeg -i in -vf "fps=1/{interval},scale=320:-2,tile=5x5" -q:v 5 sb_%03d.jpg`
- Write a **WebVTT index** mapping time ranges to
  `sb_001.jpg#xywh=x,y,w,h` fragments (the de-facto standard consumed by every
  hover-preview implementation, and directly usable by the TV client).
- Cache: `.cairndex/cache/storyboards/{file_id[:2]}/{file_id}/{index.vtt,sb_*.jpg}`
  — reproducible, scan-ignored, invalidated by fingerprint change like
  thumbnails.
- Endpoints: `GET /libraries/{lib}/files/{id}/storyboard.vtt` and
  `/storyboard/{n}.jpg` (path-safe, 404 when absent — clients treat trickplay
  as optional).
- Scheduling: enqueued by **Update** after probe (only for files with duration
  ≥ a threshold, e.g. 60 s), deduplicated like thumbnail jobs, cancellable,
  progress-reporting. Storyboards are the most expensive derived artifact —
  bounded to the single worker and skippable via config.
- **Known follow-up (deferred to M9 polish):** as shipped in M3, the VTT cue
  count is derived from probed duration and capped to the sheets ffmpeg
  actually emitted (so no cue ever references a missing sheet / 404s). When a
  video _stream_ is shorter than its _container_ duration and the shortfall
  lands mid-sheet, the final cues can point at ffmpeg `tile` filter **padding
  tiles** (a dark thumbnail at the very end rather than a broken one). Fix
  requires counting the frames ffmpeg actually emitted (parse ffmpeg output or
  probe the frame count) and trimming cues to real frames — cosmetic, low
  priority, folded into M9.

## 5. Server foundation C — image previews & watch progress

### 5.1 Preview derivatives

New module `media/previews.py` + endpoint
`GET /libraries/{lib}/files/{id}/preview?size=640|1600|2560`:

- Allowlisted size ladder (not arbitrary integers) → deterministic cache path
  `.cairndex/cache/previews/{id[:2]}/{id}_{size}.webp`.
- Generated lazily on first request (thumbnail-endpoint pattern),
  from the original for native formats and for **HEIC/TIFF/BMP** via
  Pillow (+`pillow-heif`). New dependency, justified: unlocks non-browser
  formats for _all_ clients and TV-sized grid images; pure wheels, low
  maintenance. (pyvips is faster for gigapixel sources — revisit only if
  profiling demands it.)
- `file-browser`/playability metadata: image files with a preview-capable format
  count as **openable**, fixing the current "HEIC can't be previewed" hole.
- The viewer's progressive chain becomes thumbnail → `preview?size=1600` →
  original (`/content`), requesting the next tier only while zooming/idle.

### 5.2 Watch progress

New table in `library.db` (additive, via `ensure_content_indexes`-style
bootstrap like `manual_order`):

```sql
playback_progress(
  file_id      TEXT PRIMARY KEY REFERENCES asset_files(id) ON DELETE CASCADE,
  bundle_id    TEXT NOT NULL,          -- denormalized for continue-watching
  position_s   REAL NOT NULL,
  duration_s   REAL,
  completed    INTEGER NOT NULL DEFAULT 0,   -- position/duration > 0.95
  updated_at   TEXT NOT NULL,
  user_id      TEXT                    -- NULL = owner; future multi-user
)
```

- `PUT /libraries/{lib}/files/{id}/progress {position_s, duration_s}` —
  idempotent upsert; client throttles (every 10 s + pause/close via
  `navigator.sendBeacon`).
- Progress is embedded in the playback manifest (per video) and drives resume.
- `GET /libraries/{lib}/continue-watching?limit=20` — bundles with an
  in-progress (not completed) file, newest first; powers the TV home row and
  an optional web system view later.
- Survives moved-file repair for free (keyed by stable `file_id`).

## 6. Server foundation D — playback decisions & HLS sessions

The heart of "plays everything". Split into a cheap decision step and a
session machine used only when direct play is impossible.

### 6.1 Capability profiles + decision endpoint

Clients describe themselves; the server decides. Profile (client-computed at
startup via `canPlayType`/`MediaSource.isTypeSupported`, hardcoded per
platform on TV/desktop):

```jsonc
{
  "protocols": ["progressive", "hls"],
  "containers": ["mp4", "webm"],
  "video_codecs": ["h264", "vp9", "av1"],
  "audio_codecs": ["aac", "mp3", "opus", "vorbis", "flac"],
  "max_height": 2160,
  "native_hls": false, // true in Safari/WKWebView
}
```

`POST /libraries/{lib}/files/{id}/playback-decision {caps, audio_stream_index?,
burn_subtitle_track_id?, max_height?}` →

```jsonc
{
  "method": "direct" | "remux" | "transcode",
  "reason": "HEVC not in client caps",
  "stream_url": ".../files/{id}/stream",        // direct only
  "session": {"id": "...", "playlist_url": ".../index.m3u8"},  // else
  "duration": 5423.1,
  "audio_streams": [...], "subtitles": [...], "chapters": [...],
  "storyboard_url": "... or null",
  "progress": {"position_s": 1200.5} | null
}
```

Decision matrix (pure function in `media/playback.py`, unit-tested against a
caps × source matrix): container+codecs in caps → `direct`; codecs in caps but
container not (the huge MKV-with-H.264 class) → `remux`; else → `transcode`
(also when `audio_stream_index` ≠ default or a burn-in sub is requested, since
progressive streams can't switch tracks). `GET /bundles/{id}/playback` stays
as the playlist-level manifest (now including per-file progress); the decision
call happens when a specific file starts.

### 6.2 HLS session manager

New module `media/hls.py` + `api/v1/playback_sessions.py`. Model follows the
Jellyfin-proven shape: one ffmpeg per session writing segments sequentially,
serve segments on demand, restart on far seeks.

- `POST .../files/{id}/playback-sessions {caps, start_s?, audio_stream_index?,
burn_subtitle_track_id?, max_height?}` → `{session_id, playlist_url, kind}`.
- **Output location:** `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` —
  server-local ephemeral runtime state, _not_ inside the library package
  (resolves the STATUS.md open question for transcode cache: portable caches
  hold only reproducible per-file artifacts; sessions are throwaway).
- **Playlist:** VOD playlist computed up front from the known duration with a
  fixed 6 s target (`#EXT-X-PLAYLIST-TYPE:VOD`, N = ceil(duration/6) entries)
  so players get instant duration + free native seeking.
  - _Transcode:_ `-force_key_frames "expr:gte(t,n_forced*6)"` makes segment
    durations exact.
  - _Remux (`-c:v copy`):_ segments split on source keyframes, so real
    durations drift from the nominal 6 s. Accepted MVP trade-off (hls.js and
    Safari tolerate it); refinement if drift proves annoying: probe keyframe
    timestamps once per file and emit an exact playlist.
- **Segment serving:** `GET .../playback-sessions/{sid}/{n}.m4s` (fMP4/CMAF,
  `-hls_segment_type fmp4`). If segment `n` exists → serve; if it's within a
  small window ahead of the encoder → wait (async poll, bounded); else kill
  ffmpeg and restart at `t = n*6` with `-ss` (input-side, fast seek) and
  segment numbering offset `-start_number n`.
- **ffmpeg templates:**
  - remux: `-ss {t} -i in -map 0:v:0 -map 0:a:{a} -c:v copy -c:a aac -ac 2
-f hls -hls_segment_type fmp4 -hls_time 6 ...` (audio transcoded to AAC
    whenever the source audio isn't in caps — most common remux case).
  - transcode: `-c:v h264 -preset veryfast -crf 21 -maxrate/-bufsize` from a
    small quality ladder capped by `max_height`; optional
    `-vf subtitles=...:si={n}` for burn-in; optional hwaccel prefix from
    `CAIRNDEX_FFMPEG_HWACCEL = vaapi|qsv|videotoolbox|none` (config, default
    none; VAAPI/QSV are what NAS boxes have).
- **Lifecycle & bounds:** max concurrent sessions (config, default 2);
  starting one beyond the bound returns a structured 409/429. Idle reaper:
  no segment/playlist fetch for 60 s → kill + delete dir; also killed by
  `DELETE .../playback-sessions/{sid}` (player close sends it, with beacon
  fallback) and on server shutdown. Sessions live in an in-process registry
  (dict + locks), not the job queue — they are interactive, not background
  jobs (keeps AGENTS.md's "no complex distributed job system" intact).
- **Security:** same `LibrarySession` gating as streams; session ids are
  random and scoped to the library; ffmpeg args are built from resolved
  server-side paths only.

Tests: decision matrix unit tests; session manager with a **fake ffmpeg**
(a stub script emitting segment files) covering start/serve/wait/far-seek
restart/idle-reap/bound; one slow integration test with real ffmpeg over a
tiny generated MKV, marked/skipped when ffmpeg is absent.

### 6.3 Web client engine integration

`PlaybackEngine` abstraction in the player (§7): `direct` → plain
`video.src`; `remux|transcode` → **hls.js** (lazy `import()` so the chunk
loads only when needed) or native HLS when `caps.native_hls` (Safari/WKWebView
— feed the m3u8 straight to `video.src`). New dependency: `hls.js` (~90 kB
gz, the de-facto standard, no alternatives worth the risk; Shaka is heavier
and DASH-first; video.js/Vidstack bundle UI we don't want).

Quality/audio switching = new decision + new session at the current position
(simple, robust); in-stream ABR ladders are explicitly out of scope until a
remote-bitrate milestone (product brief already defers remote quality
selection).

## 7. Web player architecture

No player UI framework. Rationale: the app is 100 % hand-built (no component
library), the Eagle-dark design must stay consistent, and a headless custom
player is what gets re-skinned for the video wall. `media-chrome` (Mux web
components) is the fallback accelerator if control-bar work stalls — noted,
not planned. The only new runtime deps are `hls.js` (§6.3) and nothing else.

```text
apps/web/src/app/viewer/
  MediaViewer.tsx        // unified lightbox shell: nav, side-panel toggles
  VideoStage.tsx         // <video> host, gesture layer, subtitle container
  ImageStage.tsx         // zoom/pan stage (§8)
  player/
    engine.ts            // PlaybackEngine: load(decision), on(event), destroy
                         //   NativeEngine | HlsEngine (lazy hls.js)
    usePlayer.ts         // headless state: status, time, buffered, tracks,
                         //   volume, rate, fullscreen, PiP, progress reporting
    ControlBar.tsx
    SeekBar.tsx          // buffered ranges, chapter ticks, hover storyboard
    StoryboardPreview.tsx// parses storyboard VTT, crops via CSS background
    TrackMenus.tsx       // subtitle / audio / quality / speed popovers
    useShortcuts.ts      // keymap above; scoped to viewer focus
    useIdleHide.ts       // controls auto-hide, cursor hide in fullscreen
```

Implementation notes:

- `usePlayer` is the single source of truth; controls are dumb. This is what
  the multi-view grid instantiates N times (§9).
- Bundle files and metadata belong in expandable side panels, not a persistent
  bottom strip. M2 ships previous/next navigation and the basic info toggle;
  the file-list drawer and richer right metadata panel are follow-up UI work.
- Subtitles render through native text tracks; size/offset settings apply via
  `::cue` CSS variables; track choice + settings persist in the existing
  `cairndex.prefs` localStorage model, per-library.
- Fullscreen via the Fullscreen API on the viewer root (so controls overlay
  works); PiP via `requestPictureInPicture`; MediaSession metadata from the
  bundle title + cover thumbnail URL.
- Progress: `usePlayer` posts throttled `PUT .../progress`, flushes on
  pause/unmount, `sendBeacon` on `pagehide`; resume dialog-free (start at
  saved position, show a transient "Resumed at 20:01 — restart" toast).
- The old `Player.tsx`/`FileViewer.tsx` are deleted once `MediaViewer` covers
  both entry points (bundle double-click, album file open, File Browser preview
  — `FileEntryViewer` migrates to the same stages fed by path-based URLs).

## 8. Image viewer implementation

`ImageStage.tsx` — custom pointer-event zoom/pan (no dependency; the math is
a 2-D affine transform):

- State: `{scale, tx, ty}` + fit mode; wheel zoom multiplies scale around the
  cursor point; pointer capture for pan; pinch via two active pointers;
  double-click cycles fit → 1:1 → fill. Clamp scale to [fit×0.5, 8×native].
- Rendering: single `<img>` with `transform: translate(tx,ty) scale(s)` and
  `will-change: transform` (GPU-composited; smooth for the ≤ 100 MP images we
  target — deep-zoom tiling is explicitly out of scope).
- Progressive source swap: keep the current tier visible until the next tier's
  `Image` decodes (`img.decode()`), then swap — no flash.
- Slideshow: timer in `MediaViewer` (advances filmstrip; pauses on interaction;
  works across mixed bundles by skipping videos or playing them, setting-
  controlled). Rotation is CSS-only, per-session.
- EXIF/info panel reads `tech_metadata` (already probed for images) + file
  fields; reuses inspector styling.

## 9. Web/desktop multi-video wall (parity slice)

Spec ownership lives in plan 2 §7 (TV is the priority); the web/desktop
counterpart:

- `VideoWall.tsx`: 1×2 / 2×2 grid of independent `usePlayer` instances, each
  cell fed by its own playback decision. Focused cell (click / arrow keys)
  is the only unmuted one and owns the keyboard; global bar has play/pause-all
  and layout switch; per-cell hover bar: change source (opens a bundle/file
  picker overlay), mute solo, swap-to-fullscreen, remove.
- Entry points: toolbar action on a multi-selection ("Play 2/4 side by side"),
  and from inside the viewer.
- Constraints surfaced honestly: 4 simultaneous decodes are cheap on desktop
  GPUs at ≤1080p; when sources exceed caps the normal decision engine already
  falls back to capped transcode (`max_height: 1080` for wall cells — client
  sends a tighter profile per cell). Session bound (§6.2) may need raising for
  wall use; keep it config.
- Wall presets (save a named layout+sources set) are a later nice-to-have and
  would be a small server-side JSON preference object usable by TV too.

## 10. Media exports — GIF snippets & contact sheets (later, desktop-first)

Owner request (2026-07-04, explicitly not a priority): user-initiated
exports — (1) an animated **GIF from a video snippet**, (2) a **contact
sheet** image (metadata header + grid of timestamped frames, per the owner's
reference: filename, size, resolution/aspect, fps, video codec, audio codec,
duration above an evenly-sampled 4×4 grid). Desktop-first; web comes along
for free since generation is server-side and delivery is a download; TV
excluded.

### Server: interactive export tasks

New `media/exports.py` + `api/v1/exports.py`, following the HLS-session
pattern (interactive, in-process, bounded) rather than registry jobs — a
running scan must not queue-block a ten-second export:

- `POST /libraries/{lib}/files/{id}/exports` with
  `{kind: "gif", start_s, end_s, width?, fps?}` (caps: duration ≤ 30 s,
  width ≤ 720, fps ≤ 15; defaults 480 px / 12 fps) or
  `{kind: "contact_sheet", grid?, width?}` (default 4×4, 1600 px sheet)
  → `{export_id}`. Video files only; range validated against duration.
- `GET .../exports/{id}` → `{status, progress}`;
  `GET .../exports/{id}/download` → artifact with a Content-Disposition
  filename from the display title. Output under
  `{CAIRNDEX_DATA_DIR}/exports/{export_id}/`, TTL-reaped (~1 h) and removed
  after successful download; concurrency bound shared with transcode
  sessions (config).
- **GIF pipeline** (two-pass palette for quality):
  `ffmpeg -ss A -to B -i in -vf "fps=12,scale=480:-2:flags=lanczos,palettegen"`
  then a second pass with `paletteuse`. `kind: "webp" | "mp4"` are trivial
  later additions on the same API (GIFs are ~10× the bytes) — offered in the
  dialog once present, GIF stays the default per the owner's ask.
- **Contact sheet pipeline:** ffmpeg samples N frames evenly across the
  duration with burned-in timestamps
  (`fps=(rows*cols)/duration`, `drawtext=text='%{pts\:hms}'`, `scale`,
  `tile=CxR`), then Pillow (§5.1 dependency) composes the metadata banner
  above the grid and encodes the final JPEG.
- M11 ships **download-only**. Saving an export _into the library_ (and
  linking it to a bundle / setting it as the cover) is the write-mode
  `save_new` op — specced in [plan 4 §5](04-library-write-mode.md) (slice
  W2, ADR-0013) — and the Export dialog gains "Save into library…" once
  that lands.

### Client integration

- Web: an **Export…** dialog in the player settings menu — range pre-filled
  from the A-B loop points (M9) or typed, format/size, progress, browser
  download. **Generate contact sheet…** on video files' context menus and in
  the viewer.
- Desktop (plan 3 D5): same UI plus a native save dialog and a completion
  notification through the platform seam; finished artifacts are drag-out-able.
  The save seam landed in **D5b** (`save_export_file` + `HostPlatform.canSaveExports`)
  with no caller. **Before M11 ships a real export flow, change how the bytes
  travel:** the seam currently passes them as a JSON number array
  (`Array.from(bytes)`), which turns a few-megabyte GIF into tens of megabytes of
  JSON serialized on the main thread. Move it to Tauri's raw request body
  (`tauri::ipc::Request`) — acceptable for a seam with no callers, not for a
  shipping export.
- TV: not exposed.

## 10.1 Viewer chrome and fit — owner feedback 2026-07-20 (**done**)

Owner-reported after the D5 owner pass and implemented on its own branch once D5
merged.

**Root cause, once looked at:** the chrome was already correct. `.mv-topbar` and
`.mv-controls` were already absolutely positioned, already carried
top-and-bottom gradients fading to transparent, and already faded out via
`.media-viewer--idle`. The black frames came from a single rule — `.mv-stage`
carried `padding: 58px 64px 86px`, reserving room for chrome that overlays the
media anyway. That padding bought nothing and cost bands on all four sides even
when the aspect ratio matched. Removing it makes the media span the viewer, and
`object-fit: contain` letterboxes in one direction only — which is exactly the
requested behavior, in windowed and fullscreen alike, since both are the same
layout at different sizes. The media's drop shadow went too: it is either clipped
by the viewer's `overflow: hidden` or reads as a smudge along the frame now that
the picture reaches the edges.

Observed: entering fullscreen leaves black frames on *all* sides. Expected
behavior, in the owner's words — the video should always fit/maximize to use the
whole screen, leaving black only in the one direction where the aspect ratio
genuinely does not match. The chrome should overlay the video rather than
reserving layout space beside it:

- **Fit.** The video fills the available area on the constrained axis; letterbox
  or pillarbox appears in one direction only, never both. This is a layout fix in
  the viewer stage, not a `object-fit` toggle — the current stage reserves space
  for surrounding chrome, which is what produces frames on every side.
- **Overlay + autohide.** Control bar *and* title bar draw on top of the video and
  hide when idle, sharing the existing `useIdleHide` timing rather than adding a
  second idle model.
- **Top bar treatment.** Half-transparent with a gradient falling off into the
  video, not a solid black bar — a solid bar reads as a letterbox band and blocks
  the frame. The control bar already sits over the video; the title bar is the
  piece that currently does not.
- **Applies to windowed view too.** The owner's preference is that this is simply
  the viewer's behavior, not a fullscreen-only mode. Treat fullscreen as the same
  layout at a different size.

Note for whoever picks this up: in the shell, "fullscreen" is now **native window
fullscreen** (plan 3 D5a), so the viewer is laid out against the whole window in
both cases. That is what makes "same behavior windowed and fullscreen" cheap —
there is one layout, not two.

## 11. Milestones (each = one reviewable branch/PR)

| #   | Slice                                                                               | Contents                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | ✅ Probe enrichment (merged, #1)                                                    | §3; regenerate OpenAPI/types; reprobe path                                                                                                                                                                                                                                                                         |
| M2  | ✅ Viewer shell + video controls v1 (merged, #2)                                    | Unified `MediaViewer`, custom control bar, shortcuts, fullscreen/PiP, MediaSession, snapshot capture, prev/next navigation — direct-play files only. Shipped subtitle on/off over external VTT (default track)                                                                                                     |
| M3  | ✅ Storyboards (merged, #3)                                                         | §4.2 job + endpoints + hover preview + chapter ticks                                                                                                                                                                                                                                                               |
| M4  | ✅ Watch progress (merged, #4)                                                      | §5.2 table/API + resume + continue-watching endpoint                                                                                                                                                                                                                                                               |
| M5  | ✅ Image viewer v2 (merged, #5)                                                     | §8 + previews pipeline (§5.1) + HEIC/TIFF openability                                                                                                                                                                                                                                                              |
| M6  | ✅ Playback decisions + HLS sessions                                                | §6 server side, fake-ffmpeg tests, config bounds                                                                                                                                                                                                                                                                   |
| M7  | ✅ Web HLS integration (merged, #9)                                                 | Engine abstraction (`HlsEngine`), lazy hls.js + native HLS, capability profile, per-file decision, session teardown/beacon + transparent re-attach, quality/audio menus, burn-in option                                                                                                                            |
| M9  | ✅ Player interaction polish (merged, #11)                                          | Right-click play/pause; off-track drag-scrub with pinned controls; persisted seek step + pitch preserve; session file loop; corrected frame/speed keys; set/clear current-frame cover (§13.1); storyboard padding-tile cue trim (§4.2)                                                                             |
| M12 | Thumbnail hover video preview (Eagle-style, §13.2; `feat/hover-preview`, in review) | Dwell-to-play muted video at rest; storyboard sprites while the cursor moves; one video seek/resume after 250 ms rest; position bar, time, sound toggle, and storyboard-only fallback. Sequenced right after M9, before the desktop shell                                                                          |
| M8  | Subtitle upgrade — **deferred to future**                                           | Embedded text extraction (§4.1), track menu, styling (size/color/background/offset) + timing settings, dual simultaneous subtitles at the earliest here. Known interim gap: M2 shows only the default external track; switching among multiple external tracks waits for this slice                                |
| M10 | Video wall (web) — **deferred to future**                                           | §9                                                                                                                                                                                                                                                                                                                 |
| M11 | Media exports — **deferred to future**                                              | §10: GIF-snippet + contact-sheet export tasks, web Export dialog + context-menu entry (desktop hooks land with plan 3 D5). **A-B loop moved here from M9** (owner 2026-07-11: its real use is picking a GIF range, so it lands as the export range-picker UI). Plan 4 W2 (save exports into library) waits on this |
| —   | Video adjustments — **deferred to future**                                          | Owner 2026-07-11: reframed — the interesting part is **color/tone adjustment**, not brightness/contrast sliders; design when picked up. Image **slideshow** likewise deferred                                                                                                                                      |

Re-sequenced twice by owner decision: after M2, the subtitle-depth slice moved
behind HLS; after M7 merged (2026-07-10), **M8/M10/M11 moved to the future
bucket** — M9 player polish is the last near-term plan-1 slice, and the
bucket. M12 was then added as the final near-term plan-1 slice after M9. The
roadmap next shifts to pairing/device tokens (plan 2 T0), the macOS desktop
shell (plan 3), write mode for drag-and-drop import (plan 4), and the remaining
Android client (plan 2 T1–T7). See
[README.md](README.md) for the current cross-plan order.

Every slice: focused backend/frontend tests + Playwright for user flows
(controls, shortcuts, track menu, resume, viewer zoom), OpenAPI + `schema.d.ts`
regen when contracts change, CHANGELOG/STATUS/architecture-doc updates, and
tiny ffmpeg-generated fixtures (never user media). M2/M5 give the owner daily
value before the heavy M6 lands.

## 12. Risks & open decisions

- **Remux playlist duration drift** (§6.2) — accepted; keyframe-exact playlist
  is the known refinement.
- **NAS transcode horsepower** — default `veryfast`+capped ladder, hwaccel
  config; TV client direct-plays most content so transcode pressure is mainly
  web.
- **ASS styling fidelity** — MVP converts to VTT; JASSUB later if styled subs
  matter to the owner's library.
- **Pillow dependency** — accepted trade-off (§5.1); RAW formats deferred.
- Needs ADR at implementation time: HLS session model + transcode-cache
  location (this doc is the draft rationale), covered in ADR-0012's list.

## 13. Owner additions 2026-07-11

### 13.1 Set cover to a specific frame (M9)

- Player action (settings/context menu): **"Use current frame as cover"** —
  sends the current playback time; no canvas upload (server-side extraction
  works for HLS playback too and avoids shipping pixels up).
- Server: additive `cover_time REAL NULL` on the file row in `library.db`;
  `POST /libraries/{lib}/files/{id}/cover-frame {time}` validates the time
  against probed duration, stores it, and regenerates the thumbnail
  derivative seeking to that time (single-frame extract; replaces the
  representative-frame filter for files with `cover_time` set — including
  on future fingerprint-driven regeneration). `DELETE` clears back to the
  automatic frame. Bundle covers need no work: `effective_cover_file`
  already resolves through file thumbnails.
- Metadata + cache only — originals untouched; allowed pre-write-mode.

### 13.2 Thumbnail hover video preview (M12) — Eagle-style

Applies to video file cards and bundle cards whose effective cover file is a
video. Owner decision 2026-07-12 after testing against Eagle: native decoders can
keyframe-snap through local media, but browser video seeking creates a
frame-accurate seek plus HTTP range work at every step. The web interaction is
therefore hybrid: storyboard sprites while moving, live video only at rest.
Owner follow-up 2026-07-13: on rest, exact sprite-to-video visual continuity
takes precedence over preserving the raw cursor timestamp within that cue.

- Pointer entry starts a 150 ms prefetch sub-dwell, then lazily fetches cached
  `storyboard.vtt` during the existing ~500 ms activation window. Crossing a
  card more quickly creates no request. Video does not mount and `/stream` is
  not requested before the activation dwell completes.
- Storyboard artifacts use format v2. Sampling is anchored at t=0 and rounds to
  the source frame active at each VTT cue start; the index fingerprint sidecar
  carries the format marker plus source fingerprint, VTT responses revalidate,
  and sheet URLs include the same inputs. Older indexes are stale and must be
  regenerated.
- Activation enters **resting** at the incomplete saved progress position when
  one exists, otherwise t=0. For a source accepted by `caps.ts`, a muted
  `<video preload="metadata">` mounts, seeks once when needed, and plays.
- Any active pointer movement enters **skimming**. Cursor x maps proportionally
  to the API duration; the direct video pauses and remains mounted with its
  source intact while the matching storyboard crop replaces it. Motion performs
  zero video seeks. Storyboard-only sources use the same cursor/time/crop path.
- After ~250 ms without motion, the preview returns to **resting**. A direct
  video seeks once to the displayed cue's sampled timestamp (its VTT start), and
  the clock and position strip snap to that honest time. This makes the first
  live frame match the sprite instead of seeking later within its cue range.
  Resolve the cue when the rest debounce expires, not on the last pointer move,
  so a VTT prefetch completing during that window cannot leave the sprite and
  video target out of sync. Show the transition sprite only when the selected
  target matches its cue start. For a cue-backed transition, keep the paused
  direct video mounted beneath the sprite, arm frame presentation before
  assigning `currentTime`, and wait for both seek completion and the target
  frame callback. Remove the sprite and resume playback only after that frame is
  ready. Browsers without the callback API use completed seek as the best
  frame-ready signal; an exposed API that omits its post-seek callback has a
  bounded fallback. If the browser omits a no-op `seeked` event, a readiness
  check completes the same transition. If the
  storyboard is missing (including clips without a cached board), motion leaves
  the last paused video frame visible while the position bar and clock follow
  the cursor; rest seeks to that exact cursor time and the static cover masks
  the transition.
- Static video covers, storyboard crops, and live video use the same contained,
  black-letterboxed viewport. The full frame keeps its source aspect ratio;
  portrait video is pillarboxed instead of stretched, and switching layers does
  not resize or shake the card. Card storyboards clip the full sprite sheet to
  the selected cue rectangle before the contain transform, so adjacent tiles
  cannot paint into the letterbox bands.
- A **thin position bar** tracks the active timeline position. **Current time**
  remains anchored bottom-right in every state. The direct video's **speaker
  toggle** sits immediately to its left (muted by default; click to unmute
  without restarting or opening the card).
- Leaving or virtualized unmount tears the preview down fully (pause, clear
  `src`, `load()`, unmount). At most **one** preview is active page-wide; touch,
  drag, and context-menu guards remain.
- Direct playback rejection/media error demotes to the cached storyboard-only
  path. Hover never calls playback-decision or creates an HLS session. The
  storyboard minimum-duration default is 10 seconds. Because format v2 corrects
  sampling semantics, existing libraries need one Update/storyboards run for
  all prior boards; the same run backfills boards for 10–60 second videos.
