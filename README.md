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
tracks, **seek-bar storyboard trickplay** and chapter ticks, **watch
progress / resume**, and **moments**: saved frames and spans inside a video,
tagged and commented in the Bundle Inspector, drawn on the seek track, and
loopable with the **range loop** — plus a **zoom/pan image viewer** with progressive
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
library, persist a reviewable grouping plan, refresh the UI, and open grouping
review when suggestions exist. Technical metadata continues in the background;
missing or stale storyboard generation follows it because storyboard eligibility
uses the probed duration. Individual scan, grouping suggestion, metadata
collection, and storyboard-generation actions remain available in the
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
Important follow-ups include cross-filesystem repair candidates and token
rotation/expiry policy. Bundle/container reclassification and File Browser
write-mode drag-in copy are implemented. Job progress bars, large-library browse
indexing, whole-library indexed text search (SQLite FTS5), media
fallback/transcoding, and pinyin matching in local tag/collection and file
pickers are implemented.
See [docs/STATUS.md](docs/STATUS.md) for the current milestone, known gaps, and
recommended next tasks.

## Install (macOS desktop app)

> No release has been published yet (plan 3 D7). The pipeline that builds these
> artifacts exists; the steps below describe what it publishes.

Releases publish a `.dmg` for **Apple Silicon**, with a `.sha256` beside it.
Download it, open it, and drag **Cairndex** to Applications.

```bash
shasum -a 256 -c Cairndex_<version>_aarch64.dmg.sha256
```

**On an Intel Mac, build from source** — see
[docs/deployment.md](docs/deployment.md). There is no prebuilt Intel artifact;
everything needed to produce one is still in the repository (the Intel ffmpeg is
pinned, and the build is documented), it is simply not built for each release.

### First launch: "Apple could not verify..."

Cairndex is **not signed with an Apple Developer ID**, so the first launch is
blocked:

1. Open Cairndex. macOS refuses and offers only **Done** / **Move to Trash**.
   Choose **Done** — do not move it to the Trash.
2. Open **System Settings → Privacy & Security** and scroll to the **Security**
   section. A line about Cairndex being blocked appears there, with an **Open
   Anyway** button. It only appears *after* step 1, so do not go looking for it
   first.
3. Click **Open Anyway**, authenticate, and confirm **Open Anyway** once more.

Cairndex opens normally from then on — until you update it.

**Every update repeats these steps.** That is not a bug and not a stale
approval you can clear: a new download is quarantined again, and because
Cairndex is ad-hoc signed rather than signed with a stable identity, each build
has a different code signature that macOS has no way to carry your previous
approval across. Expect the dialog once per version you install.

Why not just sign it: a Developer ID needs a $99/yr Apple Developer membership.
The trade is recorded as an upgrade path rather than a requirement — see
[ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4 — and this
per-update repetition is the main argument on the other side of it, since the
cost is paid on every release rather than once. If you would rather not do any
of it, build from source (below); a locally built app is never quarantined and
never shows the dialog.

### What is inside the app

The desktop app is self-contained: it bundles the Cairndex server and a static
`ffmpeg`/`ffprobe`, so opening a library folder on your own Mac needs no
Python, no Docker, no Homebrew, and no separate ffmpeg install. Pointing the
app at a server you already run (a NAS, say) works the same as it always has.

The bundled ffmpeg is GPL-licensed and redistributing it carries source
obligations that Cairndex's own MIT license does not — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The app itself also carries
that notice, Cairndex's MIT license, and the full GPLv3/LGPLv3 texts under its
`Contents/Resources/licenses/` directory.

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
deploy/     # What a server needs: compose file, env sample, runbook
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

### Which surface to run, and when

Cairndex is a frontend plus a server; **where the server comes from is the choice
that trips people up.** Three ways to run it, fastest to most production-like:

- **Web app** (`:8000` + `:5173`) — the browser build. Vite proxies `/api` to the
  `:8000` backend, so both live-reload and are always current. Use this for most
  frontend and server work; it needs no CORS setup and no desktop toolchain.
- **Desktop shell** (`npm run tauri dev`) — the same frontend in the native
  window. It needs a server, and you pick one:
  - **Point it at your `:8000` server** (best while iterating) — live code, no
    rebuilds, and it shares libraries with the web app. Start `:8000` with the dev
    origin allowed: `CAIRNDEX_CORS_EXTRA_ORIGINS=http://127.0.0.1:5173`, then
    connect the app to `http://127.0.0.1:8000`.
  - **"This Computer"** — the shell runs its own **bundled** server, which is what
    ships to users but is a *frozen* build. Rebuild it after server changes
    (`apps/server/packaging/build_sidecar.py`) or it serves stale code — the cause
    of a route that `404`s in the desktop while the web app works.
- **Packaged app** (`tauri build`, below) — the real installable `.app`, needed
  for deep links, notifications, and genuine end-user testing.

Rule of thumb: **run `:8000` for the web app and for a live-code desktop; build
the desktop server (sidecar or packaged app) only to test the self-contained
product.** Full detail — CORS, the sidecar freshness trap, the single-owner lease
— is in [docs/development.md](docs/development.md#desktop-appsdesktop).

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

Cairndex shows the server/package version and release commit under **Settings →
About**. A development build records no commit unless
`CAIRNDEX_BUILD_COMMIT=<git-sha>` was set while compiling the desktop shell.
After every rebuild, re-check which copy owns the `cairndex://` scheme; each
build re-registers the build-directory bundle. See
[docs/deployment.md](docs/deployment.md#installing-and-updating-your-local-build).

## Quickstart (Docker)

**Self-hosting on a NAS or server** — one hardened container serving the API and
the built web app, pulled from GitHub Container Registry.

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) is the whole
deployment: every setting has a working default, so it runs as-is once you point
it at your library. Paste it into your NAS's **Project** / **Stack** / **Compose**
section (Synology, UGREEN, QNAP, TrueNAS all have one) and manage it from there
with logs and stats, or run it from a shell:

```bash
docker compose up -d
```

The library directory must be writable by uid 10001, the container's non-root
user. Do not expose this to the public internet — there is no authentication
yet; reach it over your LAN or Tailscale.
[deploy/README.md](deploy/README.md) is the runbook (permissions, updating,
backups); [docs/deployment.md](docs/deployment.md) has the reasoning, the full
environment table, and how to build the image yourself instead of pulling it.

**Developing in containers instead of natively:**

```bash
cp .env.example .env
docker compose up --build
```

Backend on `:8000` and the Vite dev server on `:5173`, both hot-reloading from
bind-mounted source. See
[docs/development.md](docs/development.md#running-with-docker) — in particular
the note that a library may be open on only one server at a time, so the dev
stack wants a scratch library rather than one your desktop app is serving.

Both need Docker with the Compose v2 plugin (Docker Desktop on macOS, or
`docker-ce` + `docker-compose-plugin` on Linux).

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

## Security

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/allpan3/Cairndex/security/advisories/new),
not a public issue. Do not attach real library media or identifying metadata;
reduce reports to synthetic data. See [SECURITY.md](SECURITY.md) for supported
versions, deployment boundaries, and reporting details.

## License

Cairndex is released under the [MIT License](LICENSE) (owner decision,
2026-07-21; [ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4).

Release artifacts additionally bundle third-party software with its own terms —
notably a GPL-licensed FFmpeg, whose redistribution obligations are discharged
in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Building from source
bundles nothing and is unaffected.
