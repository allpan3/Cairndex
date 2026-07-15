use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    App, AppHandle, Emitter, Manager, Runtime,
};

pub(crate) const MENU_EVENT: &str = "cairndex://menu";

// Maps native menu identifiers to the shared SPA's semantic actions
pub(crate) fn action_for_id(id: &str) -> Option<&str> {
    match id {
        "settings" | "pair-device" | "new-bundle" | "show-bundles" | "show-files" | "zoom-in"
        | "zoom-out" | "toggle-sidebar" | "toggle-inspector" | "fullscreen" => Some(id),
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
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new-bundle", "New Empty Bundle…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("pair-device", "Pair Device…").build(app)?)
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
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("show-bundles", "Bundles")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("show-files", "Files")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Increase Card Size")
                .accelerator("CmdOrCtrl++")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Decrease Card Size")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-inspector", "Toggle Inspector")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("fullscreen", "Enter Full Screen")
                .accelerator("F11")
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
        if let Some(action) = action_for_id(event.id().as_ref()) {
            let _ = app.emit(MENU_EVENT, action);
        }
    });
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
        assert_eq!(action_for_id("fullscreen"), Some("fullscreen"));
        assert_eq!(action_for_id("quit"), None);
        assert_eq!(action_for_id("help-placeholder"), None);
    }
}
