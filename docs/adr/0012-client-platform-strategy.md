# ADR-0012: Client platform strategy (web player, Android TV, macOS desktop)

- Status: accepted (owner-ratified 2026-07-04)
- Date: 2026-07-04
- Branch/PR: `docs/client-platform-plans`

## Context

The owner requested detailed plans for three post-first-release initiatives:
a first-class web video player/image viewer, an Android TV client (with a
multi-video grid as a priority feature), and a macOS desktop app closing the
UX gap to Eagle. The three overlap heavily in required server capabilities
(playback fallback, trickplay, subtitle extraction, watch progress, image
previews, device auth). Detailed plans live under `docs/plans/`; this ADR
records the consequential platform decisions so implementation branches don't
re-litigate them. Constraints: AGENTS.md dependency conservatism, monorepo
shape, metadata-first/non-destructive rules, ADR-0007 (host integration must
not be remote command execution), ADR-0008 (portable library packages),
ADR-0010 (passphrase lock is browser-session-shaped).

## Decision

1. **Server-centric media platform.** Playback capability negotiation and the
   direct / remux / HLS-transcode decision live in `apps/server`; every client
   sends a capability profile and obeys the server's decision. Transcode/remux
   run as bounded, interactive **HLS sessions** managed in-process (not
   job-queue jobs), writing to server-local ephemeral storage under
   `{CAIRNDEX_DATA_DIR}/transcode/` — not into the portable library package.
   Trickplay storyboards, extracted/converted subtitles, and sized image
   previews are reproducible per-file artifacts and live in
   `.cairndex/cache/` as today.
2. **Web player/viewer are custom-built** on a headless engine abstraction
   (native `<video>` + lazily-loaded `hls.js` where MSE is needed; native HLS
   on Safari/WKWebView). No player UI framework. `hls.js` and
   Pillow/`pillow-heif` (image previews) are the only new runtime
   dependencies. The player's UX bar is desktop-native macOS players —
   **Movist, Elmedia, IINA** (owner-stated): dual simultaneous subtitles,
   rich subtitle styling, range loop, snapshots, video adjustments. Eagle's
   comparatively bare built-in player (no subtitles, no PiP) is explicitly
   *not* the playback reference; Eagle remains the reference for the image
   viewer and browsing feel only.
3. **Android TV is a native Kotlin app** (Jetpack Compose for TV +
   Media3/ExoPlayer) in a **new repo `cairndex-android`**, consuming the
   server's OpenAPI contract via a generated client. No UI code sharing with
   the web app; TV prefers direct play and uses server HLS only as fallback
   (notably for the capped multi-video wall).
4. **The macOS desktop app is a Tauri 2 shell** in this monorepo at
   `apps/desktop`, hosting the unmodified `apps/web` SPA plus a native Rust
   layer for: per-library **local path mappings** (validated against the
   portable manifest UUID), reveal-in-Finder / open-with-default-app
   (ADR-0007 pattern 1), drag-out/drag-in, menus/shortcuts, and updater. No
   embedded server, no custom video pipeline in v1.
5. **Native clients authenticate with device tokens** issued through a
   short-code pairing flow approved from an unlocked web session; token hashes
   persist in the server-local registry DB and `get_library_session` accepts
   `Authorization: Bearer` alongside the ADR-0010 cookie. (Detailed design
   gets its own ADR when implemented.)
6. **API evolution stays additive under `/api/v1`**, with an advertised
   `api_features` list so clients feature-detect instead of version-matching.

## Alternatives considered

- **TV as web/PWA or WebView wrapper** — rejected: no viable TV browser
  runtime, and WebView forfeits ExoPlayer's codec/HDR/subtitle surface, which
  is the main reason to build a TV client at all.
- **React Native / Flutter for TV** — rejected: second-class TV support; the
  player and focus engine would be native work anyway, plus a bridge tax.
- **Electron for desktop** — rejected: no capability advantage over Tauri
  here, much heavier footprint.
- **Native Swift/SwiftUI (+MPVKit) desktop app** — deferred: best possible
  feel but a full second client; the recorded fallback if the WKWebView
  ceiling is hit is an embedded native viewer window, not a rewrite.
- **Player UI library (Vidstack/video.js/media-chrome)** — rejected for now:
  the app is fully hand-built and the headless core is what the video wall
  and TV-parity work reuse; `media-chrome` noted as an accelerator fallback.
- **Transcode output inside `.cairndex/cache/`** — rejected: sessions are
  non-reproducible ephemeral runtime state and would bloat portable libraries
  (answers the open cache-policy question in `docs/STATUS.md`).
- **Android client inside this monorepo** — rejected: separate toolchain/CI
  cadence; contract-first via OpenAPI keeps the seam explicit.

## Consequences

- `apps/` grows a third member (`apps/desktop`), amending the ADR/AGENTS
  monorepo shape; AGENTS.md gains desktop gates when D1 lands.
- The server takes on interactive ffmpeg process management (bounded
  concurrency, idle reaping) — the largest new operational surface; it must
  stay off the job queue and off request-handler hot paths.
- Probe output must be enriched (all audio/subtitle streams, chapters, HDR)
  and old rows re-probed for full fidelity.
- A second repo means server releases need tags and a pinned-contract
  workflow once `cairndex-android` starts.
- Follow-up ADRs required at implementation time: HLS session/transcode
  design (1), device pairing/auth (5), and any deviation from the plans.

## References

- `docs/plans/README.md`, `docs/plans/01–03` (detailed designs, milestones)
- ADR-0007 (host integration), ADR-0008 (library packages), ADR-0010
  (passphrase lock)
- `docs/product-brief.md` — Future compatibility (Android TV, Tauri shell);
  first-release anti-goals unchanged
