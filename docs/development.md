# Development guide

## Disposable migration qualification

Run `uv run pytest tests/test_library_migration.py tests/test_replica_catalog.py`
from `apps/server`. Tests generate complete synthetic catalogs and exercise
format-three reconstruction, exact cell/relationship rollback, WAL checkpoints,
interrupted work, retries, schema refusal, conflicts and retained recovery.
The [procedure](replica-migration.md) accepts no owner path through an application
command. Generated libraries and private receipts must not enter Git.

## Portable lifecycle service checks

The [application extraction](portable-lifecycle-extraction.md) uses disposable
fixtures for Create/Open, access and recovery. Run
`uv run pytest tests/test_replica_creation.py tests/test_replica_recovery.py`
from `apps/server`. The tests cover exclusive publication, process exits,
concurrent snapshot capture, retained intent, generation activation and retry.
Run browser integration with `npm run test:e2e` from `apps/web`. The agent performs native
functional checks with disposable data. Owner assistance is needed only for
product decisions, unavailable access or devices, and approved real-data operations.

Group 6 qualification additionally runs `tests/test_portable_source_*.py` and
`tests/test_smb_*.py`, `e2e/source-operations.spec.ts`, the frozen package smoke
and the macOS native review/recovery flow. Use synthetic local roots before the
explicitly selected disposable mounted-share root. Run `authorize-smb` with the
actual executable when qualifying its Keychain access; background work cannot
request a prompt. See [the extraction record](source-operations-extraction.md).

`tests/test_portable_source_binary.py` runs the same HTTP review, identity,
recovery and restart path against source or `CAIRNDEX_RECOVERY_TEST_BINARY`.
For an explicitly selected disposable mounted-share parent, set
`CAIRNDEX_SOURCE_TEST_PARENT` and run that test plus the process-exit cases in
`test_portable_source_operations.py`. Each creates a fresh synthetic library;
private SQLite and creation intent stay in local test storage. Share fixtures
remain available for inspection. Never point this option at an owner library.
The same option applies to `e2e/source-operations.spec.ts`; browser private state
stays local, and only freshly allocated synthetic library roots use the share.

## Prerequisites

