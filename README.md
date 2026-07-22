# Cairndex

Cairndex is a local-first, Eagle-inspired media asset manager for a personal
video/image library stored on local disks or NAS-mounted storage. It runs as a
self-hosted Docker app on a Linux NAS/server and is used from a browser or the
cross-platform Tauri desktop shell.

In **Bundle Browser**, the primary object is an **Asset Bundle** (cover + video
parts + alternate versions + subtitles + screenshots + attachments), not a
single file. Cairndex links existing files in place — it does not copy, move,
rename, or otherwise manage your files in the normal MVP path. A separate
**File Browser** browses the underlying directories and files inside the active
Cairndex library.

See [docs/product-brief.md](docs/product-brief.md) for the product model and
[AGENTS.md](AGENTS.md) for the canonical engineering rules that govern coding
agents working in this repository.

## Status

Cairndex is past the project-foundation phase. It provides an Eagle-inspired
desktop web browser over asset bundles: portable per-library metadata,
hierarchical **Collections**, a read-only physical **File Browser**, hierarchical
tags + tag groups, filtering and Smart Collections, scan/probe/thumbnail/
storyboard jobs with high-confidence moved-file repair, and a hardened
single-container production deployment. Media playback runs in a unified
custom **media viewer** — a hand-built video player (auto-hiding controls,
keyboard map, speed, PiP, fullscreen, snapshot, MediaSession) with subtitle
tracks, **seek-bar storyboard trickplay** and chapter ticks, and **watch
progress / resume** — plus a **zoom/pan image viewer** with progressive
preview tiers and server-side WebP derivatives that make HEIC/TIFF/BMP
openable in the browser. Bundle file sequence is the media playlist order, and
one remembered bundle cursor keeps card hover and double-click open aligned
without coupling either behavior to the selected cover artwork.

Cairndex is now built around portable, Eagle-like **libraries** (ADR-0008):
each library is a directory carrying its own `.cairndex/` metadata
(`manifest.json`, `library.db`, `cache/`), and a separate server-side
**registry** tracks registered libraries and the job queue. All content APIs are
scoped to one library (`/api/v1/libraries/{id}/…`); the desktop app picks an
active library per tab. The normal maintenance flow is **Update**: scan the
library, persist a reviewable grouping plan, collect technical metadata, refresh
the UI, open grouping review when suggestions exist, and generate missing or
stale storyboards in the background. Individual scan, grouping suggestion,
metadata collection, and storyboard-generation actions remain available in the
maintenance menu. There are no global storage-root content APIs in the current
model.

The app is still pre-1.0 and should not be exposed directly to the public
internet. Optional passphrase/cookie auth and owner-approved device bearer
tokens provide a private-network, single-owner guardrail; the desktop shell can
pair, retain its server-bound token, and browse/play a protected scoped library
without a browser cookie. Its bearer is sent only for libraries in that grant;
unscoped unprotected libraries retain anonymous access, while unscoped protected
libraries offer pairing instead of an unusable cross-origin passphrase form. A
desktop-only Settings page maps each server library to its local/SMB mount after
matching the portable manifest UUID; mapped files gain safe reveal/default-app
actions plus drag-out to Finder and reverse-mapped drag-in, while browser and
unmapped-library behavior remain unchanged.
Important follow-ups
include grouping bundle/container reclassification, File Browser write mode with
drag-in copy-into-library, cross-filesystem repair candidates, and token
rotation/expiry policy. Job progress bars, large-library browse indexing,
whole-library indexed text search (SQLite FTS5), media fallback/transcoding,
and pinyin matching in local tag/collection and file pickers are implemented.
See [docs/STATUS.md](docs/STATUS.md) for the current milestone, known gaps, and
recommended next tasks.

## Install (macOS desktop app)

> The first public release is still being assembled (plan 3 D7). The steps
> below describe the artifacts it will publish; there is no download link yet.

Releases publish a `.dmg` per architecture — `aarch64` for Apple Silicon,
`x64` for Intel. Download the one matching your Mac, open it, and drag
**Cairndex** to Applications.

### First launch: "Apple could not verify..."

Cairndex is **not signed with an Apple Developer ID**, so the first launch is
blocked. This is expected, and it is a one-time step:

1. Open Cairndex. macOS refuses and offers only **Done** / **Move to Trash**.
   Choose **Done** — do not move it to the Trash.
2. Open **System Settings → Privacy & Security** and scroll to the **Security**
   section. A line about Cairndex being blocked appears there, with an **Open
   Anyway** button. It only appears *after* step 1, so do not go looking for it
   first.
