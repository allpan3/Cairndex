# Client platform & media experience plans

> Status: written as planning documents (owner-requested, 2026-07-04) and now
> **partly built** — plans 1 and 3 have shipped most of their milestones, plans
> 2 and 4 have not started. The build order below is the live view; each plan's
> own milestone table marks what has landed. Consequential decisions are
> gathered in [ADR-0012](../adr/0012-client-platform-strategy.md), **accepted
> (owner-ratified) 2026-07-04** after review.

Four major initiatives. The first three were planned together because they
share most of their server-side media foundations; the fourth (write mode)
is its own server-side track. Owner re-prioritized 2026-07-10 and added M12 on
2026-07-11: **plan 1 M9 + M12 → pairing/device tokens (plan 2 T0) → macOS
desktop shell (plan 3) → write mode (plan 4, so media can be dragged into the
app) → Android client (plan 2 T1–T7)**. Plan 1 M8/M10/M11 moved to the future
bucket. A Linux desktop
app is a stated future want — the desktop shell must be architected for
cross-platform reuse (plan 3 §2–§3), not as a macOS-only codebase.

Two things have since been inserted ahead of write mode rather than replacing
anything: the **library ownership lease + local-server sidecar**
([ADR-0018](../adr/0018-library-ownership-lease-and-local-server.md), accepted
2026-07-19), because write-mode operations need one server per library; and the
**first public release** (plan 3 D7), because the owner's decision to open
source Cairndex and publish prebuilt binaries
([ADR-0019](../adr/0019-open-source-distribution-model.md), 2026-07-20) made
shipping a release its own piece of work. Both are in the build order below.

| #   | Plan                                                        | Doc                                                                                   |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | First-class web video player & image viewer                 | [01-web-media-player-and-viewer.md](01-web-media-player-and-viewer.md)                |
| 2   | Android TV client (native Kotlin/Compose, multi-video grid) | [02-android-tv-client.md](02-android-tv-client.md)                                    |
| 3   | macOS desktop app (Tauri 2 shell)                           | [03-macos-desktop-app.md](03-macos-desktop-app.md)                                    |
| 4   | Library write mode (guarded file operations)                | [04-library-write-mode.md](04-library-write-mode.md) — ADR-0013 (accepted 2026-07-04) |
| 5   | Network-library latency: Theater Mode + where the DB lives  | [05-network-library-latency.md](05-network-library-latency.md) — **deferred post-v0.1.0** |

## How the three initiatives relate

The overlap the owner identified is real, and it lives almost entirely on the
**server**. The strategy is: build the media/playback platform once in
`apps/server`, keep every client thin, and let each client be the best citizen
of its platform.

```text
                        ┌────────────────────────────────────────────┐
                        │ apps/server (this repo)                    │
                        │                                            │
                        │  playback decision engine (caps-aware)     │
                        │  direct stream / remux / HLS transcode     │
                        │  storyboards (trickplay), image previews   │
                        │  subtitle extraction & conversion          │
                        │  watch progress / continue-watching        │
                        │  device pairing & bearer tokens            │
                        │  OpenAPI contract (/api/v1)                │
                        └───────┬───────────────┬───────────────┬────┘
                                │               │               │
              ┌─────────────────┴──┐   ┌────────┴─────────┐  ┌──┴──────────────────┐
              │ apps/web           │   │ apps/desktop     │  │ cairndex-android    │
              │ React SPA          │   │ Tauri 2 shell    │  │ (new repo)          │
              │ (plain web client) │   │ hosts apps/web + │  │ Kotlin, Compose TV, │
              │                    │   │ native helpers   │  │ Media3/ExoPlayer    │
              └────────────────────┘   └──────────────────┘  └─────────────────────┘
```

Reuse map:

- **Web player/viewer (plan 1)** is built inside `apps/web`, so the **desktop
  app (plan 3) inherits 100% of it** — the Tauri shell renders the same SPA.
