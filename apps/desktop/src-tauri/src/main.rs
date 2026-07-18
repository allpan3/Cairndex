// Owns the native application menu and semantic SPA event bridge
mod app_menu;
// Flushes webview state before every application-level exit path
mod lifecycle;
// Streams server media through the shell-owned bearer transport
mod media_proxy;
// Owns validation for the persisted Cairndex server URL
mod server_url;

use tauri::Manager;

// Builds the portable Tauri host and runs the shared Cairndex SPA
fn run() -> Result<(), Box<dyn std::error::Error>> {
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
            media_proxy::configure_media_proxy,
            server_url::normalize_server_url_command,
        ])
        .setup(|app| {
            let media_proxy = media_proxy::MediaProxy::start().map_err(std::io::Error::other)?;
            if !app.manage(media_proxy) {
                return Err(std::io::Error::other("media proxy state already exists").into());
            }
            app.set_menu(app_menu::build(app)?)?;
            app_menu::install_handler(app.handle());
            app_menu::focus_main_window(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            lifecycle::intercept_exit(app, api);
        }
    });
    Ok(())
}

// Reports startup failure without panicking inside the packaged application
fn main() {
    if let Err(error) = run() {
        eprintln!("Cairndex desktop could not start: {error}");
    }
}
