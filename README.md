# Cairndex

Cairndex is a local-first, Eagle-inspired media asset manager for a personal
video/image library stored on local disks or NAS-mounted storage. It runs as a
self-hosted Docker app on a Linux NAS/server and is used from a browser or the
cross-platform Tauri desktop shell.

In **Bundle Browser**, the primary object is an **Asset Bundle** (cover + video
parts + alternate versions + subtitles + screenshots + attachments), not a
single file. Cairndex links existing files in place. A separate **File Browser**
shows directories and files inside the active library root.

See [the product brief](docs/product-brief.md) and [the project status](docs/STATUS.md).

## Current behavior

Create makes a complete portable library. Its `.cairndex/manifest.json` identifies
immutable authored history under `.cairndex/replica/`. Working SQLite databases,
drafts, jobs, credentials and caches stay in private server storage. Existing
source files remain unchanged. Interrupted creation can resume its exact private
intent; unrelated metadata cannot be overwritten.

Open accepts portable packages. The old `cairndex.library` format is unsupported.
Convert it separately before opening. There is no automatic conversion. See
[ADR-0035](docs/adr/0035-portable-library-format.md).

Bundle Browser supports full-catalog search, collection/tag navigation, structured
filters, Smart Collections, title/note/rating edits, membership reviews, covers,
bulk metadata changes and paginated albums. Random, recorded local Missing Files
and Unbundled use the private catalog. File Browser stays within the selected root.
Cataloged images and video use the shared media viewer and private resume state.
Structural choices, file order, moments, conflicts and history use Metadata review.
Manual Update discovers files and prepares grouping and identity choices for review.

**Manage libraries → Access and backups** provides independent optional passphrases
for each library on each server. The same passphrase can be selected for several
libraries, but settings are independent. It protects server access, not file bytes.
A new server requires separate setup. Changing protection revokes paired access
for that library. Direct public internet exposure is unsupported.

The same panel creates and verifies private snapshots, prepares a separate
recovery after Release, shows the exact review, and activates it explicitly.
Original stores and snapshots remain intact. Destination access settings remain
in force. Back up source media, shared history, credentials and server settings
separately. Text that has not reached the server is excluded. See
[private recovery](docs/replica-recovery.md).

File Browser provides reviewed file and directory Copy, Rename, Move, Replace, Trash
and Undo with an explicit write permission. Retained content versions support
conditional recovery. Directory reviews have bounded entry and metadata limits. See
[source operations](docs/file-operations.md). Recently Used, cross-device resume and desktop file integration remain
incomplete. Local synthetic verification does not qualify provider folders, NAS,
power-loss recovery or representative library scale. See the
[capability inventory](docs/replica-catalog.md).

## Install (macOS desktop app)

Download published builds from [GitHub Releases](https://github.com/allpan3/Cairndex/releases).
Unreleased branch validation does not qualify a new release.

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

### Choose a server or library

**Servers** remains visible while browsing or recovering a connection. Desktop
remembers remote servers and **This Computer**, with one selected server at a time.
**Reconnect** refreshes that server's session. **Libraries** lists libraries on the
selected server and offers Open, Add, Release and Reopen. Typed paths belong to that
server; desktop **Browse** selects a folder on this computer and uses its managed
local server. A missing or offline remembered library stays selected with Retry.
See [connection and recovery controls](docs/connections.md).

### Everyday controls

**Settings → Keyboard shortcuts** lists selection, playback and desktop menu
keys; desktop also exposes it under Help. Narrow toolbars keep layout and item
sizing in **View options**. Panels temporarily shrink to preserve listing space
and restore their preferred widths when the window expands. File inspectors
keep technical facts and full paths under **More details**. See
[everyday interactions](docs/interactions.md).

### Release a library without quitting

Open **Libraries** and choose **Release** to stop this server serving a library
while preserving its registration and content. **Reopen** deliberately checks
the private binding before serving it again. Idle time and remote client disconnects
do not release the library. SQLite, locks, progress and caches stay in private
server storage. Metadata publication writes immutable objects to `.cairndex`.

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

Run each service from the repository root in its own terminal.

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
    ships to users but is a *frozen* build. Run `just bundled` to rebuild it when
    stale and share the host architecture's cached FFmpeg/FFprobe without
    copying them into Cargo's development output.
- **Packaged app** (`tauri build`, below) — the real installable `.app`, needed
  for deep links, notifications, and genuine end-user testing.

Rule of thumb: **run `:8000` for the web app and for a live-code desktop; build
the desktop server (sidecar or packaged app) only to test the self-contained
product.** Full detail — CORS, the sidecar freshness trap, private serving bindings
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
docker compose -f deploy/docker-compose.yml up -d
```

From this checkout, the explicit compose path selects the production image.
The library metadata package must be writable by the configured container user
(uid 10001 by default); protected source media can remain read-only. Optional
per-library passphrase sessions and paired device tokens provide an access guard.
Direct public-internet exposure is unsupported; use a private LAN or Tailscale.
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
- [docs/interactions.md](docs/interactions.md) — selection, dialog drafts, loading states and navigation continuity
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

Repository contributors must install the fail-closed privacy hooks with
`just install-privacy-hooks`. The mandatory object-level scan covers staged
bytes, commit messages, push ranges, PR title/body text, historical deleted
blobs, and unreviewed binaries; see [AGENTS.md](AGENTS.md#mandatory-publication-privacy-gate).

## License

Cairndex is released under the [MIT License](LICENSE) (owner decision,
2026-07-21; [ADR-0019](docs/adr/0019-open-source-distribution-model.md) §4).

Packaged desktop builds, including builds made from source, bundle third-party
software with its own terms — notably GPL-licensed FFmpeg. Redistribution
obligations and source provenance are described in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
