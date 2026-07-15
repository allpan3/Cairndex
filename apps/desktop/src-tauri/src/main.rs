// Owns the native application menu and semantic SPA event bridge
mod app_menu;
// Isolates any target-OS conditionals from the portable shell
mod host;
// Owns validation for the persisted Cairndex server URL
mod server_url;

// Configures the portable Tauri host and launches the shared Cairndex SPA
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            app_menu::focus_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            server_url::normalize_server_url_command
        ])
        .setup(|app| {
            let _ = host::current();
            app.set_menu(app_menu::build(app)?)?;
            app_menu::install_handler(app.handle());
            app_menu::focus_main_window(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Cairndex desktop");
}
