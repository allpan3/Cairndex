use std::{
    sync::{
        atomic::{AtomicI8, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder},
    App, AppHandle, Emitter, Manager, PhysicalPosition, Runtime,
};

use crate::keymap::{self, ItemSpec, MenuSpec};

pub(crate) const MENU_EVENT: &str = "cairndex://menu";
/// Broadcasts native window fullscreen changes so the viewer's own fullscreen
/// control cannot show a stale state after the View menu toggled the window.
pub(crate) const FULLSCREEN_EVENT: &str = "cairndex://fullscreen";
const REVEAL_FALLBACK_DELAY: Duration = Duration::from_secs(2);

/// Original placement retained while the renderer paints the window off-screen.
#[derive(Clone, Copy)]
struct StartupWindowPlacement {
    position: PhysicalPosition<i32>,
    maximized: bool,
}

/// Tracks whether the startup window is hidden, painting off-screen, or ready.
#[derive(Default)]
enum MainWindowPhase {
    #[default]
    Hidden,
    Priming(StartupWindowPlacement),
    Ready,
}

/// Describes how the first reveal must restore the native window.
enum MainWindowReveal {
    AlreadyReady,
    CurrentPosition,
    Restore(StartupWindowPlacement),
}

/// Gates focus and retains placement while WKWebView produces its first frame.
#[derive(Default)]
pub(crate) struct MainWindowReady(Mutex<MainWindowPhase>);

impl MainWindowReady {
    // Starts the off-screen paint phase exactly once
    fn start_priming(&self, placement: StartupWindowPlacement) -> bool {
        let mut phase = self.0.lock().expect("startup window state poisoned");
        if !matches!(*phase, MainWindowPhase::Hidden) {
            return false;
        }
        *phase = MainWindowPhase::Priming(placement);
        true
    }

    // Marks startup ready and returns any placement that must be restored
    fn finish(&self) -> MainWindowReveal {
        let mut phase = self.0.lock().expect("startup window state poisoned");
        match std::mem::replace(&mut *phase, MainWindowPhase::Ready) {
            MainWindowPhase::Hidden => MainWindowReveal::CurrentPosition,
            MainWindowPhase::Priming(placement) => MainWindowReveal::Restore(placement),
            MainWindowPhase::Ready => MainWindowReveal::AlreadyReady,
        }
    }

    // Reports whether the initial frame is safe to expose
    fn is_ready(&self) -> bool {
        matches!(
            *self.0.lock().expect("startup window state poisoned"),
            MainWindowPhase::Ready
        )
    }
}

// Maps native menu identifiers to the shared SPA's semantic actions
pub(crate) fn action_for_id(id: &str) -> Option<&'static str> {
    keymap::action_for_id(id)
}

// Builds the whole menu bar from the shared keymap table (plan 3 §7)
pub(crate) fn build(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    let mut builder = MenuBuilder::new(app);
    let submenus: Vec<Submenu<tauri::Wry>> = keymap::keymap()
        .menus
        .iter()
        .map(|menu| build_submenu(app, menu))
        .collect::<tauri::Result<_>>()?;
    for submenu in &submenus {
        builder = builder.item(submenu);
    }
    builder.build()
}

// Builds one submenu, honoring predefined items, separators, and initial state
fn build_submenu(app: &App, menu: &MenuSpec) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::with_id(app, menu.id.as_str(), menu.label.as_str());
    for item in &menu.items {
        builder = apply_item(app, builder, item)?;
    }
    builder.build()
}