| Tool                       | Why                                            | Notes                                                                                                |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `uv`                       | Backend dependency + Python version management | Installs Python 3.12 for you even though the host may ship an older system Python.                   |
| Node.js 20+                | Frontend tooling                               | `npm` ships with Node; no separate package manager required.                                         |
| Stable Rust + Cargo        | Tauri 2 desktop host                           | Required only for `apps/desktop`; install with rustup and include `clippy` + `rustfmt`.               |
| Docker + Compose v2 plugin | Optional, for the containerized dev stack and for building the deployment image | macOS: install Docker Desktop. Linux: `docker-ce` + `docker-compose-plugin`. See [Running with Docker](#running-with-docker). |
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

`just dev` starts the server and Vite together. Ctrl-C targets the Uvicorn
reloader and waits for application shutdown to drain work and close private
stores. `just dev-smoke` creates a disposable portable library and verifies that
Ctrl-C releases its private process lock, with no SQLite in the library folder.

Checks (run from `apps/server`):

```bash
uv run ruff format --check .   # formatting
uv run ruff check .            # linting
uv run mypy src packaging      # type checking (packaging/ gates what ships)
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

### What CI runs, and when

CI runs on pushes to `main` and pull requests, with an always-present `CI result`.
`infra/ci_scope.py` compares the exact event commits and selects conservative scope:

- Documentation-only changes run the scope/result jobs; the heavy matrix is skipped.
- Backend-test and privacy-declaration changes run backend lint/types/the full test
  suite and every dependency audit. Unchanged frontend/native/container builds are skipped.
- Runtime code, dependencies, workflow changes, unknown paths, license texts and
  generated OpenAPI changes run every existing job. Manual dispatch always runs everything.

Mixed changes retain the broadest scope. Rename detection is disabled for the path
inventory so a runtime file moved into tests still triggers the full matrix.
Privacy, CodeQL and dependency review keep their independent triggers.

The backend driver uses an isolated 4 GiB tmpfs when Linux memory headroom permits.
It retains real `fsync` calls and runs the complete suite in two disjoint phases:
bulk synthetic fixtures on memory storage; source-operation and backup/restore
safety tests on ordinary disk. Limited-memory hosts use disk for both phases.
`CAIRNDEX_CI_MEMORY_PARENT` selects an existing executable memory filesystem for
local measurement; the driver creates/removes only its own temporary children.
All phases print slow-test durations. The backend has a 25-minute timeout;
the [CI review](ci-review.md) records measurements, limits and required-check rollout.

`CI result` uses `always()` and depends on every matrix job. A failed, cancelled,
missing or unexpectedly skipped selected job fails the result; documentation skips
are accepted only after a successful scope decision. Main requires this completion
result alongside privacy and the independent security checks. A privacy-only
required-check notification does not establish completion.

`desktop-macos` carries `timeout-minutes: 30` against an observed ~4.5-minute
cold-cache build, so a hung Tauri bundler cannot occupy a runner for GitHub's
six-hour default.

#### A note on runner cost

The repository is **public** (since 2026-07-23), so standard GitHub-hosted
runners — `ubuntu-latest` and `macos-latest` among them — are free and
unmetered. This matters if that ever changes: while the repo was private, macOS
billed at **10× Linux**, and `Desktop shell (macOS)` alone was 1,570 of 2,691
billable minutes over 30 days — 58% of everything. Larger runners (`-large`,
`-xlarge`) are billed even on public repositories, so reaching for one is a cost
decision rather than a capacity one.

If you ever need to measure spend, the per-run billing endpoint reports zeroes
for recent runs; job start/finish timestamps are reliable, so compute it from
`/repos/{owner}/{repo}/actions/runs/{id}/jobs` — round each job up to the minute
and apply the OS multiplier.

## Desktop (`apps/desktop`)

The Tauri 2 shell hosts the same `apps/web` Vite development server and
production `dist`; there is no desktop frontend fork. `tauri dev` loads a page
whose origin is Vite's `http://127.0.0.1:5173`, which is **not** one of the
packaged `tauri://` origins the backend trusts by default — so a cross-origin
call from the dev webview to any server is CORS-blocked unless that origin is
opted in.

- **"This Computer" (the bundled sidecar) needs nothing.** The shell detects
  `tauri::is_dev()` and spawns the sidecar with `CAIRNDEX_CORS_EXTRA_ORIGINS`
  set to the dev origin automatically (`sidecar.rs`), so the HTTP-based flows —
  adding a library, path completion — work out of the box. Set the variable in
  your own shell to override it.
- **A standalone server (e.g. `:8000`) must opt the origin in itself**, because
  the shell does not spawn it:

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

### Which server the desktop talks to (sidecar vs standalone)

`tauri dev` gives you two ways to provide the server the frontend calls, and
choosing between them is the main thing to understand — it is what decides
whether you ever run `:8000` for desktop work:

- **A standalone server you run from source** — the `:8000` uvicorn above, which
  the desktop connects to like any other server (enter `http://127.0.0.1:8000`
  on the first-run screen). It runs your **live** code under `--reload`, needs no
  rebuild, and lets the desktop and the web app share one server and one set of
  libraries. **Prefer this while iterating**, on the frontend or the server.
- **"This Computer" — the bundled sidecar**, which the shell spawns itself. This
  is the self-contained server end users get, but it is a **PyInstaller build of
  `apps/server` frozen at build time**, staged from
  `packaging/dist/development/cairndex-sidecar/` for development. Run
  `just bundled` from the repository root: it rebuilds stale server code and
  verifies that the linked FFmpeg/FFprobe still match the pinned cache.

`just bundled` uses only the host architecture (Apple Silicon on an ARM Mac).
Its media tools are symlinks into `packaging/vendor/ffmpeg/<platform>/`, and its
Tauri invocation disables bundle resources so Cargo does not copy release
sidecars into `target/debug`. The development bundle is checkout-local;
`just build-desktop` produces the self-contained release bundle separately.

Use the packaged sidecar to verify the self-contained application. Independent
servers can open the same portable library with separate private data directories.
A private binding lock prevents two processes from using the same private store.

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

The main window starts hidden and is revealed once, after React synchronously
commits the dark shell and a subsequent renderer task invokes `renderer_ready`.
A completed navigation is not a rendering guarantee: `PageLoadEvent::Finished`
only schedules a two-second fail-safe in case the renderer bridge fails. Startup
deep links and a second instance may request focus before the renderer
acknowledgment, but the same readiness gate defers their `show()` call; later
focus requests behave normally.
The reveal gate exists for content polish (the window appears with UI already
mounted), not as a flash defense: `macos-private-api` plus the window
`backgroundColor` disables WKWebView's opaque white backing surface, so the
first composited frame is dark regardless of reveal timing (ADR-0020). The
inline document background and CSS background remain matching dark fallbacks.

`tauri dev` uses React's development build, but its root deliberately omits
StrictMode replay. TanStack Query's library requests consume cancellation
signals, and WKWebView can strand the immediate replacements when replay cleanup
aborts the first startup burst; the visible result is “Loading library…” until
navigation changes the query key. The ordinary browser root remains wrapped in
StrictMode, so shared frontend components still receive the development checks.
This policy does not change production behavior, where StrictMode does not
replay effects.

An unavailable registered root is handled before either of those startup
requests. The app shows **Library unavailable**, keeps Retry disabled as
**Checking…** while the registry refresh is running, and offers **Manage
Libraries** if the root moved. It also retries the registry every five seconds
while the visible connection has no available library, then proceeds through
ownership and authorization without requiring navigation when the root returns.
No library-scoped request should appear before that transition; seeing one is a
startup-gate regression, not an expected availability probe.

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

The same mapping powers drag-out. Drag a File Browser item, a regular album
file, a file inspector or an inspector file row out to Finder. The bundle
inspector cover carries its regular files, with a 128-file bound and one
catalog revision. Native validation rechecks the mapped UUID, containment and
file existence before handing paths to the OS. Unmapped libraries offer no
native actions. File menu Open and Reveal follow the visible single selection.
Bundle handoff chooses the first ordered regular file unless an album or
inspector file is selected. It also supports files Cairndex cannot preview.

**Add Files…** and file drops open portable source-operation review. The file
picker and WebKit deliver File objects. Tauri's native drop interception stays
off to preserve internal HTML drags. Copies target the current File Browser
folder, or the library root on other surfaces. Select at most 128 regular files;
each upload is limited to 128 GiB. File-operation permission is required before
uploading. Prepare copies stages bytes and queues independent reviews. Apply
is explicit for each file. Cancel upload aborts the in-flight request. Completed
preparations remain in Saved file operations. Folder drops are refused.

The frontend sends Files directly through its authenticated fetch transport.
Do not convert a whole incoming video to an ArrayBuffer or reconnect the
retired native direct-import bridge. In-place linking uses reviewed Update and
the separate manual-bundling workflow. Test native OS delivery separately from
synthetic HTML events; a browser test does not qualify a Finder drop.

### Menus and shortcuts (D5a)

`apps/web/src/platform/keymap.json` is the **single source of truth** for the
native menu bar. The shell embeds it with `include_str!` and builds the menu
from it (`src-tauri/src/keymap.rs`), so a label or accelerator cannot drift
between the two consumers; the SPA reads the same file through
`platform/keymap.ts` for action typing and the shortcut reference. Edit the
table, not `app_menu.rs`.

A `predefined` entry names a Tauri built-in (`hide`, `undo`, `minimize`, …).
Adding a *new* name is the one case that also needs a line in `app_menu.rs`,
because the shell has to know which builder call it means; a test walks the table
against the list it knows, so a typo fails there rather than panicking at
startup. The App menu's `hide` / `hide-others` / `show-all` trio is where macOS's
⌘H and ⌘⌥H come from — a fully custom menu bar that omits them leaves those
combos dead, which is what the shell shipped with until 2026-08-23.

Full Screen is `predefined` for a reason worth knowing before adding a custom
one back: AppKit inserts its own *Enter Full Screen* into the View menu unless
the app already owns an item bound to `toggleFullScreen:`. A custom item calling
our own command does not count, so the menu carried two entries doing the same
thing until 2026-09-01. Recognizing ours is not the end of it — AppKit then adds
its Globe-F item anyway and *hides* ours, which is why the surviving entry showed
🌐F until `globe_shortcuts` started registering
`NSApplicationEnableGlobeShortcuts` as false before `NSApplication` exists
(ADR-0028). If Full Screen ever reads 🌐F again, that registration is the first
thing to check. A predefined entry may carry a `label` (its initial
text — macOS still swaps Enter/Exit itself) and an `accelerator`, which is
recorded for the shortcut reference and to reserve the combo; the OS, not this
table, actually binds it.

Table fields: `accelerator` is the OS-level binding (always modifier-based, so
it can never swallow a keystroke meant for a text field — a test enforces this);
`keys` lists the bare-key bindings the web app handles itself in the focused
viewer; `requires` names the enablement group (`server`, `library`, `viewer`,
`viewer-video`, `new-folder`, `never`); `browserReserved` marks combos a browser
intercepts before the page. `viewer` and `viewer-video` are separate because an image bundle
has no player: only Previous/Next File work there, so the player-only items stay
disabled rather than live-but-dead.

A group is only as good as the SPA's report of it. `new-folder` is the narrowest
one: `FileList` owns it, because that component is where "a directory a folder
can be created in" is actually known, and unmounting it (leaving the File
Browser) greys the item out. The same component handles `zoom-in`/`zoom-out`
while it is mounted — the File Browser keeps its own item-size preference and
its own range, so the shell root deliberately ignores those two in file mode.

