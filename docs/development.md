# Development guide

## Prerequisites

| Tool                       | Why                                            | Notes                                                                                                |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `uv`                       | Backend dependency + Python version management | Installs Python 3.12 for you even though the host may ship an older system Python.                   |
| Node.js 20+                | Frontend tooling                               | `npm` ships with Node; no separate package manager required.                                         |
| Stable Rust + Cargo        | Tauri 2 desktop host                           | Required only for `apps/desktop`; install with rustup and include `clippy` + `rustfmt`.               |
| Docker + Compose v2 plugin | Optional, for the containerized dev stack      | macOS: install Docker Desktop. Linux: `docker-ce` + `docker-compose-plugin`.                         |
| `ffmpeg` / `ffprobe`       | Media probing, thumbnails, subtitle conversion | Required for full media behavior. macOS: `brew install ffmpeg`. Debian/Ubuntu: `apt install ffmpeg`. |

Cairndex is developed on macOS and deployed on Linux; avoid macOS-only or
Linux-only assumptions in code (path separators, case sensitivity, process
APIs, filesystem identity reliability).

## Backend (`apps/server`)

```bash
cd apps/server
uv sync                 # creates .venv, installs locked deps + Python 3.12
uv run uvicorn cairndex.main:app --reload --port 8000
```

Checks (run from `apps/server`):

```bash
uv run ruff format --check .   # formatting
uv run ruff check .            # linting
uv run mypy src                # type checking
uv run pytest                  # tests
```

Auto-fix formatting/lint issues with `uv run ruff format .` and
`uv run ruff check --fix .`.

## Frontend (`apps/web`)

```bash
cd apps/web
npm install
npm run dev              # http://localhost:5173, proxies /api to :8000
```

Checks (run from `apps/web`):

```bash
npm run lint              # eslint
npm run format:check      # prettier --check
npm run typecheck         # tsc --noEmit
npm run test              # vitest run
npm run test:e2e          # playwright (boots its own dev server)
npm run test:e2e:frontend # browser-only tests with intercepted APIs
npm run test:e2e:fullstack # real-backend tests; requires uv sync + ffmpeg
npm run build             # production SPA build
```

CI keeps the frontend job Node-only and runs `@fullstack` Playwright tests in a
separate job that provisions the locked backend environment and ffmpeg.

## Desktop (`apps/desktop`)

The Tauri 2 shell hosts the same `apps/web` Vite development server and
production `dist`; there is no desktop frontend fork. `tauri dev` loads a page
whose origin is Vite's `http://127.0.0.1:5173`, so opt that exact development
origin into the backend before starting the shell:

```bash
cd apps/server
CAIRNDEX_CORS_EXTRA_ORIGINS=http://127.0.0.1:5173 \
  uv run uvicorn cairndex.main:app --reload --port 8000
```

```bash
cd apps/desktop
npm install
npm run tauri dev
```

The first-run screen stores a verified server URL in the Tauri store. Bootstrap
also requires the health response to advertise the pairing and progress
capabilities used by the shell, so an unrelated HTTP 200 service remains on the
editable setup screen. Packaged custom-protocol origins are allowed by default;
arbitrary HTTP(S) origins are
denied unless listed exactly in the comma-separated
`CAIRNDEX_CORS_EXTRA_ORIGINS`. Leave that variable unset outside deliberate
local development. On macOS, the package declares local-network use and permits
cleartext HTTP only in its WKWebView content so an explicitly configured private
LAN server works; prefer HTTPS for any server outside a trusted private network.

Settings → Pair this device starts the anonymous ADR-0015 flow and polls until
an unlocked same-origin web session approves the displayed code and explicit
library scope. The shell stores the one-time token beside its issuing server in
the Tauri store, including the approved library ids. Its platform fetch
transport adds `Authorization: Bearer` only to approved library-scoped URLs.
Unscoped unprotected libraries remain anonymous; unscoped protected libraries
show the pairing path because the browser passphrase cookie cannot unlock a
cross-origin shell. Settings can forget the local token, while server revocation
remains in the owner web Devices page. Changing the configured server drops an
unrelated retained token.

ADR-0017 defines the separate loopback media transport. It accepts only scoped
read-only stream/HLS/thumbnail/preview/storyboard/subtitle/File Browser routes,
uses exact shell origins, rejects redirects, rotates its capability path, bounds
workers/queue/read stalls, and preserves known range lengths. Plain web keeps
same-origin relative URLs and cookie unlocks.

