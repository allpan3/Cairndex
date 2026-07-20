//! Parses the shared Cairndex keymap table and builds the native menu from it.
//!
//! The table lives in the web app (`apps/web/src/platform/keymap.json`) because
//! plan 3 §7 requires one keymap owned by the SPA. The shell embeds it at compile
//! time and *constructs* the menu from it rather than mirroring it by hand, so a
//! label or accelerator can never drift between the two consumers.

use std::sync::OnceLock;

use serde::Deserialize;

/// The embedded keymap source. Cross-app include is deliberate and mirrors the
/// existing `frontendDist`/`devUrl` dependency on `apps/web` (plan 3 §3).
const KEYMAP_JSON: &str = include_str!("../../../web/src/platform/keymap.json");

#[derive(Debug, Deserialize)]
pub(crate) struct Keymap {
    pub(crate) menus: Vec<MenuSpec>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MenuSpec {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) items: Vec<ItemSpec>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemSpec {
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) accelerator: Option<String>,
    /// Selects a Tauri built-in item (OS-localized, native behavior).
    #[serde(default)]
    pub(crate) predefined: Option<String>,
    #[serde(default)]
    pub(crate) separator: bool,
    /// Enablement group: `server`, `library`, `viewer`, `never`, or absent.
    #[serde(default)]
    pub(crate) requires: Option<String>,
    /// True when the shell handles the item itself instead of emitting an SPA
    /// action (quit, native window fullscreen).
    #[serde(default)]
    pub(crate) native: bool,
}

impl ItemSpec {
    /// True when this item dispatches a semantic action to the SPA.
    pub(crate) fn dispatches_to_spa(&self) -> bool {
        self.id.is_some()
            && !self.native
            && !self.separator
            && self.predefined.is_none()
            && self.requires.as_deref() != Some("never")
    }
}

/// Parses the embedded table once per process.
pub(crate) fn keymap() -> &'static Keymap {
    static PARSED: OnceLock<Keymap> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(KEYMAP_JSON).expect("embedded keymap.json must be valid")
    })
}

/// Collects `(submenu_id, item_id)` pairs for one enablement group.
pub(crate) fn items_requiring(group: &str) -> Vec<(&'static str, &'static str)> {
    let mut found = Vec::new();
    for menu in &keymap().menus {
        for item in &menu.items {
            if item.requires.as_deref() != Some(group) {
                continue;
            }
            if let Some(id) = item.id.as_deref() {
                found.push((menu.id.as_str(), id));
            }
        }
    }
    found
}

/// Maps a native menu identifier to its SPA action, rejecting shell-owned ids.
pub(crate) fn action_for_id(id: &str) -> Option<&'static str> {
    keymap()
        .menus
        .iter()
        .flat_map(|menu| &menu.items)
        .find_map(|item| {
            let item_id = item.id.as_deref()?;
            (item_id == id && item.dispatches_to_spa()).then_some(item_id)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The embedded table must parse; a malformed edit would otherwise only fail
    // at runtime, after the menu had already been requested.
    #[test]
    fn parses_the_embedded_keymap() {
        let map = keymap();
        assert!(!map.menus.is_empty());
        assert!(map.menus.iter().any(|menu| menu.id == "playback-menu"));
    }

    // Every accelerator must parse in the same crate Tauri uses to register it, so
    // a typo fails here instead of reaching a packaged build as a dead shortcut.
    #[test]
    fn every_accelerator_parses() {
        for menu in &keymap().menus {
            for item in &menu.items {
                let Some(accelerator) = item.accelerator.as_deref() else {
                    continue;
                };
                accelerator
                    .parse::<muda::accelerator::Accelerator>()
                    .unwrap_or_else(|error| {
                        panic!(
                            "{} accelerator {accelerator:?} is invalid: {error}",
                            menu.id
                        )
                    });
            }
        }
    }

    // A menu item that neither dispatches, acts natively, nor is predefined would
    // render as a dead entry the user can click with no effect.
    #[test]
    fn every_actionable_item_has_a_consumer() {
        for menu in &keymap().menus {
            for item in &menu.items {
                if item.separator || item.predefined.is_some() {
                    continue;
                }
                let id = item.id.as_deref().unwrap_or_default();
                assert!(
                    item.dispatches_to_spa()
                        || item.native
                        || item.requires.as_deref() == Some("never"),
                    "{} item {id:?} has no consumer",
                    menu.id
                );
                assert!(
                    item.label.is_some(),
                    "{} item {id:?} needs a label",
                    menu.id
                );
            }
        }
    }

    // Accelerators are global; a duplicate would leave one item permanently dead.
    #[test]
    fn accelerators_are_unique() {
        let mut seen: Vec<&str> = Vec::new();
        for menu in &keymap().menus {
            for item in &menu.items {
                if let Some(accelerator) = item.accelerator.as_deref() {
                    assert!(
                        !seen.contains(&accelerator),
                        "duplicate accelerator {accelerator:?}"
                    );
                    seen.push(accelerator);
                }
            }
        }
    }

    // Keeps native identifiers and SPA actions deliberately one-to-one.
    #[test]
    fn maps_only_dispatchable_menu_items() {
        assert_eq!(action_for_id("settings"), Some("settings"));
        assert_eq!(action_for_id("play-pause"), Some("play-pause"));
        // Shell-owned: handled in Rust, never emitted to the SPA.
        assert_eq!(action_for_id("fullscreen"), None);
        assert_eq!(action_for_id("quit"), None);
        // Disabled placeholder.
        assert_eq!(action_for_id("help-placeholder"), None);
        assert_eq!(action_for_id("not-a-menu-item"), None);
    }

    // The enablement groups the shell exposes as commands must be non-empty, or a
    // renamed `requires` value would silently stop gating anything.
    #[test]
    fn enablement_groups_are_populated() {
        assert!(!items_requiring("library").is_empty());
        assert!(!items_requiring("server").is_empty());
        assert!(!items_requiring("viewer").is_empty());
        assert!(items_requiring("nonexistent-group").is_empty());
    }
}