Those reserved combos are the point of the D5 shortcut audit: ⌘1/⌘2 (tab
switching), ⌘N (new window), ⌘[ / ⌘] (history), ⌘= / ⌘− (browser zoom), and ⌘S
(save page) are unusable on the web and work only inside the shell. The web
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
item cannot supply (D1 audit). Fullscreen can also be entered or left without the
app asking — the green zoom button, Mission Control, a window manager — so state
is not tracked from the commands the app issues. Instead the shell watches
`WindowEvent::Resized` (which fires across every fullscreen transition), reads the
window's *actual* state, and broadcasts `cairndex://fullscreen` when it changed.
Broadcasting the observed rather than the assumed state also means a read taken
mid-animation self-corrects. The de-duplication keeps an ordinary live-resize drag
silent. Escape leaves fullscreen before it closes the viewer, including on image
bundles, which have no player. Window state persists
size/position/maximized but deliberately **not** fullscreen or visibility:
restoring those would relaunch into an empty fullscreen or window-less app.

Left click on the video toggles play/pause; right click is deliberately left
unhandled so it stays available for viewer context-menu actions.

### Deep links, notifications, and the export seam (D5b)

`cairndex://bundle/<id>` and `cairndex://collection/<id>` open that target, with
an optional `?library=<id>`; without it the target opens in the active library.
The scheme is declared in `tauri.conf.json` under `plugins.deep-link`, which puts
`CFBundleURLSchemes` into the built bundle — a link therefore only resolves from a
**packaged, LaunchServices-registered** app, never from `tauri dev`.

Cold start is the case to keep in mind when changing this. macOS delivers the URL
as an Apple Event that can fire *before* the webview exists, so `deeplink.rs`
parks whatever arrives and the SPA drains it through `take_pending_deep_link`
once it is listening. Windows and Linux instead pass the URL in argv — to the
first process on a cold start, and to a second process on a warm one, whose argv
the single-instance plugin forwards (which is why single-instance is registered
*before* the deep-link plugin). Both paths can describe one user action, so
`useDeepLink` de-duplicates by identity. A link naming a library this server does
not have is reported rather than opened in whatever library is active.

Job notifications ride on the job snapshots the sidebar progress bar already
polls — no extra polling. The unit is a **run**, not a job, because `Update
library` chains scan → probe → storyboards and would otherwise notify three times
for one action; a run ends only after activity has been absent for
`RUN_SETTLE_MS`. A notification fires only when the run was longer than
`LONG_RUN_MS` *and* the window is unfocused, since announcing a job to someone
watching its progress bar is noise. The dock badge means "finished while you were
away", so focus clears it. Permission is requested when a run starts, not at
launch, so the system prompt appears while the user is present.

`save_export_file` is the **M11 seam only** — no export UI exists yet. The web
layer passes bytes plus a suggested file *name*; the destination comes solely
from the native save dialog, and any path structure in the suggestion is stripped
before use, mirroring the D3 rule that no client-supplied absolute path is ever
trusted. It suits the small artifacts plan 1 §10 generates (a capped GIF, one
contact sheet), not streaming media.

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

## Local-server sidecar (`apps/server/packaging`)

The desktop app bundles the Python server so a local library folder opens with
no server administration (plan 3 D6, ADR-0018 §5). It is packaged with
PyInstaller one-dir (ADR-0019 §2).

For local macOS builds, opt into a persistent sidecar signing identity once:

```bash
cd apps/server
uv run python packaging/macos_signing.py create-local
```