Settings → Libraries → **Locate on This Mac** runs the folder picker in the
native command layer. The selected root must contain a readable
`.cairndex/manifest.json` whose `library_uuid` equals the selected server
library's portable UUID. The shell stores the canonical local root under that
server registry id in `cairndex-settings.json`; removing a mapping changes only
shell configuration. File/bundle context menus and FileInspector offer native
open/reveal only while the active library has a mapping. Handoffs send the Rust
layer only the registry id plus a server-provided relative path. An offline
mapped root returns **Volume not mounted**; it never falls back to a server-side
command or an unchecked opener call.

The same mapping powers drag (D4). Drag a file card/row, an opened bundle album
tile, the File inspector, or the bundle inspector — its cover drags the whole
bundle, its file rows drag one file — out to Finder while the library is mapped;
`dragout.rs` validates each path exactly like reveal/open and starts the native
drag through the `drag` crate. Dropping files from Finder that land inside the
mapped root seeds Create Bundle (via `reverse_map_paths`); files outside are
explained ("move them into the library first"); an unmapped library is told to
locate itself. No absolute path ever crosses into the web layer.

### Menus and shortcuts (D5a)

`apps/web/src/platform/keymap.json` is the **single source of truth** for the
native menu bar. The shell embeds it with `include_str!` and builds the menu
from it (`src-tauri/src/keymap.rs`), so a label or accelerator cannot drift
between the two consumers; the SPA reads the same file through
`platform/keymap.ts` for action typing and the shortcut reference. Edit the
table, not `app_menu.rs`.

Table fields: `accelerator` is the OS-level binding (always modifier-based, so
it can never swallow a keystroke meant for a text field — a test enforces this);
`keys` lists the bare-key bindings the web app handles itself in the focused
viewer; `requires` names the enablement group (`server`, `library`, `viewer`,
`never`); `browserReserved` marks combos a browser intercepts before the page.

Those reserved combos are the point of the D5 shortcut audit: ⌘1/⌘2 (tab
switching), ⌘N (new window), ⌘[ / ⌘] (history), ⌘= / ⌘− (browser zoom), and ⌘⇧I
(devtools) are unusable on the web and work only inside the shell. The web
build's bare-key viewer bindings are unchanged.

**Give an item an accelerator only when no `keys` entry already covers it**
(owner rule, 2026-07-19). An accelerator is reserved application-wide, so
duplicating a bare viewer key spends a global combo on a command you can only
reach with the viewer open. That is why the Playback menu carries accelerators on
just Previous/Next File: with a video loaded the arrow keys mean seek, so those
two commands have no bare-key binding at all, while Play/Pause, seek ±10 s,
speed, mute, subtitles, and snapshot are already covered by Space/K, J/L, `,`/`.`,
M, C, and S. Menu items without an accelerator are perfectly normal — `Pair
Device…` has none either.

The Playback menu is routed to the open media viewer. `runViewerCommand` in
`app/viewer/player/useShortcuts.ts` is the one dispatcher shared by the key
bindings and the native menu, and `useViewerMenu` enables the menu only while a
viewer is mounted, so its items are never live against a closed viewer.

Viewer fullscreen uses **real window fullscreen** in the shell rather than the
HTML Fullscreen API, which WKWebView gates behind user activation a native menu
item cannot supply (D1 audit). Every fullscreen change — the View menu item, the
viewer's own control, the `F` key — flows through the `set_window_fullscreen`
command, which emits `cairndex://fullscreen` so no observer holds a stale state.
Escape leaves fullscreen before it closes the viewer. Window state persists
size/position/maximized but deliberately **not** fullscreen or visibility:
restoring those would relaunch into an empty fullscreen or window-less app.

Left click on the video toggles play/pause; right click is deliberately left
unhandled so it stays available for viewer context-menu actions.

