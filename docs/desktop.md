# Desktop shell and local server

This reference is for changing `apps/desktop` or the bundled local server. To set up
and run the desktop app, see [development.md](development.md#desktop-appsdesktop).
[architecture.md](architecture.md) covers the shell's place in the system: the
platform boundary, pairing, local path mappings, drag-out and file drops.
[deployment.md](deployment.md#desktop-app-distribution-macos) covers distribution
and releases.

## Startup

The first-run screen stores a verified server URL in the Tauri store. Bootstrap
also requires the health response to advertise the pairing and progress
capabilities used by the shell, so an unrelated HTTP 200 service remains on the
editable setup screen. Packaged custom-protocol origins are allowed by default;
arbitrary HTTP(S) origins are denied unless listed exactly in the comma-separated
`CAIRNDEX_CORS_EXTRA_ORIGINS`. On macOS, the package declares local-network use and
permits cleartext HTTP only in its WKWebView content so an explicitly configured
private LAN server works; prefer HTTPS for any server outside a trusted private
network.

The main window starts hidden and is revealed once, after React synchronously
commits the dark shell and a subsequent renderer task invokes `renderer_ready`.
A completed navigation is not a rendering guarantee: `PageLoadEvent::Finished`
only schedules a two-second fail-safe in case the renderer bridge fails. Startup
deep links and a second instance may request focus before the renderer
acknowledgment, but the same readiness gate defers their `show()` call; later
focus requests behave normally. The reveal gate exists for content polish (the
window appears with UI already mounted), not as a flash defense:
`macos-private-api` plus the window `backgroundColor` disables WKWebView's opaque
white backing surface, so the first composited frame is dark regardless of reveal
timing (ADR-0020). The inline document background and CSS background remain
matching dark fallbacks.

An unavailable registered root is handled before any library-scoped startup
request (see [architecture.md](architecture.md)). No library-scoped request should
appear before the library becomes available; seeing one is a startup-gate
regression, not an expected availability probe.

## Adding a library

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
row after draining and closing the private store. It never deletes a folder, a
`.cairndex/` package, or a media file — re-adding the folder restores the library,
because nothing authoritative lives in the registry (ADR-0018 §1). Any change here
must preserve that.

On desktop, **File → Manage Libraries…** (⌘O) opens this same dialog, and its
**Browse…** button reaches the same three outcomes through the native picker.
First-run setup is the one exception: there is no server there, so the dialog
has no library list to show and the menu item picks a folder directly —
`DesktopBootstrap` handles that case and asks for a name in a dialog of its own.

The picked absolute path never crosses into the web layer (see the comment above
`PickedFolder` in `mappings.rs`): for a folder that is not a library yet, the
shell parks the path in a single pending-pick slot and returns
`{ needs_confirmation, token, folder_name }`; `confirm_picked_library(token, name)`
redeems it and creates the library through the sidecar. A token superseded by a
later pick is refused and leaves the newer pick intact. Cancelling is simply never
calling confirm. An old-format library is never registered (ADR-0035): the shell
starts its read-only conversion inspection on the sidecar and returns
`{ needs_conversion, conversion_task }`. The web layer switches to the local
connection if needed, and the Libraries dialog opens on that task's review
(ADR-0038). The macOS picker's own New Folder button covers creating a folder, so
the shell adds no folder-creation UI. In the browser there is no picker at all: no
browser can produce an absolute path on the server.

## Menus and shortcuts

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
combos dead.

Full Screen is `predefined` for a reason worth knowing before adding a custom
one back: AppKit inserts its own *Enter Full Screen* into the View menu unless
the app already owns an item bound to `toggleFullScreen:`. A custom item calling
our own command does not count. Recognizing ours is not the end of it — AppKit
then adds its Globe-F item anyway and *hides* ours, which is why `globe_shortcuts`
registers `NSApplicationEnableGlobeShortcuts` as false before `NSApplication`
exists (ADR-0028). If Full Screen ever reads 🌐F again, that registration is the
first thing to check. A predefined entry may carry a `label` (its initial text —
macOS still swaps Enter/Exit itself) and an `accelerator`, which is recorded for
the shortcut reference and to reserve the combo; the OS, not this table, actually
binds it.

Table fields: `accelerator` is the OS-level binding (always modifier-based, so
it can never swallow a keystroke meant for a text field — a test enforces this);
`keys` lists the bare-key bindings the web app handles itself in the focused
viewer; `requires` names the enablement group (`server`, `library`, `viewer`,
`viewer-video`, `new-folder`, `never`); `browserReserved` marks combos a browser
intercepts before the page. `viewer` and `viewer-video` are separate because an
image bundle has no player: only Previous/Next File work there, so the player-only
items stay disabled rather than live-but-dead.

A group is only as good as the SPA's report of it. `new-folder` is the narrowest
one: `FileList` owns it, because that component is where "a directory a folder
can be created in" is actually known, and unmounting it (leaving the File
Browser) greys the item out. The same component handles `zoom-in`/`zoom-out`
while it is mounted — the File Browser keeps its own item-size preference and
its own range, so the shell root deliberately ignores those two in file mode.

Reserved combos — ⌘1/⌘2 (tab switching), ⌘N (new window), ⌘[ / ⌘] (history),
⌘= / ⌘− (browser zoom), and ⌘S (save page) — are unusable on the web and work only
inside the shell. The web build's bare-key viewer bindings are unchanged.

**Give an item an accelerator only when no `keys` entry already covers it**
(owner rule). An accelerator is reserved application-wide, so duplicating a bare
viewer key spends a global combo on a command you can only reach with the viewer
open. That is why the Playback menu carries accelerators on just Previous/Next
File: with a video loaded the arrow keys mean seek, so those two commands have no
bare-key binding at all, while Play/Pause, seek ±10 s, speed, mute, subtitles, and
snapshot are already covered by Space/K, J/L, `,`/`.`, M, C, and S. Menu items
without an accelerator are perfectly normal — `Pair Device…` has none either.

The Playback menu is routed to the open media viewer. `runViewerCommand` in
`app/viewer/player/useShortcuts.ts` is the one dispatcher shared by the key
bindings and the native menu, and `useViewerMenu` enables the menu only while a
viewer is mounted, so its items are never live against a closed viewer.

Viewer fullscreen uses **real window fullscreen** in the shell rather than the
HTML Fullscreen API, which WKWebView gates behind user activation a native menu
item cannot supply. Fullscreen can also be entered or left without the app
asking — the green zoom button, Mission Control, a window manager — so state is
not tracked from the commands the app issues. Instead the shell watches
`WindowEvent::Resized` (which fires across every fullscreen transition), reads the
window's *actual* state, and broadcasts `cairndex://fullscreen` when it changed.
Broadcasting the observed rather than the assumed state also means a read taken
mid-animation self-corrects. The de-duplication keeps an ordinary live-resize drag
silent. Escape leaves fullscreen before it closes the viewer, including on image
bundles, which have no player. Window state persists size/position/maximized but
deliberately **not** fullscreen or visibility: restoring those would relaunch into
an empty fullscreen or window-less app.

Left click on the video toggles play/pause; right click is deliberately left
unhandled so it stays available for viewer context-menu actions.

## Deep links, notifications, and the export seam

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

`save_export_file` is a seam only — no export UI exists yet. The web layer passes
bytes plus a suggested file *name*; the destination comes solely from the native
save dialog, and any path structure in the suggestion is stripped before use, so
no client-supplied absolute path is ever trusted. It suits small generated
artifacts (a capped GIF, one contact sheet), not streaming media.

## Local-server sidecar

The desktop app bundles the Python server so a local library folder opens with
no server administration (ADR-0018 §5). It is packaged with PyInstaller one-dir
(ADR-0019 §2). [development.md](development.md#local-server-sidecar-appsserverpackaging)
lists the build commands.

### Contract with the shell

`apps/desktop/src-tauri/src/sidecar.rs` implements the shell's side:

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
  with `--watch-parent` and stops when that pipe reaches EOF. It needs no
  target-OS branches (Windows has no SIGTERM), and it still works when the shell
  never gets to ask: a crash or `kill -9` sends no signal and could orphan a
  process holding a private binding lock, but the kernel closes the pipe when the
  shell dies. Verify parent-loss shutdown against the actual packaged executable;
  it must close private stores and leave no orphan.
- The sidecar gets its own `CAIRNDEX_DATA_DIR` under the app's data directory
  (`local-server/`), kept out of the shell's own store — its registry is
  invisible plumbing (ADR-0018 §5).
- In `tauri dev`, the shell detects `tauri::is_dev()` and starts the sidecar with
  `CAIRNDEX_CORS_EXTRA_ORIGINS` set to the dev origin; a value in your own shell
  overrides it.

Independent servers can open the same portable library with separate private data
directories. A private binding lock prevents two processes from using the same
private store.

### Development and distribution builds

`just bundled` builds for the host architecture only (Apple Silicon on an ARM
Mac). Its media tools are symlinks into `packaging/vendor/ffmpeg/<platform>/`, and
its Tauri invocation disables bundle resources so Cargo does not copy release
sidecars into `target/debug`. The development bundle is checkout-local;
`just build-desktop` produces the self-contained release bundle separately. Old
Cargo build output is regenerable; changing development mode does not
automatically delete existing outputs.

An **empty, stale, or wrong-version sidecar is caught at bundling**, not at
compile: `beforeBuildCommand` runs `check-sidecar-staged.mjs`, which fails
`tauri build` when the staged directory has no executable, its packaged server
version does not match root `VERSION`, or the binary predates the server source.
Without it the build can ship no local server at all — the resource copier skips
an empty directory silently — or embed stale server code behind the current app
version. CI builds the sidecar in the macOS job and creates the empty directory in
the Ubuntu Rust job, which runs no Python.

### Smoke test and hidden imports

The smoke test drives the real binary through the paths where a missing frozen
import surfaces: SQLAlchemy's sqlite dialect, the job worker, Pillow thumbnails, a
HEIC preview (`media/previews.py` imports `pi_heif` inside a function), and
SIGTERM releasing the private binding lock. CI runs it on every push.

The smoke test **refuses to run against a half-staged or non-executable bundled
ffmpeg**, rather than letting the sidecar fall back. `media/tool_paths.py`
deliberately falls back to PATH discovery when a configured binary is not
executable — right for the app, wrong for the one run that is supposed to prove
the bundled binary works, since on any developer Mac with Homebrew ffmpeg the
fallback would pass while proving the opposite.

`hiddenimports` in `cairndex-sidecar.spec` is **empty, and that was measured**.
An initial version listed uvicorn, SQLAlchemy, Pillow and `cairndex` entries;
removing each in turn and re-running the smoke test showed all were redundant
(PyInstaller ships `hook-PIL.py` and `hook-sqlalchemy.py`). Do not add entries
speculatively — they make a future genuine gap look already handled. If the
smoke test ever fails on a missing module, add the entry and name the failure it
fixes in a comment.

The sidecar also carries `smbprotocol` for ADR-0034 and ADR-0037's macOS
mounted-SMB publication path. Its static import must remain visible to
PyInstaller, and the packaged smoke gate must retain `cryptography`'s runtime
hook. Source-level SMB tests do not prove that the frozen binary contains this
dependency chain or can access the saved login.

### FFmpeg pins

`packaging/ffmpeg-manifest.json` pins both macOS architectures (ADR-0019 §3).
Linux is deliberately unpinned: the build server covering both macOS arches ships
a Linux variant with `--enable-decklink`, which forces `--enable-nonfree` and
cannot be redistributed. A Linux sidecar built with `--skip-ffmpeg` falls back to
a system ffmpeg through `media/tool_paths.py`, which is fine on a developer
machine and not fine on a user's.

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

The GPL source offer in `THIRD-PARTY-NOTICES.md` runs three years, so each
build's configure line and component versions are **committed** under
`packaging/ffmpeg-build-info/` rather than linked upstream. Re-pinning means
committing the new `versions.txt` for both architectures alongside the digests.

The desktop resource map also embeds `LICENSE`, `THIRD-PARTY-NOTICES.md`, and
the complete GPLv3/LGPLv3 texts from `licenses/`.
`infra/verify_macos_distribution.sh` verifies a built app, or mounts a DMG
read-only and verifies the app inside. macOS CI checks the app bundle; the
release workflow checks both the app and the DMG before drafting a release.

### Signing

`packaging/macos_signing.py create-local` creates a non-exportable signing key in
the user's default Keychain, grants only `codesign` access to that new key, and
stores its public certificate fingerprint and Keychain location outside the
checkout. It changes neither system trust nor existing password access rules.
Repeating setup reuses the same identity; a missing key or invalid configuration
stops the build instead of rotating it. Both development and self-contained builds
use `dev.cairndex.sidecar` with that certificate.

The first explicit SMB operation may require **Always Allow** for the new signer.
Merely choosing **Allow** grants one access, and a locked Keychain or changed
certificate can still require action. A self-signed certificate does not carry
**Always Allow** to a rebuilt sidecar for a login that Finder saved: since macOS
10.12, a Keychain item also has a partition list, and macOS records code without
an Apple-issued Team ID there by its code hash. Each new local build therefore
asks once; only an Apple-issued signing identity would remove the request. The
disposable-Keychain smoke test cannot show this, because the test executable
creates its own item and `security create-keychain` keychains do not enforce
partitions. [deployment.md](deployment.md) describes when the app asks and the
`authorize-smb` command.

`just build-desktop` then re-signs the outer `Cairndex.app` with the same
certificate and the `dev.cairndex.desktop` identifier
(`packaging/macos_signing.py sign-app`). macOS keeps privacy grants, such as
"access files on a network volume", for an app's designated requirement. An
ad-hoc app's requirement is its code hash, so each rebuild asked again; the
certificate requirement survives rebuilds after one more approval. Nested code
keeps its own signatures. The DMG still holds Tauri's ad-hoc copy, and builds
without the local signer, including CI and releases, are unchanged.

`just bundled` detects stale signing even when source timestamps are unchanged,
and the desktop bundle preflight refuses an incorrectly signed backend. The
configuration is `~/Library/Application Support/Cairndex/build-signing.json`;
`CAIRNDEX_SIDECAR_SIGNING_CONFIG` selects another explicit configuration. Neither
configuration nor signing keys belong in the repository or build artifacts.
CI ignores the workstation default. `APPLE_SIGNING_IDENTITY` takes precedence;
`-` explicitly selects the existing ad-hoc path. A real Apple signing identity
also signs PyInstaller's native libraries before the final stable backend
identifier is applied; notarization still requires its separate release
qualification. Configured signing errors stop a build or launch rather than
falling back.

Run `uv run python packaging/keychain_signing_smoke.py` from `apps/server` on
macOS, preferably in a disposable guest, to verify changed binaries sharing one
certificate, refusal of other certificates/identifiers and ad-hoc copies, and
cleanup. It uses only a disposable Keychain and synthetic data; all credential
reads disable user interaction. This gate also runs in macOS CI. Its disposable
Keychain is explicitly unlocked and its private signing keys get the Apple signing
partitions required by headless runners. The test setup passes the temporary
password over stdin, never applies a partition change to a workstation Keychain
or saved-login item, and restores the original certificate search list on success
or failure. Signing failures report a fixed diagnostic category and exit code
while withholding raw tool output. Verify the configured identity again on the
actual sidecar embedded in a production app.