The setup creates a non-exportable signing key in the user's default Keychain,
grants only `codesign` access to that new key, and stores its public certificate
fingerprint and Keychain location outside the checkout. It changes neither system
trust nor existing password access rules. Repeating setup reuses the same identity;
a missing key or invalid configuration stops the build instead of rotating it.
Both development and self-contained builds use `dev.cairndex.sidecar` with that
certificate. The first explicit SMB operation may require **Always Allow** for the
new signer; grants can then survive rebuilt code. Merely choosing **Allow** grants
one access, and a locked Keychain or changed certificate can still require action.

`just bundled` detects stale signing even when source timestamps are unchanged,
and the desktop bundle preflight refuses an incorrectly signed backend. The
configuration is `~/Library/Application Support/Cairndex/build-signing.json`;
`CAIRNDEX_SIDECAR_SIGNING_CONFIG` selects another explicit configuration. Neither
configuration nor signing keys belong in the repository or build artifacts.
CI ignores the workstation default. `APPLE_SIGNING_IDENTITY` takes precedence;
`-` explicitly selects the existing ad-hoc path. A real Apple signing identity
also signs PyInstaller's native libraries before the final stable backend identifier
is applied; notarization still requires its separate release qualification.

Run `uv run python packaging/keychain_signing_smoke.py` on macOS to verify changed
binaries sharing one certificate, refusal of other certificates/identifiers and
ad-hoc copies, and cleanup. It uses only a disposable Keychain and synthetic data;
all credential reads disable user interaction. This gate also runs in macOS CI.
Its disposable Keychain is explicitly unlocked and its private signing keys get
the Apple signing partitions required by headless runners. This test setup uses
the temporary password over stdin and never applies a partition change to a
workstation Keychain or saved-login item.
The test also temporarily adds that Keychain to the certificate search list and
restores the original list on success or failure. Signing failures report a fixed
diagnostic category and exit code while withholding raw tool output.

The sidecar also carries `smbprotocol` for ADR-0034 and ADR-0037's macOS mounted-SMB
publication path. Its static import must remain visible to PyInstaller, and the
packaged smoke gate must retain `cryptography`'s runtime hook. Source-level SMB
tests do not prove that the frozen binary contains this dependency chain or can
access the saved login. Portable background work never requests a Keychain prompt.
A packaged saved-login refusal must be resolved for that application before its
mounted-SMB workflow can be qualified.

Authorize the built sidecar explicitly with
`packaging/dist/cairndex-sidecar/cairndex-sidecar authorize-smb <mounted-directory>`.
The command selects the exact mounted server, account and share's saved login.
The Keychain path is the share name, without an added leading slash. Without a
share login, the command accepts a server login that has no path, never another
share's login. The command
permits a bounded Keychain prompt and verifies signed, encrypted SMB3. It starts
no HTTP server and writes no library files. Complete the secure Keychain approval when required. Authorization failure output includes only a numeric Security status or a timeout
message; it excludes private paths and credential values. Background publication
never prompts. A diagnostic executable's grant does not qualify access for the
actual packaged sidecar.


```bash
cd apps/server
uv run python packaging/fetch_ffmpeg.py       # pinned static binaries (see below)
uv run python packaging/build_sidecar.py      # -> packaging/dist/cairndex-sidecar/
uv run python packaging/smoke_test.py         # runs the bundle and drives it over HTTP
```

For a frozen development server, `build_sidecar.py --development` writes to
`packaging/dist/development/cairndex-sidecar/` and links the verified media tools
from the cache. The default build writes regular copies to
`packaging/dist/cairndex-sidecar/` for distribution. Never distribute the
checkout-local development directory. Old Cargo build output is regenerable;
changing development mode does not automatically delete existing outputs.


`packaging/ffmpeg-manifest.json` pins both macOS architectures (ADR-0019 §3).
**On Linux, build with `--skip-ffmpeg`** — that platform is deliberately
unpinned, because the build server covering both macOS arches ships a Linux
variant with `--enable-decklink`, which forces `--enable-nonfree` and cannot be
redistributed. The sidecar then falls back to a system ffmpeg through
`media/tool_paths.py`, which is fine on a developer machine and not fine on a
user's.

Both scripts are checksum-gated, and the gate is deliberately strict:
`fetch_ffmpeg.py` verifies a download **before** unpacking it, then verifies the
extracted binary; `build_sidecar.py` re-verifies against the pin for the target
platform and **refuses to bundle an unpinned binary** rather than warning. Use
`--platform` on either script to work with an architecture other than the host's.

Re-pinning is a supply-chain decision, not a version bump. Verify five things
about a candidate build, none of which can be taken from its label:

- **static** — `otool -L` shows only `/usr/lib` and `/System/Library` entries. A
  Homebrew ffmpeg fails here: it is a thin binary over its own dylib prefix, so
  a copy runs on the build machine and nowhere else.
- **redistributable** — `--enable-gpl` is fine, `--enable-nonfree` is fatal. A
  nonfree build may not be distributed at all, which disqualified the otherwise
  excellent `eugeneware/ffmpeg-static`.
- **libx264** — `media/hls.py` needs it for the transcode ladder; only the remux
  path is `-c:v copy`, so an LGPL build silently loses transcoding.
- **signature** — staging copies bytes and sets the execute bit, neither of
  which invalidates a Mach-O signature. Anything that *rewrites* a binary after
  signing must re-sign it; an invalid signature fails harder than none
  (ADR-0019 §4).
- **no GPL-incompatible components** — every other statically linked library
  must be GPL-compatible too, and one is conditionally so: `--enable-openssl`
  is only redistributable alongside GPL code when OpenSSL is **3.0 or later**
  (Apache-2.0, compatible with GPLv3 — one reason `--enable-version3` matters);
  an OpenSSL 1.x build with the same configure line may not be distributed.
  The pinned builds link OpenSSL 3.6.1 — check the candidate's `versions.txt`.

`tests/test_ffmpeg_manifest.py` covers the ways the gate can fail open, and
`packaging/` is inside the mypy scope (`uv run mypy src packaging`) because this
code decides what goes into a published binary.

