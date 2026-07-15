// Owns the native application menu and semantic SPA event bridge
mod app_menu;
// Flushes webview state before every application-level exit path
mod lifecycle;
// Owns validation for the persisted Cairndex server URL
mod server_url;

// Configures the portable Tauri host and launches the shared Cairndex SPA
fn main() {
    let app = tauri::Builder::default()
        .manage(lifecycle::ExitGate::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            app_menu::focus_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            app_menu::set_library_menu_enabled,
            app_menu::set_server_menu_enabled,
            lifecycle::finish_exit,
            lifecycle::request_exit,
            server_url::normalize_server_url_command,
        ])
        .setup(|app| {
            app.set_menu(app_menu::build(app)?)?;
            app_menu::install_handler(app.handle());
            app_menu::focus_main_window(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Cairndex desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            lifecycle::intercept_exit(app, api);
        }
    });
}
