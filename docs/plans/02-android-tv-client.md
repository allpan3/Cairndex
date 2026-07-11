# Plan 2 — Android TV client

> Status: planning document (2026-07-04). See [README.md](README.md) for the
> shared server foundations (plan 1 §3–§6) this client consumes and for the
> repo strategy. Decision summary in ADR-0012 (accepted). Sequenced 2026-07-10
> **after** the macOS desktop shell (plan 3) and write mode (plan 4); the T0
> pairing/device-token server slice is pulled forward anyway because the
> desktop shell's auth (plan 3 D2) reuses it.

## 1. Goals

- A 10-foot, D-pad-first client for browsing the library — bundles,
  collections, search — with an excellent player.
- **Video-wall mode**: 2 or 4 simultaneous videos in a grid (the owner's
  priority feature for the big screen).
- Playback quality above the web client: direct-play MKV/HEVC/HDR, embedded
  subtitle/audio handling without server work.
- Explicit non-goals for v1: mobile phone UI (the repo is named to allow it
  later), Google Play distribution (sideload first), Live-TV/DVR anything,
  editing metadata from the TV (browse/play only; light actions like rating
  can come later).

## 2. Technology study: web-based vs native

| Option | Player | D-pad/focus UX | Effort | Verdict |
|--------|--------|----------------|--------|---------|
| TV browser / PWA | HTML5 `<video>`; no MKV, HEVC hit-or-miss, no HDR; no reliable browser ships on Android TV anyway | none | low | **Reject** — no viable runtime |
| WebView wrapper APK (reuse `apps/web`) | WebView = Chromium without the codec/HDR surface; MSE janky on TV SoCs; controls designed for mouse | manual, fights the DOM | medium | **Reject** — playback is the whole point |
| React Native (react-native-tvos fork) | via native video modules anyway (ExoPlayer bridge) | second-class, community fork | medium-high | Reject — we'd write the hard parts natively and keep a JS bridge tax |
| Flutter | no official TV target; video via platform views | DIY focus engine | medium-high | Reject |
| **Native Kotlin + Jetpack Compose for TV + Media3/ExoPlayer** | Media3 direct-plays MKV/MP4/TS, H.264/HEVC/VP9/AV1 (device HW), HDR10/HLG/DV passthrough per device, embedded text+PGS subs, multi-audio; ffmpeg decoder extension for exotic audio | first-class (`androidx.tv` focus/scale semantics built for this) | high (new codebase) | **Chosen** |

This is the stack every serious self-hosted TV client converged on (Jellyfin
androidtv, Wholphin — both already named as reference material in the product
brief). The decisive argument: **ExoPlayer direct-plays almost the entire
library**, so the TV barely needs the server transcode path, gets HDR and
lossless audio passthrough, and handles embedded subtitles/audio natively —
none of which a web runtime on TV can offer.

Consequence accepted: zero UI code shared with `apps/web`. What *is* shared:
the OpenAPI contract (generated Kotlin client), and every plan-1 server
feature (decision endpoint, HLS fallback, storyboards, progress, previews,
pairing). A 10-foot UI needs different information architecture anyway.

## 3. Repo & project structure

New repo **`cairndex-android`** (rationale in README.md — separate toolchain
and CI). Gradle multi-module, MVVM + repositories, Hilt DI:

```text
cairndex-android/
  app-tv/                 # Android TV entry (leanback launcher intent)
  core/
    api/                  # OpenAPI-generated client (openapi-generator,
                          #   kotlin + Ktor/kotlinx.serialization), regenerated
                          #   in CI from a pinned server openapi.json
    data/                 # repositories, paging, token store (DataStore +
                          #   EncryptedSharedPreferences for the bearer token)
    model/                # domain types decoupled from generated DTOs
    player/               # Media3 wrappers, decision→MediaItem mapping,
                          #   trickplay loader, progress reporter
    designsystem/         # TV theme: dark palette matching the web app,
                          #   focus scale/border conventions, 10-ft type scale
  feature/
    home/  browse/  detail/  search/  player/  multiview/  settings/  pairing/
```

Key dependencies: `androidx.tv:tv-material` (Compose for TV), `androidx.media3`
(exoplayer, ui-compose, exoplayer-hls; optional `media3-decoder-ffmpeg` built
flavor for exotic audio codecs), Coil (images), Ktor client, Hilt,
kotlinx.serialization. Min SDK 26 (covers Android TV 8+ and Fire TV realities);
target latest.

Server-version handshake: on connect, read `api_features` (README.md) and
gate trickplay/progress/multi-view-transcode features so the app degrades
politely against an older server.

## 4. Connection & pairing (server work, shared with desktop)

TVs can't type passphrases pleasantly, and ADR-0010's cookie session is
browser-shaped. Add a **device pairing flow** (needs its own small ADR at
implementation time; registry-DB persistence, additive API):

