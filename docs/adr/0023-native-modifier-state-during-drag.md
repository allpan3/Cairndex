# ADR-0023: Read modifier state natively during a drag

- Status: accepted
- Date: 2026-08-15
- Branch/PR: claude/drag-and-drop-fix-36cb63

## Context

Holding ⌥ while dropping bundles on a collection should add them to it without
removing them from the collection in view. It mostly moved instead, across four
attempts, because the web layer cannot reliably learn that ⌥ is held *during* a
native drag.

Two channels exist in web content, and measurement settled both:

- **Modifier flags on the drag events.** A `DragEvent` is a `MouseEvent`, so it
  carries `altKey`/`getModifierState('Alt')`. Verified present in Chrome against
  real `DragEvent` objects. The owner's pass on the packaged shell showed they
  never arrive there: pressing ⌥ mid-drag changed nothing, while holding it
  before the drag began worked — and the only reading that survives that is the
  one taken at `dragstart`, before the drag takes the keyboard.
- **`dataTransfer.dropEffect`.** The user agent computes it from `effectAllowed`
  and the user's modifier preference before each `dragover`. It cannot be trusted
  on its own: with `effectAllowed = 'copyMove'` it can sit at `copy` for a whole
  drag with nothing held, so believing it outright would copy every time. Read
  from a capture-phase listener (ahead of the handlers that overwrite it to drive
  the cursor badge) it never varied in the shell either, whether sampled on
  `dragover` or on `dragenter`, which no handler writes.

Keyboard events are not an option: during a native macOS drag the window server
owns the keyboard and delivers no `keydown` to the page at all.

`dragDropEnabled` is already `false` on the window, so Tauri's native drag
interception was ruled out as a cause.

The owner's objection is the decisive context: **every other Mac app tracks ⌥
mid-drag.** They do, and this is not a macOS limitation — it is a limit on what
WKWebView passes into JavaScript. Native apps read the modifier from the system
event state, which stays available throughout a drag. The desktop shell has a
native layer that can do exactly the same. `AGENTS.md` requires an accepted ADR
before target-native API usage, and isolates any `#[cfg(target_os = "…")]` code
to one clearly named host module, which is what this ADR authorises.

## Decision

The desktop shell exposes one command, `alt_key_held`, that reports whether the
Option/Alt modifier is currently down, read from Quartz's process-wide event
state via `CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)`. It lives in
`apps/desktop/src-tauri/src/modifiers.rs`, the single module holding this
target-native code, and returns `false` on every non-macOS target so the Ubuntu
Rust-only gate keeps building.

The web layer polls it only while a drag is in flight — started on `dragstart`,
stopped on `drop`/`dragend` — and its answer takes priority over both web
channels, which remain the fallback for the browser build where no host exists.
When no host answers, behaviour is exactly as before this ADR.

## Alternatives considered

- **The `core-graphics` crate.** Considered first, and it does not bind
  `CGEventSourceFlagsState` — only `CGEventSource::new` and per-event flags. A
  dependency that does not cover the call is worse than declaring the call.
- **`NSEvent.modifierFlags` via `objc2-app-kit`.** The same information from
  AppKit. Rejected as the *first* choice because AppKit accessors generally want
  the main thread, and `objc2` models that with a `MainThreadMarker` a Tauri
  command does not hold; `CGEventSourceFlagsState` is a thread-safe C function
  with no such requirement and no Objective-C runtime interaction. Kept as the
  fallback if Quartz ever proves unsuitable.
- **A `CGEventTap` on flags-changed events.** Push instead of poll, but an event
  tap requires the user to grant Input Monitoring in System Settings — a
  permission prompt for a cursor badge is a bad trade, and a denied prompt fails
  silently. `CGEventSourceFlagsState` reads state rather than intercepting
  events and needs no permission.
- **Accept the limitation and document "hold ⌥ before dragging".** Where this
  landed before the owner pushed back. It is a real, working gesture and remains
  the fallback, but it is not what any other Mac app requires, so it is not good
  enough as the answer.
- **Stop writing `dropEffect` so the user agent's own value survives to be
  read.** Would give up the cursor badge the three dragover handlers exist to
  pin, and measurement says the value does not vary in the shell anyway, so the
  cost buys nothing.
- **Wait for WKWebView to deliver modifier state to drag events.** Not
  actionable, and not something an application can influence.

## Consequences

- ⌥ mid-drag works in the desktop shell, the way it does in Chrome and in every
  native app. The gesture stops depending on which engine is running.
- A first `#[cfg(target_os)]` boundary for input state, in one named module. It
  reports one boolean and takes no arguments, so its blast radius is small.
- No new dependency. The `core-graphics` crate binds `CGEventSource::new` and
  per-event flags but not `CGEventSourceFlagsState`, so the module declares that
  one function itself and names the two constants it needs
  (`kCGEventSourceStateCombinedSessionState`, `kCGEventFlagMaskAlternate`). One
  extern declaration and a bitmask are a smaller thing to own than a dependency
  edge for a function the crate does not expose.
- The web layer polls on an interval while dragging. Bounded by the drag's own
  duration, one small IPC call per tick, and it stops on `dragend` — including
  the `dragend` a cancelled drag still fires.
- Sandboxing: `CGEventSourceFlagsState` reads session-wide modifier state, which
  is why it needs no permission but also why it answers even when the app is not
  frontmost. Harmless here, since it is only consulted while this app owns a
  drag.
- If Quartz ever returns stale flags under some configuration, the failure mode
  is the pre-ADR behaviour (mid-drag ⌥ ignored), not a crash or a wrong write:
  the default remains move.

## References

- ADR-0012 client platform strategy (macOS desktop shell direction).
- ADR-0020 macOS private API for the desktop webview background — the precedent
  for a target-native decision recorded as its own ADR.
- `apps/web/src/app/dnd.ts` — `isCopyDrag()`, and the channel priority this ADR
  adds a host reading to the top of.
- Apple, *Quartz Event Services* — `CGEventSourceFlagsState`.
