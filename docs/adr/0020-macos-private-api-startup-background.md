# ADR-0020: macOS private API for the desktop webview background

- Status: accepted
- Date: 2026-07-22
- Branch/PR: fix/desktop-startup-flash-root-cause

## Context

The macOS desktop shell intermittently flashed one white frame at startup.
The window config already set `backgroundColor: "#141519"`, the document and
CSS backgrounds were dark, and the window stayed hidden until React committed
the mounted shell — yet the flash persisted, because WKWebView owns an opaque
white backing surface until WebKit's compositor produces its first real frame.
Every reveal-timing strategy (navigation finished, renderer acknowledgment,
off-screen priming with two `requestAnimationFrame` ticks) raced that
compositor rather than removing the white surface.

The reason `backgroundColor` did not cure it: wry only disables the webview's
own background (the private `drawsBackground` KVC key on WKWebView) when its
`transparent` Cargo feature is compiled in, and Tauri gates that feature behind
`macos-private-api`. Our `tauri` dependency enabled no features, so the config
value only colored the NSWindow behind an opaque white webview.

`AGENTS.md` requires an ADR for target-native API usage; this flag opts the
whole app into a private-API code path, which is the consequential part.

## Decision

Enable the `macos-private-api` Cargo feature on the `tauri` dependency and set
`app.macOSPrivateApi: true` in `tauri.conf.json`, so the configured window
`backgroundColor` disables WKWebView's white backing surface and the dark
NSWindow background is what the compositor shows from the first frame, making
startup reveal timing irrelevant to flash behavior.

The window still starts hidden and is revealed after the renderer acknowledges
the mounted shell (with the two-second native fail-safe). That gate is retained
for content polish — the window appears with UI already present — not as a
flash defense. The off-screen priming workaround (commit `9f9cbc6`) is
reverted; it is preserved on branch `archive/startup-offscreen-priming`.

## Alternatives considered

- Off-screen priming (previous approach) — show the window at
  (-32000, -32000), wait two `requestAnimationFrame` ticks, then restore the
  saved placement. Worked in testing but depends on undocumented behavior:
  macOS occlusion throttling could legitimately treat a fully off-screen
  window like a hidden one, silently reintroducing the race. Also added a
  three-phase native state machine and unmaximize/move/re-maximize
  choreography.
- Reveal-timing heuristics without private API — every variant only proves the
  document loaded, not that the compositor produced a dark frame; the race is
  unwinnable in principle.
- Wait for a public Tauri/wry API — no public WKWebView API exists today to
  suppress the initial background paint; `underPageBackgroundColor` (public,
  already applied by wry) only affects overscroll areas.

## Consequences

- The first composited frame is dark by construction; the startup path loses
  the off-screen state machine and stays simple.
- `drawsBackground` is a private WebKit KVC key: Mac App Store submission
  would risk rejection. We distribute `app`/`dmg` bundles only, so this is
  acceptable; revisit this ADR if MAS distribution ever becomes a goal.
- Risk of Apple removing the key is low (stable for years, guarded in wry for
  macOS 10.14+); the failure mode is regression to today's flash, not a crash.
- `macos-private-api` also compiles in wry's `fullscreen` feature; no behavior
  change expected for existing fullscreen handling.

## References

- wry 0.55.1 `src/wkwebview/mod.rs` — `drawsBackground` handling gated on the
  `transparent` feature.
- ADR-0012 client platform strategy (macOS desktop shell direction).
- Reverted workaround: commit `9f9cbc6`, branch `archive/startup-offscreen-priming`.
