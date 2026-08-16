//! Current keyboard-modifier state, read from the OS (ADR-0023).
//!
//! The one thing the web layer cannot learn for itself. During a native macOS
//! drag the window server owns the keyboard: no `keydown` reaches the page, and
//! WKWebView delivers neither modifier flags on the drag events nor a
//! `dropEffect` that tracks them — measured on a packaged build, where ⌥ pressed
//! mid-drag changed nothing while ⌥ held *before* the drag worked. Chrome does
//! deliver them, so the same web code behaves differently in the two engines.
//!
//! Native apps have no such problem because they read the system's own event
//! state, which stays current throughout a drag. This is that read, and it is
//! the only target-native input code in the shell — `AGENTS.md` keeps
//! `#[cfg(target_os = …)]` to one clearly named module, so it lives here and
//! nowhere else.
//!
//! Quartz rather than AppKit: `CGEventSourceFlagsState` is a thread-safe C
//! function needing neither the main thread nor a `MainThreadMarker`, which a
//! Tauri command does not hold. It reads state rather than intercepting events,
//! so unlike a `CGEventTap` it requires no Input Monitoring permission.

/// Whether Option/Alt is down right now.
///
/// Polled by the web layer only while a drag is in flight. Always `false` off
/// macOS: no other target has the problem this exists to solve, and the Ubuntu
/// Rust-only CI job has to keep building.
#[tauri::command]
pub(crate) fn alt_key_held() -> bool {
    alt_held()
}

#[cfg(target_os = "macos")]
mod mac {
    // Declared rather than pulled from `core-graphics`: that crate binds
    // `CGEventSource::new` and per-event flags but not `CGEventSourceFlagsState`,
    // and one extern declaration plus one mask is a smaller thing to own than a
    // new dependency edge for a function it does not expose.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: u32) -> u64;
    }

    /// `kCGEventSourceStateCombinedSessionState` — the modifier state a
    /// foreground app sees, the same flags AppKit reports, as opposed to
    /// `HIDSystemState` (raw hardware) or one event source's private state.
    const COMBINED_SESSION_STATE: u32 = 0;

    /// `kCGEventFlagMaskAlternate`, which is also `NSEvent`'s `.option`.
    const FLAG_MASK_ALTERNATE: u64 = 0x0008_0000;

    pub(super) fn alt_held() -> bool {
        // Safe: no arguments to get wrong, no ownership transferred, and the
        // return is a plain bitmask. The call reads state and allocates nothing.
        let flags = unsafe { CGEventSourceFlagsState(COMBINED_SESSION_STATE) };
        flags & FLAG_MASK_ALTERNATE != 0
    }
}

#[cfg(target_os = "macos")]
fn alt_held() -> bool {
    mac::alt_held()
}

#[cfg(not(target_os = "macos"))]
fn alt_held() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::alt_held;

    /// Proves the call links and answers rather than trapping — and, on macOS,
    /// that it needs no permission the test runner has not been granted. No key
    /// is held in CI, so the answer is `false`; asserting the value either way
    /// would be asserting the state of whoever's keyboard is running the suite.
    #[test]
    fn reading_the_modifier_state_does_not_require_a_held_key() {
        assert!(!alt_held());
    }
}
