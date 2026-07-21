# Plan 3 — macOS desktop app (Tauri 2 shell)

> Status: planning document (2026-07-04); **owner-prioritized 2026-07-10 as
> the next initiative after plan 1 M9**, ahead of write mode and the Android
> client. See [README.md](README.md) for the shared strategy; decision summary
> in ADR-0012 (accepted). Builds directly on plan 1 (the shell renders
> `apps/web`, so every player/viewer improvement lands here for free) and on
> plan 2 §4 (device tokens — that server slice is pulled forward ahead of D2).
> The owner also wants a **Linux desktop app in the future**, so the shell is
> architected cross-platform-first (§2.1, §3): macOS ships first, but nothing
> macOS-only leaks outside clearly-marked edges.

## 1. Goal and the "Eagle gap"

The owner's read is right: the browser experience is structurally short of
Eagle. Decomposing *why* tells us what a desktop app must actually add versus
what is just web-UI polish:

| Eagle-feel ingredient | Needs a native app? | Where it's addressed |
|---|---|---|
| Buttery grids/thumbnails, instant viewer | No — web-side perf/polish | plan 1 + ongoing web work |
| Real player (shortcuts, tracks, scrub preview) | No | plan 1 |
| **Open with default app** | **Yes** (ADR-0007) | §5 |
| **Reveal in Finder** | **Yes** (ADR-0007) | §5 |
| **Drag a file/bundle out to Finder or another app** | **Yes** | §6 |
| Native menus, dock, window mgmt, ⌘-shortcuts w/o browser conflicts | Yes | §7 |
| Feels like an app (own icon/window, offline-ish resilience) | Yes | shell itself |
| Future: File Browser write mode with native confirmation UX | Server-side (plan 4); shell adds native dialogs | [plan 4](04-library-write-mode.md) |

So the desktop app = the existing SPA + a native capability layer, not a
rewrite. That is exactly the Tauri-shell path the product brief and ADR-0007
already anticipated.

## 2. Technology decision

| Option | UI reuse | Player ceiling | Host integration | Cost | Verdict |
|---|---|---|---|---|---|
| **Tauri 2 (Rust core + WKWebView)** | ~100 % of `apps/web` | Safari engine: H.264/HEVC (HW), VP9/AV1 (recent macOS), **native HLS**; MKV via server remux (plan 1) | full (Rust commands + plugins: opener, drag, fs) | low | **Chosen** |
| Electron | ~100 % | Chromium codecs (HEVC HW since ~M107) | full (Node) | medium; 150 MB+ footprint, heavier RAM | Rejected — no advantage over Tauri for this app, worse footprint |
| Swift/SwiftUI native (+MPVKit) | 0 % | best possible (libmpv plays anything locally) | perfect | very high (second full client) | Rejected for now — revisit only if the WKWebView ceiling is actually hit (§10) |
| Compose Multiplatform desktop | 0 % web, some sharing with the Android repo | weak (no first-class video story) | partial | high | Rejected |

WKWebView playback notes (why the ceiling is acceptable): Safari's engine
gives hardware HEVC — the web client's biggest codec hole closes *natively*
on desktop (verified end-to-end 2026-07-10 on the M7 pipeline: HEVC-in-MP4
direct-plays, HEVC-in-MKV codec-copy remuxes); `caps.native_hls = true` means
the plan-1 HLS fallback plays without hls.js/MSE; MKV still needs server
remux, which plan 1 provides. Local-file playback bypassing the server
(mpv-style) is deliberately **not** a goal — streams come from the server
like every other client, keeping one playback pipeline.

### 2.1 Cross-platform posture (Linux later, maybe Windows)

Tauri 2 is the same shell on macOS/Linux/Windows; the deliberate choices that
keep a future Linux app cheap (packaging + a polish pass, not a port):

- **Every native capability goes through cross-platform Tauri plugins** —
  opener (reveal/open-with), drag, store, updater, single-instance,
  deep-link all support the three desktop OSes. No direct `NSWorkspace`/
  AppKit calls in v1.
- **The Rust command layer is platform-agnostic by construction.** Path
  mapping + validation (§5) is pure `std::path` logic with unit tests;
  anything genuinely OS-specific lives behind `#[cfg(target_os = "…")]` in
  one clearly-named module (`commands/host.rs` edges), never scattered.
