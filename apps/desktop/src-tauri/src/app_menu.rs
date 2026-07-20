use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder},
    App, AppHandle, Emitter, Manager, Runtime,
};

use crate::keymap::{self, ItemSpec, MenuSpec};

pub(crate) const MENU_EVENT: &str = "cairndex://menu";
/// Broadcasts native window fullscreen changes so the viewer's own fullscreen
/// control cannot show a stale state after the View menu toggled the window.
pub(crate) const FULLSCREEN_EVENT: &str = "cairndex://fullscreen";

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

// Toggles native window fullscreen without depending on web user activation
pub(crate) fn toggle_main_window_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(fullscreen) = window.is_fullscreen() {
            if window.set_fullscreen(!fullscreen).is_ok() {
                let _ = app.emit(FULLSCREEN_EVENT, !fullscreen);
            }
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

// Enables the Playback menu only while a media viewer is actually open
#[tauri::command]
pub(crate) fn set_playback_menu_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_group_enabled(&app, "viewer", enabled)
}

// Sets native window fullscreen for the viewer. Every fullscreen change flows
// through here (or the View menu item above) so exactly one place emits the
// state event and no observer can hold a stale value.
#[tauri::command]
pub(crate) fn set_window_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())?;
    let _ = app.emit(FULLSCREEN_EVENT, fullscreen);
    Ok(())
}

// Restores the primary window when a second process launches
pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