The smoke test **refuses to run against a half-staged or non-executable bundled
ffmpeg**, rather than letting the sidecar fall back. `media/tool_paths.py`
deliberately falls back to PATH discovery when a configured binary is not
executable — right for the app, wrong for the one run that is supposed to prove
the bundled binary works, since on any developer Mac with Homebrew ffmpeg the
fallback would pass while proving the opposite.

The GPL source offer in `THIRD-PARTY-NOTICES.md` runs three years, so each
build's configure line and component versions are **committed** under
`packaging/ffmpeg-build-info/` rather than linked upstream. Re-pinning means
committing the new `versions.txt` for both architectures alongside the digests.

The desktop resource map also embeds `LICENSE`, `THIRD-PARTY-NOTICES.md`, and
the complete GPLv3/LGPLv3 texts from `licenses/`. After any packaging or license
change, verify the built app directly:

```bash
./infra/verify_macos_distribution.sh \
  apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app
```

The same script accepts a DMG, mounts it read-only, and verifies the app inside.
macOS CI checks the app bundle; the release workflow checks both the app and the
DMG before drafting a release.

**Run the smoke test after any dependency change.** The unit suite imports from
source, where every module is present, so it structurally cannot catch a frozen
bundle missing a dynamically resolved import — that only surfaces when the code
path first runs. The smoke test drives the real binary through the paths where
that actually happens: SQLAlchemy's sqlite dialect, the job worker, Pillow
thumbnails, a HEIC preview (`media/previews.py` imports `pi_heif` inside a
function), and SIGTERM releasing the private binding lock. CI runs it on every push.

`hiddenimports` in `cairndex-sidecar.spec` is **empty, and that was measured**.
An initial version listed uvicorn, SQLAlchemy, Pillow and `cairndex` entries;
removing each in turn and re-running the smoke test showed all were redundant
(PyInstaller ships `hook-PIL.py` and `hook-sqlalchemy.py`). Do not add entries
speculatively — they make a future genuine gap look already handled. If the
smoke test ever fails on a missing module, add the entry and name the failure it
fixes in a comment.

**The desktop crate does not compile without this path.** `tauri.conf.json`
stages `packaging/dist/cairndex-sidecar` as a bundle resource, and `tauri-build`
copies resources at **compile** time — so a missing non-glob path fails
`cargo check`, `cargo test`, and `tauri dev`, not just `tauri build`:

```text
error: failed to run custom build command for `cairndex-desktop`
  resource path `../../server/packaging/dist/cairndex-sidecar` doesn't exist
```

Either build the bundle (`packaging/build_sidecar.py`) or, if you only need the
Rust to compile, create the directory empty — the resource copier skips empty
directories, and `binary_path()` then correctly reports `not_bundled` at runtime:

```bash
mkdir -p apps/server/packaging/dist/cairndex-sidecar
```

CI does the first in the macOS job and the second in the Ubuntu Rust job, which
runs no Python.

An **empty, stale, or wrong-version sidecar is caught at bundling**, not at compile:
`beforeBuildCommand` runs `check-sidecar-staged.mjs`, which fails `tauri build`
when the staged directory has no executable, its packaged server version does
not match root `VERSION`, or the binary predates the server source. Without it
the build can ship no local server at all — the resource copier skips an empty
directory silently — or embed stale server code behind the current app version.

**Sidecar contract with the shell** (`apps/desktop/src-tauri/src/sidecar.rs`):

- The sidecar binds an ephemeral loopback port *itself* and prints
  `CAIRNDEX_SIDECAR_PORT=<port>` on stdout; the shell parses that line. Binding
  first and announcing second means the announced port is always live — having
  the shell pick a free port and pass it down leaves a window for something else
  to take it.
- The shell generates a fresh 256-bit token per start and passes it in the
  **environment**, not argv, since a command line is visible in any process
  listing. The sidecar refuses to start without it rather than serving an
  unauthenticated API on a port any local process can reach.
- **Shutdown is closing the sidecar's stdin, not a signal.** The sidecar runs
  with `--watch-parent` and stops when that pipe reaches EOF. Two reasons: it
  needs no target-OS branches (Windows has no SIGTERM, and plan 3 §2.1 exists to
  avoid such branches), and it still works when the shell never gets to ask. A
  signal requires a shell alive enough to send it; a crash or `kill -9` sends
  nothing and could orphan a process holding a private binding lock. The kernel
  closes the pipe when the shell dies. Verify parent-loss shutdown against the
  actual packaged executable; it must close private stores and leave no orphan.
- The sidecar gets its own `CAIRNDEX_DATA_DIR` under the app's data directory
  (`local-server/`), kept out of the shell's own store — its registry is
  invisible plumbing (ADR-0018 §5).

The Rust lifecycle test spawns the real bundle, but only when
`CAIRNDEX_SIDECAR_BIN` points at one; otherwise it skips, so the desktop gates
stay runnable without Python. **Set it when running the desktop tests locally**,
or the test passes without proving anything:

```bash
cd apps/desktop/src-tauri
CAIRNDEX_SIDECAR_BIN=$PWD/../../server/packaging/dist/cairndex-sidecar/cairndex-sidecar \
  cargo test --locked
```

## Databases and local state

The private registry is `CAIRNDEX_DATA_DIR/registry.db`. Portable library folders
hold descriptors and immutable history. Working databases, drafts, jobs and
caches live below private `replicas`; access settings live under `library-access`.
The content schema is reused by catalog projection and synthetic model tests.
Model-fixture tests do not qualify public old-format admission. Use real portable
API fixtures for admission, authorization, isolation and serving lifecycle checks.

SQL-backed JSON dependencies use `Depends(..., scope="function")` so commit and
rollback finish before response headers. Keep yielding parent dependencies in
that scope too. Streaming handlers retain explicit session factories for short
resolution scopes. FastAPI 0.121 is the minimum version for function scopes;
the resolved package version is unchanged by this requirement correction.