- **The web seam stays OS-neutral.** `HostPlatform.kind` is `'desktop'`, not
  `'macos'`; user-facing strings ("Reveal in Finder" vs "Show in file
  manager") come from a per-OS label map. The D5 shortcut audit will add a
  keymap only where a real action consumes it (§7).
- **CI keeps Linux honest from day one:** alongside the macOS build job, a
  cheap Ubuntu `cargo clippy && cargo test` job (no bundling) so the Rust
  layer never silently grows a macOS-only dependency.
- **Known Linux deltas, accepted now:** WebKitGTK instead of WKWebView — no
  HEVC hardware decode and patchier codec support, which the plan-1
  capability/decision pipeline already absorbs (those files transcode);
  packaging is AppImage/deb + no notarization; menu conventions differ
  (in-window menus). None of these change the architecture.
- The **Android client shares no shell code** (separate repo/toolchain, plan
  2); its reuse surface is the server: OpenAPI contract, decision endpoint,
  HLS sessions, storyboards, progress, and the **same device-token pairing**
  the desktop shell uses.

## 3. Repo layout & build

Lives in this monorepo (rationale in README.md):

```text
apps/desktop/
  src-tauri/
    tauri.conf.json        # windows, updater, bundle id (dev.cairndex.app)
    capabilities/          # Tauri 2 permission scoping per window
    src/
      main.rs              # app setup, single-instance, deep links
      commands/
        mappings.rs        # library path-mapping store + validation (§5)
        host.rs            # reveal / open-with (opener plugin wrappers)
        dragout.rs         # drag-out (§6)
  package.json             # tauri CLI; frontend = ../web via Vite
```

- The Vite dev server / build of `apps/web` is the frontend
  (`build.devUrl` / `frontendDist` point at it). No fork of the web app.
- CI: a `desktop` job (macOS runner) running `cargo clippy/test` +
  `tauri build`, plus the Ubuntu check job from §2.1; web gates already cover
  the UI. Linux/Windows shells stay out of scope for v1 but are kept cheap by
  the §2.1 rules (owner wants Linux eventually).
- Distribution — **amended 2026-07-19 (owner)**. Developer ID signing and
  notarization are **no longer a v1 requirement**. *(Superseded 2026-07-20 by
  [ADR-0019](../adr/0019-open-source-distribution-model.md) §4: with open source
  and published binaries, signing is required again.)* Cairndex is single-owner and
  built from source, and Apple Silicon ad-hoc signs at link time, so packaged
  builds have worked locally since D1 with no certificate. The $99/yr Apple
  Developer Program buys nothing until a build must run on a **second Mac** or
  reach someone else's hands; below that threshold it is pure cost. The v1
  distribution model is therefore **built-from-source / ad-hoc signed**, shipping
  both an `.app` and a **DMG** for drag-to-Applications ergonomics.

  A DMG is packaging, **not** trust: an unsigned DMG on another Mac still needs
  System Settings → *Open Anyway*. It is not a signing substitute.

  Developer ID remains a documented **upgrade path**, not a prerequisite. The full
  signing + notarization procedure lives in
  [docs/deployment.md](../deployment.md) and is driven by environment variables
  (`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, a notarytool keychain profile). With
  them unset the build is exactly today's ad-hoc build, so nothing is re-plumbed
  when signing is eventually wanted.

  This is a plan amendment, not an ADR: no architecture changes, only a scope and
  distribution-model decision.

  Auto-update via the Tauri updater against GitHub Releases was the original
  intent but is **deferred** (owner, 2026-07-19): the repository is private with
  no releases, and Tauri's updater fetches release assets over plain HTTPS, so it
  would require embedding a token in the shipped app. Revisit once a public
  release channel exists (public release assets, a separate public releases repo,
  or a self-hosted `latest.json`).

## 4. Platform abstraction in `apps/web`

One small seam so the SPA stays a plain web client (per the owner's intent for
this repo) while lighting up in the shell:

```ts
// apps/web/src/platform/index.ts
export interface HostPlatform {
  kind: 'web' | 'desktop'
  canRevealInFinder: boolean
  canOpenWithDefaultApp: boolean
  canDragOutFiles: boolean
  revealFile(libraryId: string, relativePath: string): Promise<void>
  openFile(libraryId: string, relativePath: string): Promise<void>
  startFileDrag(items: DragOutItem[]): Promise<void>
  getLibraryMapping(libraryId: string): Promise<string | null>
  locateLibrary(libraryId: string, libraryUuid: string): Promise<string | null>
  clearLibraryMapping(libraryId: string): Promise<void>
}
```

- `web.ts` implements it as all-false no-ops; `desktop.ts` calls Tauri
  `invoke()`; detection via `window.__TAURI_INTERNALS__`. UI reads the flags
  to show/hide "Reveal in Finder" / "Open in Default App" in the existing
  context menus and `FileInspector`/File Browser surfaces.
- Auth: the shell talks to the same remote server; reuse the plan-2 device
  token (Settings → pair this device) stored with its approved library ids via
  the Tauri store plugin. Send `Authorization: Bearer` only for those library
  paths. ADR-0017 defines the separate read-only media relay required because
  media elements cannot set headers. Web client behavior remains unchanged.
- Server URL config lives in the shell (first-run screen), so the same build
  works against any NAS.

## 5. Library path mapping + safe host handoff (the ADR-0007 feature)

The server knows library-relative paths; the Mac sees the library through an
SMB/NFS mount. The shell owns a per-library mapping and validates every
handoff:

- **Mapping setup:** Settings → Libraries → "Locate on this Mac" → folder
  picker. Validation: read `<picked>/.cairndex/manifest.json` and require its
  library UUID to equal the server library's UUID (the manifest is portable
  by design — ADR-0008 — so this is a strong, cheap identity check). Store
  `{library_id → local_root}` in the shell's config; surface mapping state in
  the UI (unmapped libraries simply don't offer host actions).
- **Handoff validation (Rust, `mappings.rs`):** given `(library_id,
  relative_path)` — resolve the mapping; reject absolute/`..`/empty client
  paths (mirror the server's rules); canonicalize `local_root + relative_path`
  and require the result to stay under the canonicalized root (symlink-escape
  check); require the file to exist. Only then `revealItemInDir()` /
  `openPath()` (Tauri opener plugin → `NSWorkspace` under the hood).
- The web UI always passes ids + server-provided relative paths — never
  absolute paths — satisfying ADR-0007's safety properties (path proven inside
  a library root, action user-initiated, no server-side command execution;
  the server isn't involved at all).
- Availability guard: if the mount is offline, return a structured error the
  UI turns into "Volume not mounted" instead of a Finder error.

## 6. Drag-out & drag-in

- **Drag-out (Eagle's killer interaction):** dragging a file card / inspector
  file / bundle (= its files) out of the window puts real file paths on the
  drag pasteboard so Finder/other apps receive them. **Implemented (D4)** on
  the File Browser cards/rows, the opened bundle album tiles, the File
  inspector, and the bundle inspector — where the cover drags the whole bundle
  and each "Files in bundle" row drags that file. Only offered when the library
  is mapped and files are available; bundle grid cards keep their existing
  in-window reorder / move-to-collection drag and are not drag-out sources.
  Implementation note: the shell depends on the **`drag` crate directly** (the
  engine behind `tauri-plugin-drag`) rather than the plugin, because the
  plugin's only surface is a JS command that takes absolute paths — which would
  break the §5 rule that the web layer passes only ids + relative paths. The
  `start_file_drag` Rust command resolves + validates each path exactly as §5
  (off the IPC thread), then starts the native drag on the main thread; the sole
  OS-conditional edge is the window handle (§2.1). If `drag`/`tauri-plugin-drag`
  ever stalls, §10's direct `NSDraggingSession` fallback still applies.
  Web-platform fallback: nothing (browser drag-out of server files isn't a
  thing beyond downloads).
- **Drag-in:** files dropped from Finder that resolve *inside* a mapped
  library root → reverse-map to relative paths → offer the existing
  fast-add/manual-bundling flows. Files outside every mapped root → explain
  ("Cairndex links files in place; move it into a library first") — no
  copy/import in this milestone. **Implemented (D4):** Tauri delivers OS drops
  as a native webview event (`dragDropEnabled`) carrying real absolute paths;
  the `reverse_map_paths` Rust command canonicalizes each against the active
  library's identity-verified root and categorizes it: in-library relative *files*,
  out-of-library *files* (echoed back as the dropped absolute paths, which the web
  supplied — no new library-internal path leaks), and a count of dropped
  *directories*. In-library media seeds Create Bundle — the server tolerates and
  *reports by reason* any path it can't bundle in that batch (non-media / missing /
  already in a confirmed bundle), so a folder of media plus a stray `.nfo` or an
  already-bundled file no longer aborts the whole add. An unmapped library is told
  to locate itself first (a still-resolving mapping defers the drop); a drop is
  ignored while any modal, context menu, popover, or viewer is open, or while the
  app's own drag-out is in flight (an id-tagged guard); a dropped folder gets its
  own "drop the files inside" message; outside files get the explanation. Once plan
  4 W5 (import-external upload) lands, the outside-files branch upgrades into an
  optional **"Copy into library…"** flow: the shell streams the local file to the
  server, which writes it through the journaled write-mode path.
  **Drag-and-drop media into the app is the owner's stated reason for write mode**
  (2026-07-10), so plan 4 is sequenced immediately after this shell with W5
  promoted (W0 → W1 → W5) — D4 lands with the reverse-map flow *and* the seam for
  the copy flow (`handleFileDrop`'s `onCopyIntoLibrary`, handed exactly the outside
  absolute paths of *every* drop — all-outside or the outside part of a mixed drop;
  folders are never offered) so W5 plugs in without reworking the drop handler.

## 7. Native shell niceties

- **Menu bar** with real accelerators: App (About/Settings/Quit), File (New
  Bundle…, Pair Device…), Edit (standard clipboard so text fields behave),
  View (Bundles/Files surface, zoom slider steps, toggle inspector/sidebar),
  Playback (player commands routed to the viewer when open), Window, Help.
  **Implemented (D5a).** The menu is *built from* the SPA-owned keymap table
  (`apps/web/src/platform/keymap.json`), which the shell embeds with
  `include_str!` — the two cannot drift because there is only one table, not a
  mirrored pair. Menu events dispatch to the SPA via Tauri events, and
  `runViewerCommand` is one dispatcher shared by the Playback menu and the key
  bindings. The Playback group is enabled only while a viewer is mounted.
- Shortcut audit: browser-reserved combos (⌘L, ⌘number, ⌘W…) become safe to
  use; keep one keymap table in the web app with per-platform bindings.
  **Implemented (D5a):** ⌘1/⌘2, ⌘N, ⌘[ / ⌘], ⌘= / ⌘−, and ⌘⇧I are marked
  `browserReserved` and live only in the shell. Every accelerator is
  modifier-based by construction (test-enforced), so none can swallow a
  keystroke meant for a text field; bare-key viewer bindings stay web-side and
  behave identically in both hosts. **Owner rule (2026-07-19):** an item gets an
  accelerator only when no bare viewer key already covers it — an accelerator is
  reserved application-wide, so duplicating a viewer key spends a global combo on
  a command reachable only with the viewer open. Playback therefore keeps
  accelerators solely on Previous/Next File, which lose their arrow-key binding
  to seek once a video loads; that freed ⌘K, ⌘J, ⌘L, ⌘T, ⇧⌘M, ⇧⌘P, ⇧⌘, and ⇧⌘.
  for future library-wide actions.
- Window state persistence (size/position), proper fullscreen for the viewer,
  optional second window for the viewer later (needs a small router seam —
  defer unless wanted). **Implemented (D5a):** size/position/maximized persist,
  while fullscreen and visibility deliberately do not (restoring either
  relaunches into an empty fullscreen or window-less app; the plugin already
  declines to restore a position no current monitor intersects). Viewer
  fullscreen is *real window fullscreen* — the viewer is already a full-window
  overlay, and this avoids WKWebView gating `requestFullscreen` behind user
  activation a menu item cannot supply. State is tracked from the window itself
  rather than from the commands the app issues: a `WindowEvent::Resized` watcher
  reads the real state and broadcasts `cairndex://fullscreen` on change, so
  OS-initiated transitions the app never requested (green zoom button, Mission
  Control) are folded in too, and a mid-animation read self-corrects. The second
  viewer window remains deferred.
- Single instance + `cairndex://` deep links (open bundle/collection);
  dock badge / user notification when a long job (scan/probe) finishes —
  subscribes to the existing job progress API. **Implemented (D5b).** Deep links
  take one of two OS-chosen delivery paths: macOS sends an Apple Event that can
  arrive before the webview exists (so the shell parks it and the SPA drains it),
  while Windows/Linux pass argv — to the first process on a cold start, to a
  second process on a warm one, forwarded by single-instance. Both can describe
  one action, so links are de-duplicated by identity. Notifications coalesce per
  *run* rather than per job, because `Update library` chains three jobs for one
  user action, and fire only when the run was long **and** the window is
  unfocused. Links resolve only from a packaged, LaunchServices-registered app —
  not from `tauri dev`.
- localStorage prefs migrate transparently (WKWebView persists per bundle id);
  shell-owned settings (server URL, token, mappings) live in the Tauri store.

## 7.1 Connections model (D6.4/D6.5 design sketch)

> Status: **proposed**, written before implementation for review. Settles how
> ADR-0018 §5's "set of connections" behaves. The shell-side half (sidecar
> lifecycle, `open_library_folder`) has landed; this is the web half.

### Decision: one active connection at a time

ADR-0018 §5 says the client generalizes to "remote servers plus one managed
local server". That admits switching or simultaneous browsing. **Switching.**

The codebase has effectively voted three times already: the media proxy is
single-config and rotates its capability secret as a security property (D2/ADR-0017),
deep-link classification is built around "not on *this* server", and job
notification/polling assumes one server's job list. Simultaneity would multiply
all three. It also buys no capability — ADR-0018 guarantees a library is served
by exactly one server anyway, so the only gain is breadth of view. Nothing here
forecloses it later: it becomes additive UI plus a proxy redesign, if something
ever demands it.

### Shape

```text
Connection = { id, kind: 'remote' | 'local', label, serverUrl }
```

- Persisted in the Tauri store under `connections`, plus `activeConnectionId`.
- The **local** entry is singular and managed: no `serverUrl` is persisted for
  it, because the sidecar's port is ephemeral and only valid for the current
  process. It is resolved at activation from `start_local_server`.
- Migration: an existing stored `serverUrl` becomes the first `remote`
  connection, active. No user-visible first-run change for someone who already
  configured a NAS.

### Activation

`activateConnection(id)` is the single choke point, and does what
`configureHostServer` does today plus the credential switch:

1. resolve the base URL — stored for remote, `start_local_server()` for local;
2. `configureServer(url)` (the runtime already reloads device auth per server);
3. reconfigure the media proxy, which rotates its secret — so URLs minted for
   the previous connection stop resolving, which is the behaviour we want on a
   switch rather than something to work around;
4. clear the react-query cache. Library ids are per-server and **not** globally
   unique, so a stale entry could otherwise be read as belonging to the new
   server. This is the one correctness step easy to forget.

The local connection's credential is the loopback owner token from
`start_local_server`; the media proxy derives its server-scoped mode by matching
the running sidecar, so nothing in the web layer carries a scope flag.

### Sidecar lifetime

Started on first activation of the local connection; **kept running until app
exit** even when the user switches back to a remote server. Stopping on switch
would release and reacquire ownership leases each time, which is sync-visible
churn for no benefit, and would make switching back cost a cold start.

### "Open library folder…"

A File-menu item (`keymap.json`, so the menu and SPA stay in step), enabled only
on desktop. It calls the single `open_library_folder` command, which returns ids
only, then activates the local connection and navigates to the returned
`library_id`. Cancel is a no-op.

### D6.5 — ownership UX

Sits on the endpoints already shipped, and belongs at the **mount gate**, not in
the open flow: opening a folder registers it, while the lease is only taken when
a library is mounted, so a conflict surfaces on mount whichever route got there.

| Server state         | UI                                                          |
| -------------------- | ----------------------------------------------------------- |
| `library_lease_held` | Name the holder. Offer "Connect to <url>" when `redirect_url` is set, which adds/activates that remote connection |
| `library_lease_takeover_required` | Explain, show holder + last heartbeat, offer "Serve here anyway" |
| `library_ownership_lost` | The library unmounted underneath us; same redirect offer |

Takeover is `POST …/ownership/takeover` (202) then polling `GET …/ownership`
until `takeover.running` clears — the observation window is ~2 minutes by
design, so the dialog must show indeterminate progress and stay cancellable
(cancelling stops polling; it does not stop the server-side attempt).

### Explicitly not in scope

Simultaneous multi-server browsing; cross-connection deep links (a link naming a
library on an inactive connection keeps today's "not on this server" report);
and any UI for editing the local connection, which is managed, not configured.

### Test plan

Vitest around `connections.ts` (migration from a bare `serverUrl`, activation
order, cache clear on switch, local activation starting the sidecar exactly
once) and the ownership dialog states driven from fixture payloads. Playwright
stays browser-only, where every desktop surface is inert.

## 8. What this plan does NOT change

- No embedded Python server in the shell for v1. The owner's deployment is a
  NAS server; the shell is a client. (The bundled "local mode" sidecar for
  laptop-local libraries is now **planned** as D6 via
  [ADR-0018](../adr/0018-library-ownership-lease-and-local-server.md); it
  follows D5 and the server-side ownership lease, and remains outside the
  D1–D5 scope this plan shipped.)
- No mpv/custom video pipeline in the shell (§2 rationale).
- No write-mode logic in the shell itself — write mode is a server
  capability ([plan 4](04-library-write-mode.md), ADR-0013); the shell's
  mapping/validation layer (§5) complements it for host handoffs and feeds
  the drag-in copy flow (§6).

## 9. Milestones

| # | Slice | Contents |
|---|-------|----------|
| D1 ✅ | Shell bootstrap | `apps/desktop`, window/menu skeleton, server-URL first-run, loads the SPA, CI job |
| D2 ✅ | Platform seam + auth | `HostPlatform` interface in `apps/web`, device-token pairing UI in shell, bearer wiring |
| D3 ✅ | Path mappings + reveal/open | §5 end-to-end incl. manifest-UUID validation + tests (Rust unit tests for the path rules) |
| D4 ✅ | Drag-out / drag-in | §6 |
| D5a ✅ | Menus, shortcuts, window state | Full menu bar built from one shared keymap table, Playback menu routed to the open viewer, browser-reserved shortcut audit, window-state edge cases, native viewer fullscreen |
| D5b ✅ | Deep links, notifications, export seam | `cairndex://` bundle/collection deep links with cold-start parking and single-instance handoff, one dock badge / notification per long *run* (not per job), native save-dialog seam for future media exports (plan 1 §10; M11 hook only, no export UI) |
| D5c ✅ | Distribution | DMG bundle target added for drag-to-Applications install; the full Developer ID + notarization procedure documented in `docs/deployment.md` and **env-gated so it is inert until configured**. Developer ID is an upgrade path, not a v1 requirement (§3 amendment) — ad-hoc signing is the shipped model. CI keeps `--bundles app` because Tauri's DMG bundler drives Finder over AppleScript and flakes on headless runners. **Updater deferred**: the repo is private with no releases, and Tauri's updater would need a token embedded in the shipped app. *(Both premises superseded 2026-07-20 by ADR-0019 §4 — signing and the updater are reopened for the first public release.)* |
| D6 | Local-server sidecar | [ADR-0018](../adr/0018-library-ownership-lease-and-local-server.md): bundled loopback server (spawn/health/env-token auth/shutdown), connections model (remote servers + one managed local server), "Open library folder…", lease takeover-confirmation and redirect UX. Prerequisite: the server-side ownership lease (ADR-0018 §3–§4) — **landed** on `feat/library-ownership-lease` (2026-07-20), along with §6 checkpoint hygiene |

D1–D3 deliver a real "app" with every plan-1 player gain plus safe native file
handoff; D4 adds the remaining drag interaction a browser cannot provide.

## 10. Risks & open decisions

- **WKWebView quirks** (autoplay policies, fullscreen API differences,
  `sendBeacon` on window close) — audit early in D1 with the plan-1 player;
  Tauri exposes WKWebView configuration for autoplay.
- **Ceiling check:** if scrolling/decoding perf in WKWebView ever proves
  inadequate against Eagle on the owner's real library, the recorded fallback
  is a Swift/MPVKit viewer *window* embedded alongside the shell (not a full
  rewrite). Explicitly deferred.
- **`tauri-plugin-drag` maintenance** — small plugin; if it stalls, drag-out
  is implementable directly with an NSDraggingSession snippet in `src-tauri`.
- Open: second-window viewer. The local-mode sidecar is no longer open — it
  is planned as D6 per ADR-0018 (§8). Linux shell is a
  stated future want (not v1); §2.1 records the rules that keep it a
  packaging exercise. Windows remains free-ish and unplanned.