- **The TV app (plan 2) shares no UI code** (different language/runtime, and a
  10-foot UI should not be a mouse UI anyway), but consumes the _same server
  features_: the playback decision endpoint, HLS sessions, storyboards, watch
  progress, pairing tokens, and thumbnails/previews — all built once in plan 1's
  server phase.
- **Multi-video grid ("video wall")** is specified once (plan 2 §7, it is the
  TV priority) with a web/desktop counterpart in plan 1 §9 using the same
  interaction rules (focused-cell audio, per-cell source picker, sync toggle).

## Repository strategy (proposed, see ADR-0012)

- **This repo stays the product core**: `apps/server` (the platform),
  `apps/web` (the reference/plain web client), plus a new **`apps/desktop`**
  for the Tauri shell. Tauri's frontend _is_ `apps/web`'s Vite build — putting
  it in another repo would mean versioning a build artifact across repos for
  zero benefit. The existing monorepo gates extend naturally (a `desktop` CI
  job builds the shell; web gates already cover the UI).
- **Android TV gets a new repo, `cairndex-android`.** Different toolchain
  (Gradle/Kotlin/Android SDK), different CI (emulators, APK signing), different
  release cadence. The contract between repos is the server's **OpenAPI
  artifact** plus an **API feature-flag handshake** (below). Naming it
  `-android` (not `-tv`) leaves room for a future mobile target in the same
  codebase.
- Server releases get git tags once the first external client exists; the
  Android repo pins a minimum server version.

## Cross-cutting server foundations (build once)

These are the shared prerequisites; plan 1 §3–§6 specifies each in detail. All
are built except **2**, which the owner moved out of the foundations and into
plan 1 M8 (deferred) — the numbering is kept as written because other documents
cite these by number.

1. **Probe enrichment** — store _all_ audio/subtitle streams and chapters in
   `tech_metadata`, not just the first audio stream.
2. **Embedded text-subtitle extraction** to cached WebVTT (ffmpeg `-map 0:s:n`)
   — owner-deprioritized: lands with plan 1 M8 (after HLS), not as an early
   foundation.
3. **Storyboard/trickplay job** — sprite sheets + WebVTT index per video,
   cached under `.cairndex/cache/storyboards/`.
4. **Image preview derivatives** — sized web-format previews under
   `.cairndex/cache/previews/`, unlocking HEIC/TIFF viewing and TV-sized
   thumbnails.
5. **Watch progress** — `playback_progress` table in `library.db` (nullable
   `user_id` for future multi-user), throttled `PUT`, continue-watching query.
6. **Playback decision endpoint** — client sends a _capability profile_, server
   answers `direct | remux | transcode` with URLs. Keeps the decision
   server-side (AGENTS.md) but capability-informed per client.
7. **HLS playback sessions** — bounded ffmpeg session manager (remux `-c copy`
   or transcode), on-demand segments, restart-on-far-seek. The single biggest
   server work item.
8. **Device pairing / bearer tokens** ([ADR-0015](../adr/0015-device-pairing-and-bearer-tokens.md)) — short-code pairing approved from an
   unlocked web session; token hashes in the registry DB; `Authorization:
Bearer` accepted alongside the ADR-0010 cookie. Needed by TV (no cookie/
   typing UX) and cleaner for the desktop shell. Requires an auth ADR when
   implemented.

**API evolution discipline:** everything stays additive under `/api/v1`.
`GET /api/v1/health` (or a new `GET /api/v1/capabilities`) gains an
`api_features` list (`"trickplay"`, `"hls"`, `"progress"`, `"pairing"`, …) so
older/newer clients degrade gracefully instead of version-matching.

## Recommended build order across all four plans

