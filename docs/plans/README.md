# Client platform & media experience plans

> Status: **planning documents** (owner-requested, 2026-07-04). Nothing here is
> implemented. Each plan proposes its own milestones; consequential decisions
> are gathered in [ADR-0012](../adr/0012-client-platform-strategy.md),
> **accepted (owner-ratified) 2026-07-04** after review.

Three major initiatives, planned together because they share most of their
server-side foundations:

| # | Plan | Doc |
|---|------|-----|
| 1 | First-class web video player & image viewer | [01-web-media-player-and-viewer.md](01-web-media-player-and-viewer.md) |
| 2 | Android TV client (native Kotlin/Compose, multi-video grid) | [02-android-tv-client.md](02-android-tv-client.md) |
| 3 | macOS desktop app (Tauri 2 shell) | [03-macos-desktop-app.md](03-macos-desktop-app.md) |

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
  10-foot UI should not be a mouse UI anyway), but consumes the *same server
  features*: the playback decision endpoint, HLS sessions, storyboards, watch
  progress, pairing tokens, and thumbnails/previews — all built once in plan 1's
  server phase.
- **Multi-video grid ("video wall")** is specified once (plan 2 §7, it is the
  TV priority) with a web/desktop counterpart in plan 1 §9 using the same
  interaction rules (focused-cell audio, per-cell source picker, sync toggle).

## Repository strategy (proposed, see ADR-0012)

- **This repo stays the product core**: `apps/server` (the platform),
  `apps/web` (the reference/plain web client), plus a new **`apps/desktop`**
  for the Tauri shell. Tauri's frontend *is* `apps/web`'s Vite build — putting
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

## Cross-cutting server foundations (build once, in this order)

These are the shared prerequisites; plan 1 §3–§6 specifies each in detail.

1. **Probe enrichment** — store *all* audio/subtitle streams and chapters in
   `tech_metadata`, not just the first audio stream.
2. **Embedded text-subtitle extraction** to cached WebVTT (ffmpeg `-map 0:s:n`).
3. **Storyboard/trickplay job** — sprite sheets + WebVTT index per video,
   cached under `.cairndex/cache/storyboards/`.
4. **Image preview derivatives** — sized web-format previews under
   `.cairndex/cache/previews/`, unlocking HEIC/TIFF viewing and TV-sized
   thumbnails.
5. **Watch progress** — `playback_progress` table in `library.db` (nullable
   `user_id` for future multi-user), throttled `PUT`, continue-watching query.
6. **Playback decision endpoint** — client sends a *capability profile*, server
   answers `direct | remux | transcode` with URLs. Keeps the decision
   server-side (AGENTS.md) but capability-informed per client.
7. **HLS playback sessions** — bounded ffmpeg session manager (remux `-c copy`
   or transcode), on-demand segments, restart-on-far-seek. The single biggest
   server work item.
8. **Device pairing / bearer tokens** — short-code pairing approved from an
   unlocked web session; token hashes in the registry DB; `Authorization:
   Bearer` accepted alongside the ADR-0010 cookie. Needed by TV (no cookie/
   typing UX) and cleaner for the desktop shell. Requires an auth ADR when
   implemented.

**API evolution discipline:** everything stays additive under `/api/v1`.
`GET /api/v1/health` (or a new `GET /api/v1/capabilities`) gains an
`api_features` list (`"trickplay"`, `"hls"`, `"progress"`, `"pairing"`, …) so
older/newer clients degrade gracefully instead of version-matching.

## Recommended build order across all three plans

| Phase | Work | Why this order |
|-------|------|----------------|
| A | Server foundations 1–6 (everything except HLS + pairing) | Unblocks all clients; each item is a small reviewable slice |
| B | Web player v2 + image viewer v2 (plan 1) | Validates the new APIs with the cheapest client; immediate daily-use value |
| C | HLS sessions + web integration (plan 1 §6) | Biggest server risk; web is the client that needs it most (browsers play the least) |
| D | Desktop Tauri shell (plan 3) | Small increment over B; delivers open-with/reveal/drag-out (ADR-0007) |
| E | Android TV client (plan 2), pairing first | Largest new surface; by now every server API it needs exists and is proven |
| F | Multi-video wall: TV first, then web/desktop parity | Depends on stable single-player foundations on each platform |

Phases are sequenced by dependency, not by strict calendar; B/C and D can
interleave. Each phase decomposes into the milestone slices listed in its plan
and lands via normal branch/PR discipline.

## Out of scope for all three plans

- Internet metadata scraping, AI tagging, multi-user RBAC (product anti-goals).
- iOS/tvOS clients (revisit after Android TV ships).
- Replacing SQLite, Redis/Celery job infrastructure (AGENTS.md).
- DRM, public-internet hardening beyond the existing guardrail model.

The product brief's first-release anti-goals ("native macOS or Android TV
applications") stand: these plans target the post-first-release roadmap the
brief already names under *Future compatibility*.