3. Click **Open Anyway**, authenticate, and confirm **Open Anyway** once more.

Cairndex opens normally from then on. Every later launch, and every update,
skips this entirely.

Why not just sign it: a Developer ID needs a $99/yr Apple Developer membership,
and the cost of skipping it is this one dialog. It is recorded as an upgrade
path rather than a requirement — see
[ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4. If you would
rather not do any of this, build from source (below); a locally built app is
never quarantined and never shows the dialog.

### What is inside the app

The desktop app is self-contained: it bundles the Cairndex server and a static
`ffmpeg`/`ffprobe`, so opening a library folder on your own Mac needs no
Python, no Docker, no Homebrew, and no separate ffmpeg install. Pointing the
app at a server you already run (a NAS, say) works the same as it always has.

The bundled ffmpeg is GPL-licensed and redistributing it carries source
obligations that Cairndex's own MIT license does not — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Repository layout

```text
apps/
  server/   # FastAPI backend (Python 3.12+, SQLAlchemy, SQLite, ffmpeg)
  web/      # React + TypeScript frontend (Vite, TanStack Query/Virtual)
  desktop/  # Tauri 2 host for the shared apps/web frontend (Rust)
docs/
  adr/                # Architecture Decision Records
  reference/eagle/    # Eagle UI reference screenshots (not committed media)
infra/
  docker/   # Dockerfiles for local/dev and NAS deployment
```

## Quickstart (local development)

Requirements: uv (manages Python 3.12+ for you) and Node.js 20+. Desktop
development additionally needs a current stable Rust toolchain and the Tauri 2
platform prerequisites. See
[docs/development.md](docs/development.md) for full setup, environment variables,
and troubleshooting.

```bash
# Backend — installs Python 3.12 automatically via uv, runs on :8000
cd apps/server
uv sync
uv run uvicorn cairndex.main:app --reload

# Frontend — runs on :5173, proxies /api to the backend
cd apps/web
npm install
npm run dev

# Desktop — starts the same apps/web Vite server inside the Tauri shell
cd apps/desktop
npm install
npm run tauri dev
```

Health check: `curl http://localhost:8000/api/v1/health`

### Rebuilding and reinstalling the desktop app

`tauri dev` above runs the shell against the Vite dev server. To test a **packaged**
build — required for deep links, notifications, and anything else that needs a
registered `.app` — build it and replace the installed copy. Building alone does
**not** update `/Applications`:

```bash
cd apps/desktop
npm run tauri build                              # writes target/release/bundle/

osascript -e 'quit app "Cairndex"' 2>/dev/null   # quit before replacing
rm -rf /Applications/Cairndex.app
cp -R src-tauri/target/release/bundle/macos/Cairndex.app /Applications/
open /Applications/Cairndex.app
```

Cairndex displays no version anywhere, so a stale install is indistinguishable
from a current one by looking at it. **When in doubt, rebuild and reinstall** —
it takes under a minute and is more reliable than trying to work out what you are
running. After every rebuild, re-check which copy owns the `cairndex://` scheme;
each build re-registers the build-directory bundle. See
[docs/deployment.md](docs/deployment.md#installing-and-updating-your-local-build).

## Quickstart (Docker)

```bash
docker compose up --build
```

This starts the backend (`:8000`) and frontend dev server (`:5173`). Requires
Docker with the Compose v2 plugin (Docker Desktop on macOS, or `docker-ce` +
`docker-compose-plugin` on Linux). See [docs/deployment.md](docs/deployment.md)
for NAS deployment notes and `docker-compose.prod.yml` for the hardened
single-container production stack.

## Documentation

- [docs/product-brief.md](docs/product-brief.md) — product model, domain concepts, UI direction, and first-release anti-goals
- [AGENTS.md](AGENTS.md) — canonical agent operating rules and engineering constraints
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/data-model.md](docs/data-model.md)
- [docs/filter-language.md](docs/filter-language.md)
- [docs/performance.md](docs/performance.md) — large-library benchmark tooling and baselines
- [docs/adr/](docs/adr/) — Architecture Decision Records
- [docs/STATUS.md](docs/STATUS.md) — current milestone and known issues
- [CHANGELOG.md](CHANGELOG.md)

## License

Cairndex is released under the [MIT License](LICENSE) (owner decision,
2026-07-21; [ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4).

Release artifacts additionally bundle third-party software with its own terms —
notably a GPL-licensed FFmpeg, whose redistribution obligations are discharged
in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Building from source
bundles nothing and is unaffected.