Re-sequenced 2026-07-10 (owner decision, after M1–M7 shipped; the prior order
is in git history), then extended as ADR-0018 and ADR-0019 were accepted:
phase F narrowed to the lease/sidecar work that other documents cite it by, and
the first public release was inserted as G, pushing write mode and the Android
client down a letter each. A–F are the ones referenced elsewhere and keep their
letters. Current order:

| Phase  | Work                                                                                                                    | Why this order                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A ✅   | Server foundations 1–7 (probe, storyboards, previews, progress, decisions, HLS)                                         | Shipped as plan 1 M1–M7                                                                                                                                                                            |
| B ✅   | Web player v2 + image viewer v2 + HLS integration (plan 1 M2–M7)                                                        | Merged through PR #9                                                                                                                                                                               |
| C ✅   | Plan 1 **M9 player interaction polish**, then **M12 hover video preview** (both recomposed 2026-07-11 — plan 1 §11/§13) | Merged as #11 and #12. Every later client inherits the same SPA behavior. A-B loop remains in M11, video adjustments + slideshow deferred                                                          |
| D ✅   | Server: **pairing + device tokens** (plan 2 §4 / T0)                                                                    | Merged as #13. Pulled ahead of the Android client because the desktop shell's auth (plan 3 D2) reuses it                                                                                           |
| E ✅   | **macOS desktop shell** (plan 3 D1–D5)                                                                                  | Merged as #15–#21. Built cross-platform-first so a Linux (and Windows) shell later is packaging + CI, not a rewrite (plan 3 §2–§3)                                                                 |
| F ✅   | **Library ownership lease + local-server sidecar** ([ADR-0018](../adr/0018-library-ownership-lease-and-local-server.md), accepted 2026-07-19) — the server-side lease (§2–§4) and §6 checkpoint hygiene, then the plan 3 D6 sidecar | Merged as #27, with the unified library add/remove flow following in #28. The lease enforces one server per library and landed server-side first (it hardens the NAS deployment on its own and is a precondition for write-mode operations); the shell's sidecar + connections model then lets local library folders open without server administration |
| G ✅   | **First public release** (plan 3 D7, [ADR-0019](../adr/0019-open-source-distribution-model.md))                     | Went ahead of write mode because it is what makes everything already built reach anyone else, and D6's bundled sidecar is what created the packaging obligation. Shipped: a pinned static ffmpeg, a tag-triggered release workflow proven by a real `v0.1.0` run, install docs, and the GPL source offer. Building it found two defects planning would not have: an invalid bundle signature, and a GPL encoder linked in for a codec path Cairndex never calls. One owner-verification item — a pass on a genuinely downloaded build — is deferred to after phase H at the owner's request |
| H (next) | **Library write mode** (plan 4), re-ordered W0 → W1 → W5                                                          | Driving use case: **drag media from Finder into the app** (plan 3 §6 drag-in + W5 import-external). Needs the phase F lease underneath it. W3/W4 (move/trash) follow; W2 waits on M11 (deferred) |
| I      | **Android client** (plan 2 T1–T7)                                                                                       | Largest new surface; by then every server API it needs exists and is proven (pairing landed in phase D)                                                                                            |
| Future | Plan 1 M8 (subtitle depth), M10 (web video wall), M11 (exports) + plan 4 W2, Linux/Windows shells, TV wall follow-ups   | Deferred by owner 2026-07-10                                                                                                                                                                       |

Phases are sequenced by dependency, not by strict calendar. Each phase
decomposes into the milestone slices listed in its plan and lands via normal
branch/PR discipline.

## Out of scope for all four plans

- Internet metadata scraping, AI tagging, multi-user RBAC (product anti-goals).
- iOS/tvOS clients (revisit after Android TV ships).
- Replacing SQLite, Redis/Celery job infrastructure (AGENTS.md).
- DRM, public-internet hardening beyond the existing guardrail model.

The product brief's first-release anti-goals ("native macOS or Android TV
applications") stand: these plans target the post-first-release roadmap the
brief already names under _Future compatibility_.
