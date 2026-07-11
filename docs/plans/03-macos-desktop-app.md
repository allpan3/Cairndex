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
  manager") come from a per-OS label map beside the keymap table, which
  already plans per-platform bindings (§7).
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
- Distribution: Developer ID signing + notarization; auto-update via the
  Tauri updater plugin against GitHub Releases. Dev builds unsigned.

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
  setLibraryMapping(libraryId: string, localRoot: string): Promise<void>
}
```

- `web.ts` implements it as all-false no-ops; `desktop.ts` calls Tauri
  `invoke()`; detection via `window.__TAURI_INTERNALS__`. UI reads the flags
  to show/hide "Reveal in Finder" / "Open in Default App" in the existing
  context menus and `FileInspector`/File Browser surfaces.
- Auth: the shell talks to the same remote server; reuse the plan-2 device
  token (Settings → pair this device) stored via the Tauri store plugin, sent
  as `Authorization: Bearer`. Web client behavior unchanged.
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
  drag pasteboard so Finder/other apps receive them. Implementation: the
  `tauri-plugin-drag` native drag with the mapped absolute paths (validated
  exactly as §5). Only offered when the library is mapped and files are
  available. Web-platform fallback: nothing (browser drag-out of server files
  isn't a thing beyond downloads).
- **Drag-in:** files dropped from Finder that resolve *inside* a mapped
  library root → reverse-map to relative paths → offer the existing
  fast-add/manual-bundling flows. Files outside every mapped root → explain
  ("Cairndex links files in place; move it into a library first") — no
  copy/import in this milestone. Once plan 4 W5 (import-external upload)
  lands, this upgrades into an optional **"Copy into library…"** flow: the
  shell streams the local file to the server, which writes it through the
  journaled write-mode path. **Drag-and-drop media into the app is the
  owner's stated reason for write mode** (2026-07-10), so plan 4 is
  sequenced immediately after this shell with W5 promoted (W0 → W1 → W5) —
  D4 should land with the reverse-map flow *and* the seam for the copy flow
  so W5 plugs in without reworking the drop handler.

## 7. Native shell niceties

- **Menu bar** with real accelerators: App (About/Settings/Quit), File (New
  Bundle…, Pair Device…), Edit (standard clipboard so text fields behave),
  View (Bundles/Files surface, zoom slider steps, toggle inspector/sidebar),
  Playback (player commands routed to the viewer when open), Window, Help.
  Menu events dispatch to the SPA via Tauri events; the SPA maps them onto
  the same handlers its shortcuts use.
- Shortcut audit: browser-reserved combos (⌘L, ⌘number, ⌘W…) become safe to
  use; keep one keymap table in the web app with per-platform bindings.
- Window state persistence (size/position), proper fullscreen for the viewer,
  optional second window for the viewer later (needs a small router seam —
  defer unless wanted).
- Single instance + `cairndex://` deep links (open bundle/collection);
  dock badge / user notification when a long job (scan/probe) finishes —
  subscribes to the existing job progress API.
- localStorage prefs migrate transparently (WKWebView persists per bundle id);
  shell-owned settings (server URL, token, mappings) live in the Tauri store.

## 8. What this plan does NOT change

- No embedded Python server in the shell for v1. The owner's deployment is a
  NAS server; the shell is a client. (A bundled "local mode" sidecar via
  PyInstaller is a plausible later milestone for laptop-only use — noted, not
  planned.)
- No mpv/custom video pipeline in the shell (§2 rationale).
- No write-mode logic in the shell itself — write mode is a server
  capability ([plan 4](04-library-write-mode.md), ADR-0013); the shell's
  mapping/validation layer (§5) complements it for host handoffs and feeds
  the drag-in copy flow (§6).

## 9. Milestones

| # | Slice | Contents |
|---|-------|----------|
| D1 | Shell bootstrap | `apps/desktop`, window/menu skeleton, server-URL first-run, loads the SPA, CI job |
| D2 | Platform seam + auth | `HostPlatform` interface in `apps/web`, device-token pairing UI in shell, bearer wiring |
| D3 | Path mappings + reveal/open | §5 end-to-end incl. manifest-UUID validation + tests (Rust unit tests for the path rules) |
| D4 | Drag-out / drag-in | §6 |
| D5 | Shell polish | Menu/shortcut audit, window state, deep links, job notifications, native save dialog + notification for media exports (plan 1 §10), updater + signing pipeline |

D1–D2 already deliver a real "app" with every plan-1 player gain; D3–D4 are
the features a browser can never have.

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
- Open: second-window viewer, local-mode sidecar (§8). Linux shell is a
  stated future want (not v1); §2.1 records the rules that keep it a
  packaging exercise. Windows remains free-ish and unplanned.