1. TV: `POST /api/v1/auth/pair/start {device_name}` → `{pair_code, poll_key}`
   (6-char code, 10-min TTL). TV shows the code and polls
   `POST /auth/pair/poll {poll_key}`.
2. Owner, in the web app (already unlocked per ADR-0010): Settings → Devices →
   "Pair device" → enters the code, picks which libraries the device may
   access → `POST /auth/pair/approve {pair_code, library_ids}`.
3. Poll returns `{token}` once approved. Server stores only a hash in a new
   registry table `device_tokens(id, name, token_hash, library_ids, created_at,
   last_used_at, revoked_at)`; the web Devices page lists/revokes.
4. `get_library_session` accepts `Authorization: Bearer <token>` as an
   alternative to the cookie, scoped to the token's library ids. Unlocked
   libraries without a passphrase keep working anonymously exactly as today —
   pairing is only required where a passphrase gate exists, but the TV app
   always pairs so the Devices page shows it.

TV settings store server URL + token; multiple servers/libraries supported
(library picker mirrors the web's per-tab active library).

## 5. Browse & find UX (10-foot information architecture)

Not a port of the three-pane desktop layout — TV browsing is row- and
drill-down-based:

- **Home**: horizontal rows — *Continue Watching* (plan 1 §5.2 endpoint),
  *Recently Added*, one row per pinned collection (pin set managed in
  settings; later server-side preference), *Collections* and *Smart
  Collections* entry tiles. Row items are bundle cards (cover via the preview
  endpoint at TV-appropriate sizes, title, duration/count badge, progress bar
  strip when partially watched).
- **Browse** (from a collection/smart-collection/All): a virtualized
  `TvLazyVerticalGrid` of bundle cards; header carries sort (server sorts —
  the API already does deterministic pagination) and lightweight filters
  (rating ≥, media type, tag picker as a full-screen overlay with the existing
  facets endpoint). Long lists get a **letter fast-scroll rail** (server sort
  by title + a `prefix` seek param later if needed; MVP: fast-scroll over the
  loaded/paged list).
- **Collection drill-down**: subcollection tiles first (reusing the folder-
  card concept), then bundles — matching the web's mental model.
- **Search**: full-screen surface on the FTS endpoint (`q`) with on-screen
  keyboard + **voice input** (`RecognizerIntent`) — results grouped
  bundles/collections/tags. This is where FTS relevance ranking
  (STATUS.md next-task #3) starts to matter; fine to ship with match-only.
- **Detail page**: hero cover, title/metadata/rating/tags, actions: Resume /
  Play (primary file), file list for multi-file bundles (per-file progress),
  *View images* (opens the image/slideshow surface for album bundles),
  *Add to wall*.
- **Image viewing**: grid → fullscreen pager with slideshow (uses `preview`
  tier sized to 4K TVs); zoom is D-pad-stepped (center-zoom levels) rather
  than pointer-based.
- Focus/UX conventions throughout: `androidx.tv` focus scale ~1.08 + border,
  5 % overscan-safe margins, back = up one level, long-press OK = context
  actions (matching the web's right-click actions where sensible).

## 6. Player (single video)

`feature/player` on Media3:

- **Source selection:** call the plan-1 decision endpoint with the *device's
  real caps* (built from `MediaCodecList` at startup: HEVC/AV1/DV support,
  max decode resolution, audio passthrough). Expected outcome: `direct` for
  nearly everything → `ProgressiveMediaSource` on the existing `/stream`
  endpoint (Media3 handles MKV natively); `hls` fallback via
  `HlsMediaSource` for the rare mismatch. The server stays the single
  decision-maker for all clients.
- **Tracks:** for direct play, audio/subtitle selection is native Media3 track
  selection (embedded ASS/PGS included — better than web). External VTT/SRT
  subs attach as `SubtitleConfiguration` from the manifest. Subtitle style
  honors the Android system caption settings + in-app size override.
- **Controls (custom Compose, TV-idiomatic):** center play/pause; seek bar
  with **storyboard trickplay** (load `storyboard.vtt`, crop tiles into the
  scrub preview — same artifact as web); D-pad left/right = seek ±10 s, hold
  to scrub with preview; up/down reveals control row: speed, audio, subtitles,
  info; media keys (play/pause/FF/RW) mapped; `KEYCODE_MEDIA_*` +
  MediaSession so Assistant/remote integrations work.
- **Progress/resume:** same `PUT progress` (10 s throttle + on pause/stop);
  resume behavior identical to web.
- **Next-file auto-advance** inside a bundle with a countdown card.

## 7. Video wall (multi-view) — the priority feature

Owned here; web/desktop parity is plan 1 §9 with the same interaction rules.

### Layouts & interaction

- Layouts: `1×2` (side-by-side) and `2×2`; wall state = ordered list of cells
  `{file_id, muted, position}` + layout + sync flag.
- **Focus model:** D-pad arrows move a highlight border between cells; the
  focused cell is the only unmuted one by default (option: all muted). OK on
  a cell → cell menu: *Change source*, *Fullscreen this*, *Solo audio here*,
  *Remove*. Back → wall-level bar: layout switch, play/pause all, sync toggle,
  save/exit.
- **Filling cells:** entry points — "Add to wall" on bundle detail, a
  multi-select action later, and the in-wall *Change source* which opens the
  browse/search UI in **picker mode** (same screens, selection returns to the
  wall instead of playing).
- **Sync toggle:** off = independent transports (default; different videos);
  on = play/pause/seek broadcast to all cells (for comparing takes/angles).
- Wall presets: persist the last wall locally (DataStore) for instant resume;
  named presets as a later server-side JSON preference shared with web.

### Engineering

- One `ExoPlayer` instance per cell rendering into its own
  `AndroidExternalSurface` (SurfaceView-backed — cheapest path to the HW
  decoder; cells never overlap so SurfaceView z-order issues don't apply;
  keep a TextureView escape hatch flag for misbehaving devices).
- **Decoder budget is the real constraint.** At startup probe
  `MediaCodecInfo.getMaxSupportedInstances()` + max resolution per codec;
  practical planning numbers: mid-range TV SoCs do 2×4K or 3–4×1080p H.264;
  HEVC instances are scarcer. Wall policy:
  - each cell requests its decision with `max_height` = 1080 (2-up) or 720
    (4-up) and the *cell's* codec caps;
  - if the source exceeds the cell budget, the normal server decision returns
    a capped **transcode** — the wall is the feature that genuinely exercises
    plan 1 §6 from TV;
  - server session bound must therefore be ≥ wall size (config; revisit
    default when this lands);
  - on `MediaCodecRenderer` capacity errors, degrade visibly: drop the newest
    cell to a "needs lower quality" card with a retry-at-720p action rather
    than crashing the wall.
- Audio: `volume = 0` on unfocused players (decoders keep running); focused
  cell also owns MediaSession.
- Progress reporting stays per-cell/per-file (same endpoint).

## 8. Server additions specific to this plan

Everything big is already in plan 1; TV adds only:

1. Pairing/device tokens (§4) — also used by desktop.
2. `GET /continue-watching` (plan 1 §5.2) — spec'd there, consumed here.
3. Preview endpoint honoring TV grid sizes (plan 1 §5.1 ladder covers it).
4. Config: raise/expose max concurrent playback sessions for wall use.
5. (Nice-to-have) a `home` aggregate endpoint bundling the home-screen rows in
   one round-trip; MVP can compose existing endpoints.

## 9. Milestones

| # | Slice | Contents |
|---|-------|----------|
| T0 | Server: pairing + device tokens | §4, ADR, web Devices page |
| T1 | Repo bootstrap | Gradle modules, generated API client, CI (build+unit), design system, settings/server connect + pairing UI |
| T2 | Browse vertical slice | Home (Recent + Continue rows), collection drill-down grid, detail page — read-only, cover images via previews |
| T3 | Player v1 | Direct play, native track selection, custom controls, resume/progress |
| T4 | Trickplay + search | Storyboard scrubbing; FTS search + voice input |
| T5 | Video wall v1 | 1×2 + 2×2 direct-play walls, focus/audio model, picker mode |
| T6 | Wall hardening | Capped-transcode fallback path, decoder-budget degradation, sync mode |
| T7 | Polish pass | Image/slideshow surface, filters, letter rail, error/empty/offline states, Fire TV sanity pass |

Testing per slice: JVM unit tests (repositories, decision/caps mapping, wall
state machine), Compose UI tests for focus navigation (the thing that always
regresses on TV), and a small emulator matrix in CI (1080p Android TV
image); manual passes on at least one real TV/stick per milestone (SoC decoder
behavior can't be emulated — especially T5/T6).

## 10. Risks & open decisions

- **Decoder capacity variance across TV hardware** — mitigated by the budget
  policy + server capped transcode + visible degradation (§7); the wall's
  quality bar depends on the owner's actual device, so acquire the target
  hardware before T5.
- **Compose for TV component gaps** (it's stable but younger than View/
  leanback) — the design system module isolates workarounds.
- **Generated Kotlin client fidelity** — openapi-generator output sometimes
  needs post-processing; `core/api` wraps it so the rest of the app never
  touches DTOs directly.
- Open: sideload-only vs Play Store (defer; sideload first), ffmpeg decoder
  extension flavor (build only if the library has exotic audio), mobile UI
  (explicitly later, enabled by the module split).