SQLite writers share `persistence/sqlite_durability.py`. macOS connections use
FULL synchronous and both fullfsync flags, including writable attached schemas.
Use `connect_writable` for raw file writers and backup destinations; read-only
URI connections and in-memory schema validators can use `sqlite3.connect`.
Linux's existing synchronous settings remain unchanged. See
[ADR-0039](adr/0039-macos-sqlite-durability.md) for the storage limits.

From `apps/server`, `uv run python -m cairndex.devtools.benchmark_sqlite_durability`
compares the previous and current policies on fresh synthetic temp databases.
For an already mounted test share, pass `--storage smb --parent <scratch-directory>`.
It removes its own temporary directory and reports no paths. SMB uses rollback
journaling; WAL checkpoints are measured only on local storage. Results are
storage transaction timings, excluding API, catalog and media processing work.

### Adding a library

The Libraries dialog (sidebar `+`) has one **Add library** action. The client
sends the typed path to `GET /api/v1/libraries/probe-path`, and the answer picks
the action:

| Probe result                 | What happens                                            |
| ---------------------------- | ------------------------------------------------------- |
| `already_registered_id` set  | that library is selected; nothing is created             |
| `is_library`                 | `POST /libraries/register`, keeping the manifest's name  |
| neither                      | a confirmation prefilled with `folder_name`, then `POST /libraries/create` (with `create_if_missing` when `exists` is false) |

A present-but-broken `.cairndex/manifest.json` makes the probe fail rather than
report "not a library" — otherwise the confirmation would offer to build a
second library over a damaged one.

`GET /libraries/path-suggestions` drives the autocomplete and marks directories
that already carry a package. Both endpoints are owner-setup surface, at the
same trust level as each other: they read absolute server paths the owner typed
and are unrelated to File Browser path safety, which stays library-relative.

**Removal is metadata-only.** `DELETE /api/v1/libraries/{id}` drops the registry
row after draining and closing the private store.
It never deletes a folder, a `.cairndex/` package, or a media file — re-adding
the folder restores the library, because nothing authoritative lives in the
registry (ADR-0018 §1). Any change here must preserve that.

On desktop, **File → Manage Libraries…** (⌘O) opens this same dialog, and its
**Browse…** button reaches the same three outcomes through the native picker.
First-run setup is the one exception: there is no server there, so the dialog
has no library list to show and the menu item picks a folder directly —
`DesktopBootstrap` handles that case and asks for a name in a dialog of its own.

The picked absolute path never crosses into
the web layer (see the comment above `PickedFolder` in `mappings.rs`): for a
folder that is not a library yet, the shell parks the path in a single
pending-pick slot and returns `{ needs_confirmation, token, folder_name }`;
`confirm_picked_library(token, name)` redeems it and creates the library through
the sidecar. A token superseded by a later pick is refused and leaves the newer
pick intact. Cancelling is simply never calling confirm. An old-format library
is never registered (ADR-0035): the shell starts its read-only conversion
inspection on the sidecar and returns `{ needs_conversion, conversion_task }`.
The web layer switches to the local connection if needed, and the Libraries
dialog opens on that task's review (ADR-0038). The macOS picker's own
New Folder button covers creating a folder, so the shell adds no folder-creation
UI. In the browser there is no picker at all: no browser can produce an absolute
path on the server.

### Manual testing loop

For local manual testing, start the backend and frontend, open the app, use the
sidebar `+` to add a library directory, then run **Update**.
Update scans files, persists a grouping plan, refreshes the UI, and opens
grouping review when suggestions exist. It then collects ffprobe metadata in the
background and starts missing/stale storyboard generation only after that probe
succeeds. The maintenance overflow menu exposes standalone **Scan new files**,
**Suggest grouping**, **Collect metadata**, and **Generate storyboards** actions.
In grouping review, double-click a new-bundle or collection suggestion title to
edit it; Enter or blur saves the open-plan edit, while Escape cancels it. A
re-scan addition can be switched from its recommended existing bundle to
a new bundle with the circular-arrows icon beside its title, renamed, and
switched back on the same row. Hover or focus the icon to see its exact action.
Use Narrow or Widen beside a represented filesystem directory to regenerate the
plan with stricter or broader filename-stem matching. This supersedes the open
plan like any other regeneration, so finish drag, rename, and selection review
after choosing stem sensitivity.

When changing persistence models, update the relevant bootstrap/tests/docs in the
same branch. Do not assume an Alembic global-content migration chain is still the
active mechanism unless a new ADR reinstates one. Removing a library must stay
metadata-only; physical deletion is a separate capability that does not exist.

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

The native loop above is the primary one. The containerized stack is the
alternative for when you want the deployment's environment rather than your
Mac's — checking Linux behavior, reproducing something a NAS does, or working
without a local `uv`/Node toolchain. Both halves hot-reload, so iterating in it
is not meaningfully slower once the images are built.

```bash
cp .env.example .env          # then set CAIRNDEX_DEV_LIBRARY_PATH
just docker-dev-library       # optional: seed a scratch library
just docker-dev               # == docker compose up --build
```

Backend on `:8000`, Vite on `:5173` (both configurable — see below). Source is
bind-mounted: editing `apps/server/src` restarts uvicorn, editing `apps/web/src`
hot-updates the browser.

### What the stack gives you that a bare `docker compose up` did not

- **ffmpeg and ffprobe are installed.** Without them the server starts and then
  fails at the first scan, since probing, thumbnails, storyboards, subtitle
  conversion, and HLS all shell out to them.
- **A library is mounted.** `CAIRNDEX_DEV_LIBRARY_PATH` is bind-mounted at
  `/libraries/main`; without a mount there is nothing to point the app at.
- **Registry state survives a rebuild**, in the `cairndex-dev-data` volume.
- **Reload is scoped to `src`.** A bare `--reload` watches the whole
  bind-mount, which on a developer machine includes `.venv` (tens of thousands
  of files, plus a second one for x86_64 sidecar builds) and `var/`.