// Applies one table entry to the submenu under construction
fn apply_item<'a>(
    app: &App,
    builder: SubmenuBuilder<'a, tauri::Wry, App>,
    item: &ItemSpec,
) -> tauri::Result<SubmenuBuilder<'a, tauri::Wry, App>> {
    if item.separator {
        return Ok(builder.separator());
    }
    if let Some(predefined) = item.predefined.as_deref() {
        return Ok(match predefined {
            "about" => builder.about(None),
            "close-window" => builder.close_window(),
            "copy" => builder.copy(),
            "cut" => builder.cut(),
            "minimize" => builder.minimize(),
            "paste" => builder.paste(),
            "redo" => builder.redo(),
            "select-all" => builder.select_all(),
            "undo" => builder.undo(),
            // An unknown name is a table typo; skipping silently would hide it,
            // and the keymap test asserts every entry has a consumer.
            other => panic!("unknown predefined menu item {other:?}"),
        });
    }

    let (Some(id), Some(label)) = (item.id.as_deref(), item.label.as_deref()) else {
        panic!("keymap item needs both an id and a label");
    };
    let mut entry = MenuItemBuilder::with_id(id, label);
    if let Some(accelerator) = item.accelerator.as_deref() {
        entry = entry.accelerator(accelerator);
    }
    // Gated items start disabled; the SPA enables its group once that capability
    // is really available (a server, an unlocked workspace, an open viewer).
    if item.requires.is_some() {
        entry = entry.enabled(false);
    }
    Ok(builder.item(&entry.build(app)?))
}

// Dispatches native menu actions to every Cairndex webview
pub(crate) fn install_handler<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == "fullscreen" {
            toggle_main_window_fullscreen(app);
        } else if id == "quit" {
            crate::lifecycle::begin_exit(app);
        } else if let Some(action) = action_for_id(id) {
            let _ = app.emit(MENU_EVENT, action);
        }
    });
}

/// Last fullscreen state broadcast to the SPA, so repeated resize events emit at
/// most one event per real transition.
static LAST_FULLSCREEN: AtomicI8 = AtomicI8::new(-1);

/// Reads the window's *actual* fullscreen state and broadcasts it when it has
/// changed. Every transition funnels through here — the View menu, the viewer's
/// own control, and OS-initiated ones the app never requested (the green zoom
/// button, or Mission Control). Broadcasting the observed state rather than an
/// assumed one also means a read taken mid-animation self-corrects on the next
/// resize event instead of pinning a wrong value.
pub(crate) fn broadcast_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(fullscreen) = window.is_fullscreen() else {
        return;
    };
    let current = i8::from(fullscreen);
    if LAST_FULLSCREEN.swap(current, Ordering::Relaxed) != current {
        let _ = app.emit(FULLSCREEN_EVENT, fullscreen);
    }
}

// Toggles native window fullscreen without depending on web user activation
pub(crate) fn toggle_main_window_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(fullscreen) = window.is_fullscreen() {
            let _ = window.set_fullscreen(!fullscreen);
            broadcast_fullscreen(app);
        }
    }
}

// Applies one availability state to every item in a keymap enablement group
fn set_group_enabled<R: Runtime>(
    app: &AppHandle<R>,
    group: &str,
    enabled: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for (submenu_id, item_id) in keymap::items_requiring(group) {
        let Some(submenu) = menu
            .get(submenu_id)
            .and_then(|item| item.as_submenu().cloned())
        else {
            continue;
        };
        if let Some(item) = submenu
            .get(item_id)
            .and_then(|item| item.as_menuitem().cloned())
        {
            item.set_enabled(enabled)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

// Enables workspace-only native menu items once the SPA has an active library
#[tauri::command]
pub(crate) fn set_library_menu_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_group_enabled(&app, "library", enabled)
}

// Enables server-backed menu items after desktop bootstrap reaches the SPA
#[tauri::command]
pub(crate) fn set_server_menu_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_group_enabled(&app, "server", enabled)
}

// Enables Playback items while a viewer is open. `video` is separate because an
// image bundle has no player: only Previous/Next File do anything there, and
// showing the rest as enabled would offer live menu items that silently no-op.
#[tauri::command]
pub(crate) fn set_viewer_menu_enabled(
    app: AppHandle,
    viewer: bool,
    video: bool,
) -> Result<(), String> {
    set_group_enabled(&app, "viewer", viewer)?;
    set_group_enabled(&app, "viewer-video", video)
}

// Toggles native window fullscreen atomically. The viewer calls this rather than
// reading then setting over two IPC round trips, so two fast presses cannot both
// observe the same pre-toggle state. Returns the resulting state.
#[tauri::command]
pub(crate) fn toggle_window_fullscreen(app: AppHandle) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(!fullscreen)
        .map_err(|error| error.to_string())?;
    broadcast_fullscreen(&app);
    Ok(!fullscreen)
}

