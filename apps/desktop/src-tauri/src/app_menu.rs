use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    App, AppHandle, Emitter, Manager, Runtime,
};

pub(crate) const MENU_EVENT: &str = "cairndex://menu";
const LIBRARY_MENU_IDS: &[(&str, &str)] = &[
    ("file-menu", "new-bundle"),
    ("view-menu", "show-bundles"),
    ("view-menu", "show-files"),
    ("view-menu", "zoom-in"),
    ("view-menu", "zoom-out"),
    ("view-menu", "toggle-sidebar"),
    ("view-menu", "toggle-inspector"),
];
const SERVER_MENU_IDS: &[(&str, &str)] = &[("file-menu", "pair-device")];

// Maps native menu identifiers to the shared SPA's semantic actions
pub(crate) fn action_for_id(id: &str) -> Option<&str> {
    match id {
        "settings" | "pair-device" | "new-bundle" | "show-bundles" | "show-files" | "zoom-in"
        | "zoom-out" | "toggle-sidebar" | "toggle-inspector" => Some(id),
        _ => None,
    }
}

// Builds the common App/File/Edit/View/Window/Help menu skeleton
pub(crate) fn build(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "App")
        .about(None)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Cairndex")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;
    let file_menu = SubmenuBuilder::with_id(app, "file-menu", "File")
        .item(
            &MenuItemBuilder::with_id("new-bundle", "New Empty Bundle…")
                .accelerator("CmdOrCtrl+N")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("pair-device", "Pair Device…")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::with_id(app, "view-menu", "View")
        .item(
            &MenuItemBuilder::with_id("show-bundles", "Bundles")
                .accelerator("CmdOrCtrl+1")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("show-files", "Files")
                .accelerator("CmdOrCtrl+2")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Increase Card Size")
                .accelerator("CmdOrCtrl+=")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Decrease Card Size")
                .accelerator("CmdOrCtrl+-")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+Shift+S")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-inspector", "Toggle Inspector")
                .accelerator("CmdOrCtrl+Shift+I")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("fullscreen", "Toggle Full Screen")
                .accelerator("CmdOrCtrl+Control+F")
                .build(app)?,
        )
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;
    let help_item = MenuItemBuilder::with_id("help-placeholder", "Cairndex Help")
        .enabled(false)
        .build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&help_item).build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
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
fn toggle_main_window_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(fullscreen) = window.is_fullscreen() {
            let _ = window.set_fullscreen(!fullscreen);
        }
    }
}

// Applies one availability state to a fixed group of native menu items
fn set_menu_items_enabled<R: Runtime>(
    app: &AppHandle<R>,
    items: &[(&str, &str)],
    enabled: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for (submenu_id, item_id) in items {
        let Some(submenu) = menu
            .get(*submenu_id)
            .and_then(|item| item.as_submenu().cloned())
        else {
            continue;
        };
        if let Some(item) = submenu
            .get(*item_id)
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
    set_menu_items_enabled(&app, LIBRARY_MENU_IDS, enabled)
}

// Enables server-backed menu items after desktop bootstrap reaches the SPA
#[tauri::command]
pub(crate) fn set_server_menu_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_menu_items_enabled(&app, SERVER_MENU_IDS, enabled)
}

// Restores the primary window when a second process launches
pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Keeps native identifiers and SPA actions deliberately one-to-one
    #[test]
    fn maps_only_dispatchable_menu_items() {
        assert_eq!(action_for_id("settings"), Some("settings"));
        assert_eq!(action_for_id("fullscreen"), None);
        assert_eq!(action_for_id("quit"), None);
        assert_eq!(action_for_id("help-placeholder"), None);
    }
}