### Two collisions to know about

**The dev container has its own private data**, deliberately separate from the
`apps/server/var` that native `just dev` uses. Sharing it would contend for the
same private registry and binding locks. Independent serving instances use
independent private storage; format three has no shared ownership lease.

**Use a scratch library for development.** Point `CAIRNDEX_DEV_LIBRARY_PATH`
at synthetic media rather than a library another app is actively using. Separate
private stores do not serialize two servers' physical source operations.
`just docker-dev-library` seeds one at `var/docker-library`:
fourteen generated files — 2-second clips, JPEG covers, and subtitles, arranged
into a multi-part film, an episodic set, and some loose images — so multi-file
bundling, grouping, covers, and playback all have something real to work on. It
uses ffmpeg from a container, so no local ffmpeg is needed. Under a megabyte
total.

This is deliberately not `devtools.synthetic_library`, which writes rows for
files that do not exist. That is right for benchmarking query plans at 100k
bundles (see [Large-library performance tooling](#large-library-performance-tooling))
and wrong here: every file would show as missing and no thumbnail or playback
path would ever run.

To run the container stack *alongside* native `just dev` rather than instead of
it, set `CAIRNDEX_DEV_API_PORT` / `CAIRNDEX_DEV_WEB_PORT` to free ports.

### Stopping it

```bash
just docker-dev-down                 # keeps the registry volume
just docker-dev-down --volumes       # and discards it
```

A clean shutdown drains admitted work and closes private stores and process
locks. A forced exit can leave retained operations interrupted for explicit
review and retry. It does not establish power-loss safety.

### Changing dependencies

A `uv.lock` or `package.json` change needs a rebuild, and the frontend needs
more than that: `node_modules` lives in an anonymous volume that is populated at
image build time, and a plain `up --build` reuses the existing one.

```bash
docker compose up --build --force-recreate
```

### Testing the production image locally

`just docker-prod` runs the same single-container image the NAS runs — no source
mount, no reload, SPA served by the backend. `just docker-smoke` starts it
against a throwaway library, creates a portable library through the API, admits
a generated video through a reviewed Update, and checks media ranges, HLS, a
database-free `.cairndex/` package, and the same catalog after a clean restart
and a forced exit; CI runs the same script. With no image argument the smoke
script always builds a fresh,
commit-specific image and removes it afterward. Pass an image tag only when you
deliberately want to test an already-built candidate:

```bash
./infra/docker/smoke.sh                 # fresh build, smoke, cleanup
./infra/docker/smoke.sh cairndex:local  # smoke this exact local image
```

`infra/docker/build-and-check.sh` is the CI build gate. It places synthetic
private-data canaries in runtime database, environment, virtualenv, cache, test,
dependency, and sidecar packaging paths; builds both development images and the
production image; verifies the canaries are absent from every image; rejects
residual Python caches independently of canary names; verifies the production
license payload; and rejects a build context larger than 50 MiB by default.
Override the ceiling only for a reviewed, intentional context growth with
`CAIRNDEX_DOCKER_CONTEXT_LIMIT_BYTES`.

The Docker job also runs the recovery acceptance path:

```bash
./infra/docker/backup-restore-smoke.sh cairndex:candidate
./infra/docker/backup-restore-smoke.sh cairndex:candidate ghcr.io/example/previous:tag
```

The first form creates synthetic state, takes a hot registry backup and a
private snapshot, removes the registry, damages the private store, and recovers
both with one candidate. The second creates the state with the older source
image, then recovers it with the candidate; use it before release when a
previous image that creates portable libraries exists.

See [deployment.md](deployment.md) for the deployment itself, including building
an amd64 image for the NAS from an Apple Silicon Mac.

## Repository conventions

- One branch per feature/fix (see `AGENTS.md` §16). Branch from `main`.
- Conventional-style commit messages (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`).
- Update `CHANGELOG.md` under `Unreleased` and `docs/STATUS.md` in the same
  branch as any user-visible or operational change.
- Record consequential decisions in `docs/adr/` (see `docs/adr/README.md`).
- Do not commit source media, databases, caches, thumbnails, or secrets —
  `.gitignore` is only a convenience and is not a publication boundary.
- Install the repository's staged-content, commit-message, and pre-push privacy
  hooks once per clone with `just install-privacy-hooks`. Add known owner data to
  Git's untracked `cairndex-private-patterns` file; the scanner never prints a
  matched literal. The scanner needs a Git whose `rev-list --objects -z` output
  is NUL-delimited: Git 2.54 has it, the Git 2.43 package in Ubuntu 24.04 does
  not, and on such a Git the scanner stops instead of passing (use the
  `git-core` PPA there).
- Keep the root `VERSION`, Python, npm, Cargo, lockfile, and Tauri versions in
  sync. `python3 infra/release_version.py` checks every source; passing
  `--tag vX.Y.Z` also checks the release tag.

`/api/v1/health`, OpenAPI, and **Settings → About** read the application version
from installed Python package metadata. Packaged sidecars explicitly carry that
metadata. Release workflows also supply the public commit as
`CAIRNDEX_BUILD_COMMIT`; for an equivalent local diagnostic build, set that
variable to `git rev-parse HEAD` while running the Tauri build. The health
schema rejects anything that is not a 7-64 character hexadecimal SHA because
the endpoint is unauthenticated.

Before pushing ordinary branch work, run `just privacy-range origin/main HEAD`.
For a recreated repository, rewritten history, changed remote, first tag, or
first push of a ref, run `just privacy-history HEAD` instead. Before creating or
editing a PR, put the exact proposed title and body in files and run:

```bash
just privacy-pr origin/main /tmp/pr-title.txt /tmp/pr-body.md HEAD
```

The range scanner reads newly reachable Git objects, including blobs introduced
and deleted by an intermediate commit. It scans commit metadata, paths, text,
credential shapes, configured private literals, and binary bytes. Standard Git
author/committer email headers are intentional public identity metadata; email
addresses in messages, paths, PR text, tracked files, and artifacts remain
content findings. The reviewed binary allowlist records an immutable SHA-256,
expected path, purpose, and provenance; a new or moved binary fails until it
receives deliberate review. Do not use `--no-verify` or weaken the profile to
make a finding disappear.

## CI

The full scope of `.github/workflows/ci.yml` runs dependency audits; backend
lint, type-check, and tests; frontend lint, type-check, unit tests, and browser
e2e; macOS and Ubuntu desktop checks; a macOS Tauri bundle; and Docker
context/privacy/build/smoke/recovery validation. PRs should be green before
merge. The audit job checks both npm lockfiles at high severity, the complete
Python lock, and the Rust lock.

The Rust audit carries one narrow exception: `RUSTSEC-2024-0429` applies to
`glib::VariantStrIter` in `glib` 0.18.5. Cairndex does not call that API, the
crate enters only through Tauri/wry's Linux GTK 0.18 dependency graph, and it is
not part of the Apple Silicon release artifact. The first patched glib line is
0.20, which GTK 0.18 cannot accept. Keep the exception until Tauri's Linux GTK
line moves, then remove it rather than broadening it; every other Rust advisory
still fails CI.

`.github/workflows/privacy.yml` runs independently for every push to `main` and
for PR open, synchronization, reopen, edit, and ready-for-review events. Its
`pull_request_target` path executes the base branch's trusted workflow and
scanner, fetches but never checks out PR objects, grants no contents write, and
posts `publication-privacy/trusted` to the exact PR head. Changing the scanner
in a PR therefore cannot make that PR pass. Require that context in the `main`
ruleset after the workflow first reaches `main`. GitHub has no access to the
owner's local literal profile, so a green remote check complements rather than
replaces the pre-publication local gate. A PR that deliberately changes the
binary/root allowlist must land before a separate PR uses the new allowance.
Keep that prerequisite PR limited to the reviewed declaration and documentation;
include the binary itself only in the consuming PR.
The inventory test verifies assets already present; an absent asset may have a
declaration waiting for the consuming PR. Its digest and path remain mandatory
when its bytes are staged or become reachable.

CodeQL analyzes Python and JavaScript/TypeScript on pushes, pull requests, and a
weekly schedule. Dependency review rejects a pull request that introduces a
known high-or-critical vulnerability. Dependabot checks GitHub Actions, Python,
npm, Cargo, and Docker dependencies weekly; grouped minor/patch updates keep its
pull-request volume bounded. Vulnerability reports belong in GitHub's private
reporting flow described by [`SECURITY.md`](../SECURITY.md), never in a public
issue containing real owner data.

The "CodeQL" check on a pull request fails when the PR has a new alert of high
or critical security severity. The CI-review rollout requires it and both analysis
jobs to required checks alongside `CI result`, dependency review and trusted
privacy; see [the rollout record](ci-review.md). An alert is new when
main has no alert with the same fingerprint. The fingerprint comes from the text
of the flagged line, so a PR that edits a line with an open or dismissed alert
makes that alert new again. Test code is not analyzed
(`.github/codeql/codeql-config.yml`). For each new alert, read its data flow from
the source to the sink. When a request value reaches a file path, a command or
SQL, take the value from the database or from a server constant, or pass it as a
bound parameter: such a fix stays fixed when the line changes later. Dismiss an
alert only when the behavior is intended, for example the absolute folder that
the owner gives to Create/Open, and write the reason and the code that limits the
value in the dismissal.

Every third-party workflow action outside GitHub's own `actions/*` and
`github/*` namespaces is pinned to an immutable commit SHA. Keep the human
version comment beside each pin, and let Dependabot propose reviewed updates;
do not replace a pin with a moving major, tag, or branch.

## Distribution and deployment qualification

Run the launcher test with `npm --prefix apps/desktop test`. Verify both isolated
development links and regular distribution media-tool copies against their pins.
Configured signing errors stop a build or launch rather than falling back.
Run `packaging/keychain_signing_smoke.py` in a disposable macOS guest; its synthetic
credential reads disable interaction, prove continuity across changed binaries,
reject other signers and restore the Keychain search list. Verify the configured
identity again on the actual sidecar embedded in a production app.

For isolated Linux deployment, run build-and-check, production media smoke and
backup-restore smoke against one explicit candidate image. Preserve their image
canary/license, thumbnail/range/HLS, protected-access, damaged-original retention,
private-volume and clean/forced restart assertions. `infra/docker/portable_smoke.py`
adds the joined catalog/conflict/source/recovery workflow and verifies received
drafts, saved source receipts and bytes after both restart modes. Use a fresh
disposable root, separate private data/snapshot directories, a unique container
and a loopback endpoint. No production NAS or release publication is implied.

## Legacy conversion checks

Owner conversion uses `replicas.catalog.legacy_input`, `legacy_conversion` and
`replicas.conversion_tasks`. The global `/api/v1/libraries/conversions/tasks`
API accepts bounded intent and returns an operation ID. Its worker performs
inspection, preparation and metadata swaps. Conversion requests bypass the
browser metadata edit queue and follow connection scope only.

Focused checks use synthetic metadata and media:

```bash
cd apps/server
uv run pytest tests/test_legacy_conversion.py tests/test_legacy_conversion_safety.py tests/test_legacy_conversion_api.py
cd ../web
npm run test:e2e -- e2e/legacy-conversion.spec.ts
```

The API tests drive the worker explicitly. The browser test uses an isolated
real backend with its worker enabled. It drops an accepted activation reply,
reopens the same task, saves a converted edit and verifies its retention after
Undo. Historical-release and mounted-storage qualification remain separate from
current-schema fixture coverage. Record actual results in `docs/STATUS.md`.