Desktop checks:

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cd ..
npm run tauri build
```

CI runs these Rust checks on both macOS and Ubuntu; only macOS bundles the app.
Keep native capabilities in cross-platform Tauri plugins, with any unavoidable
target-OS conditional isolated in one clearly named host module. D2 contains no
target-OS conditional code, D3 uses only the cross-platform dialog/opener
plugins plus pure `std::path` validation, and D4's drag-out isolates its one
target-OS edge (the GTK-vs-raw window handle) inside `dragout.rs`. Keep all
Tauri imports in `apps/web/src/platform/desktop.ts`; shared SPA modules consume
only the platform surface and capability flags.

## Databases and local state

Cairndex now uses the ADR-0008 per-library model:

- the server-local registry DB lives under `CAIRNDEX_DATA_DIR` as
  `registry.db` and tracks registered libraries plus the runtime `job_queue`;
- each library is a directory with `.cairndex/manifest.json`,
  `.cairndex/library.db`, and `.cairndex/cache/`;
- content tables are created in each `library.db` via the current SQLAlchemy
  metadata bootstrap for this pre-1.0 phase;
- there is no current global content DB, no `storage_roots` content table, and no
  `asset_files.storage_root_id`.

For local manual testing, start the backend and frontend, open the app, use the
sidebar `+` to create or register a library directory, then run **Update**.
Update scans files, persists a grouping plan, collects ffprobe metadata,
refreshes the UI, opens grouping review when suggestions exist, and starts
missing/stale storyboard generation in the background. The maintenance overflow
menu exposes standalone **Scan new files**, **Suggest grouping**, **Collect
metadata**, and **Generate storyboards** actions.
In grouping review, double-click a new-bundle or collection suggestion title to
edit it; Enter or blur saves the open-plan edit, while Escape cancels it. A
re-scan addition can be switched from its recommended existing bundle to
a new bundle with the circular-arrows icon beside its title, renamed, and
switched back on the same row. Hover or focus the icon to see its exact action.

When changing persistence models, update the relevant bootstrap/tests/docs in the
same branch. Do not assume an Alembic global-content migration chain is still the
active mechanism unless a new ADR reinstates one.

## Frontend API types (generated from OpenAPI)

The frontend's request/response types are generated from the backend's OpenAPI
schema so the two cannot drift. Regenerate after backend API changes:

```bash
# 1. dump the schema from the backend (apps/server)
uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
# 2. generate TypeScript types (apps/web)
npm run gen:api          # writes src/api/schema.d.ts
```

Both `openapi.json` and `schema.d.ts` are committed (generated, excluded from
lint/format). `gen:api` uses `npx openapi-typescript` rather than a pinned
devDependency because that tool's TypeScript peer range does not yet include
TS 6.

## Large-library performance tooling

To profile browse/query performance at scale, generate a synthetic library and
benchmark it (no real media is touched). See [performance.md](performance.md)
for the recorded baselines and the indexes/query rewrite they justify.

```bash
# From apps/server — generate a synthetic library on disk (fast bulk inserts)
uv run python -m cairndex.devtools.synthetic_library \
    --library-root /tmp/cairndex-synth \
    --bundles 100000 --files-per-bundle 1-5 \
    --collections 1000 --tags 2000 --seed 1234

# Time the hot paths; --explain dumps EXPLAIN QUERY PLAN, --json writes a report
uv run python -m cairndex.devtools.benchmark_queries \
    --library-root /tmp/cairndex-synth --iterations 20 --explain
```

## Search index

Whole-library text search uses a per-library SQLite FTS5 index (`bundle_search`)
kept fresh by triggers. It is created and first-populated automatically when a
library DB is opened. To rebuild it for one library (after a bulk external change
or to recover from drift):

```bash
uv run python -m cairndex.devtools.reindex_search --library-root /path/to/library
# or by registry id:
uv run python -m cairndex.devtools.reindex_search --library-id <id>
```

## Running both together without Docker

Run the backend and frontend dev commands above in separate terminals. Browser-mode Vite
dev server proxies `/api/*` to `http://localhost:8000` (see
`apps/web/vite.config.ts`), so it needs no CORS configuration. The Tauri host
uses the server URL stored by its first-run screen instead.

## Running with Docker

```bash
docker compose up --build
```

Starts the backend on `:8000` and the frontend dev server on `:5173` with source
bind-mounted for live reload. This is a development convenience, not the NAS
production deployment shape — see `docs/deployment.md`.

## Repository conventions

- One branch per feature/fix (see `AGENTS.md` §16). Branch from `main`.
- Conventional-style commit messages (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`).
- Update `CHANGELOG.md` under `Unreleased` and `docs/STATUS.md` in the same
  branch as any user-visible or operational change.
- Record consequential decisions in `docs/adr/` (see `docs/adr/README.md`).
- Do not commit source media, databases, caches, thumbnails, or secrets —
  enforced by `.gitignore`, but review diffs before pushing regardless.

## CI

`.github/workflows/ci.yml` runs on every push/PR: backend lint + type-check +
tests, frontend lint + type-check + unit tests, macOS and Ubuntu desktop checks,
a macOS Tauri bundle, and a Docker image build validation. PRs should be green
before merge.