// Restores the primary window after the renderer has exposed it
pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let ready = app
        .try_state::<MainWindowReady>()
        .is_some_and(|state| state.is_ready());
    if ready {
        focus_main_window_now(app, None);
    }
}

// Moves the mounted window off-screen so WebKit can produce real animation frames
#[tauri::command]
pub(crate) fn prime_renderer(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let placement = StartupWindowPlacement {
        position,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let priming = app
        .try_state::<MainWindowReady>()
        .is_some_and(|state| state.start_priming(placement));
    if !priming {
        return false;
    }

    if placement.maximized && window.unmaximize().is_err() {
        return false;
    }
    let offscreen = PhysicalPosition::new(-32_000, -32_000);
    if window.set_position(offscreen).is_err() {
        return false;
    }
    window.show().is_ok()
}

// Reveals the primary window exactly once after the renderer is ready
pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    let reveal = app
        .try_state::<MainWindowReady>()
        .map_or(MainWindowReveal::AlreadyReady, |state| state.finish());
    match reveal {
        MainWindowReveal::AlreadyReady => {}
        MainWindowReveal::CurrentPosition => focus_main_window_now(app, None),
        MainWindowReveal::Restore(placement) => focus_main_window_now(app, Some(placement)),
    }
}

// Accepts the renderer's post-mount startup acknowledgment
#[tauri::command]
pub(crate) fn renderer_ready(app: AppHandle) {
    reveal_main_window(&app);
}

// Prevents a broken renderer bridge from leaving the application invisible
pub(crate) fn schedule_main_window_reveal_fallback(app: &AppHandle) {
    let ready = app
        .try_state::<MainWindowReady>()
        .is_some_and(|state| state.is_ready());
    if ready {
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(REVEAL_FALLBACK_DELAY);
        reveal_main_window(&app);
    });
}

// Shows, restores, and focuses the already-loaded primary window
fn focus_main_window_now<R: Runtime>(
    app: &AppHandle<R>,
    placement: Option<StartupWindowPlacement>,
) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(placement) = placement {
            if window.set_position(placement.position).is_err() {
                let _ = window.center();
            }
            if placement.maximized {
                let _ = window.maximize();
            }
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{MainWindowPhase, MainWindowReady, MainWindowReveal, StartupWindowPlacement};
    use tauri::PhysicalPosition;

    // Pins the hidden, off-screen paint, and ready transitions
    #[test]
    fn main_window_primes_and_becomes_ready_once() {
        let ready = MainWindowReady::default();
        let placement = StartupWindowPlacement {
            position: PhysicalPosition::new(120, 80),
            maximized: false,
        };

        assert!(!ready.is_ready());
        assert!(ready.start_priming(placement));
        assert!(!ready.start_priming(placement));
        assert!(matches!(
            ready.finish(),
            MainWindowReveal::Restore(restored) if restored.position == placement.position
        ));
        assert!(ready.is_ready());
        assert!(matches!(ready.finish(), MainWindowReveal::AlreadyReady));
        assert!(matches!(*ready.0.lock().unwrap(), MainWindowPhase::Ready));
    }

    // Pins the emergency path when off-screen priming never starts
    #[test]
    fn main_window_can_reveal_directly_from_hidden() {
        let ready = MainWindowReady::default();

        assert!(matches!(ready.finish(), MainWindowReveal::CurrentPosition));
        assert!(ready.is_ready());
    }

    // Pins the native half of the hidden-until-mounted startup contract
    #[test]
    fn main_window_starts_hidden_with_a_dark_fallback() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main_window = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();

        assert_eq!(main_window["visible"], false);
        assert_eq!(main_window["backgroundColor"], "#141519");
    }
}
