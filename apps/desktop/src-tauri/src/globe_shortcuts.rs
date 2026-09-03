//! Keeps the standard Full Screen menu item's own ⌃⌘F visible (ADR-0028).
//!
//! macOS 13 made Globe-F the system shortcut for full screen, and AppKit applies
//! that by *adding its own* item to the View menu — then hiding the app's, when
//! the app's is bound to `toggleFullScreen:`. Observed on macOS 26.6, dumping the
//! menu after launch:
//!
//! ```text
//! [3] Enter Full Screen  action=toggleFullScreen:  keyEq='f'  mods=0x800000 FUNCTION(Globe)  hidden=0
//! [4] Enter Full Screen  action=toggleFullScreen:  keyEq='f'  mods=0x140000 Control+Command   hidden=1
//! ```
//!
//! So the item this shell builds from `keymap.json` was never wrong — it was
//! hidden. Registering `NSApplicationEnableGlobeShortcuts` as false before
//! `NSApplication` exists stops the substitution, leaving one visible item at
//! ⌃⌘F with the system action intact. The owner asked for that shortcut twice
//! (2026-09-01, 2026-09-02); this is the only mechanism that produces it without
//! a duplicate entry.
//!
//! The **registration** domain, deliberately: it lives in this process only and
//! writes nothing to the user's preferences, unlike `set` or
//! `CFPreferencesSetAppValue`. Setting the key in `Info.plist` does nothing at
//! all — tested, no effect.
//!
//! This is the shell's second piece of target-native code, and like
//! [`crate::modifiers`] it is confined to one named module with a single
//! `#[cfg(target_os = "macos")]` seam so the Ubuntu Rust-only gate keeps
//! building.

/// Registers the AppKit default described above. Must run before anything
/// touches `NSApplication` — AppKit reads the key while building the menu bar.
/// A no-op off macOS.
pub(crate) fn prefer_control_command_full_screen() {
    #[cfg(target_os = "macos")]
    mac::register();
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    /// Undocumented AppKit compatibility default. It appears in AppKit's own
    /// default-value function table (`_NSApplicationEnableGlobeShortcutsDefault
    /// ValueFunction`) rather than in any header, which is the risk this carries:
    /// a macOS update could rename or drop it, and the only symptom would be the
    /// menu going back to showing Globe-F. Nothing else breaks if it stops
    /// working — see ADR-0028 for why that was an acceptable trade.
    const KEY: &str = "NSApplicationEnableGlobeShortcuts";

    pub(super) fn register() {
        let key = NSString::from_str(KEY);
        let value: Retained<NSNumber> = NSNumber::new_bool(false);
        let value_object: &AnyObject = &value;
        let registration = NSDictionary::from_slices(&[&*key], &[value_object]);
        let defaults = NSUserDefaults::standardUserDefaults();
        // Safe: the dictionary really is `NSString` -> object, which is the
        // generic contract `registerDefaults:` is marked unsafe for.
        unsafe { defaults.registerDefaults(&registration) };
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Proves the registration lands, which is the part this module owns —
        /// the menu it affects belongs to AppKit and cannot be asserted from a
        /// test process without a menu bar. Reads back through the same
        /// `NSUserDefaults` search list AppKit consults.
        #[test]
        fn registers_the_default_without_persisting_it() {
            let key = NSString::from_str(KEY);
            let defaults = NSUserDefaults::standardUserDefaults();
            assert!(
                defaults.objectForKey(&key).is_none(),
                "something already set {KEY}; this test would not prove anything"
            );

            register();

            assert!(!defaults.boolForKey(&key), "{KEY} should read as false");
            assert!(
                defaults.objectForKey(&key).is_some(),
                "{KEY} should now resolve through the registration domain"
            );
        }
    }
}
