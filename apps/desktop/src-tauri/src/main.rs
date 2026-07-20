// Owns the native application menu and semantic SPA event bridge
mod app_menu;
// Parses cairndex:// deep links and routes them to the SPA
mod deeplink;
// Puts validated absolute paths on the OS pasteboard for drag-out to Finder
mod dragout;
// Saves server-generated export artifacts through the native save dialog
mod exports;
// Embeds the SPA-owned keymap table that defines the native menu
mod keymap;
// Flushes webview state before every application-level exit path
mod lifecycle;
// Owns shell-local library mappings and path containment validation
mod mappings;
// Streams server media through the shell-owned bearer transport
mod media_proxy;
// Owns validation for the persisted Cairndex server URL
mod server_url;
// Spawns and supervises the bundled local-server sidecar
mod sidecar;
// Performs validated native file handoffs through the opener plugin
mod host;

use tauri::Manager;

// Builds the portable Tauri host and runs the shared Cairndex SPA
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let app = tauri::Builder::default()
        .manage(lifecycle::ExitGate::default())
        .manage(deeplink::PendingDeepLink::default())
        .manage(sidecar::LocalServer::default())
        // Single-instance must be registered BEFORE the deep-link plugin: on
        // Windows/Linux a deep link launches a *second* process whose argv carries
        // the URL, and this callback is where that argv is forwarded to the running
        // instance. macOS instead reuses the running app and delivers an Apple
        // Event, which `on_open_url` below handles.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            app_menu::focus_main_window(app);
            if let Some(url) = deeplink::deep_link_from_args(&argv) {
                deeplink::handle_deep_link(app, &url);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // Restore only SIZE/POSITION/MAXIMIZED. The default set also carries
        // FULLSCREEN, VISIBLE, and DECORATIONS: restoring fullscreen would relaunch
        // into an empty fullscreen window after quitting from a fullscreen viewer,
        // restoring visibility could relaunch the app with no window at all, and
        // decorations are never changed so persisting them is pointless. The plugin
        // already declines to restore a position no current monitor intersects, so a
        // window saved on a since-disconnected display comes back on the primary one.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Fullscreen can also be entered or left without the app asking — the green
        // zoom button, Mission Control, or a window manager. Those paths issue no
        // command, so watch resize (which fires across every fullscreen transition)
        // and rebroadcast the observed state. `broadcast_fullscreen` de-duplicates,
        // so an ordinary live-resize drag emits nothing.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                app_menu::broadcast_fullscreen(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_menu::set_library_menu_enabled,
            app_menu::set_server_menu_enabled,
            app_menu::set_viewer_menu_enabled,
            app_menu::toggle_window_fullscreen,
            deeplink::take_pending_deep_link,
            exports::save_export_file,
            dragout::start_file_drag,
            host::open_file,
            host::reveal_file,
            lifecycle::finish_exit,
            lifecycle::request_exit,
            mappings::clear_library_mapping,
            mappings::get_library_mapping,
            mappings::locate_library_mapping,
            mappings::pick_library_folder,
            mappings::reverse_map_paths,
            media_proxy::configure_media_proxy,
            server_url::normalize_server_url_command,
            sidecar::local_server_status,
            sidecar::start_local_server,
            sidecar::stop_local_server,
        ])
        .setup(|app| {
            let media_proxy = media_proxy::MediaProxy::start().map_err(std::io::Error::other)?;
            if !app.manage(media_proxy) {
                return Err(std::io::Error::other("media proxy state already exists").into());
            }
            app.set_menu(app_menu::build(app)?)?;
            app_menu::install_handler(app.handle());
            app_menu::focus_main_window(app.handle());

            // macOS delivers deep links as an Apple Event, which can fire before
            // the webview exists. `handle_deep_link` parks whatever arrives so the
            // SPA can drain it once it is listening (cold-start case).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        deeplink::handle_deep_link(&handle, url.as_str());
                    }
                });
                // Belt and braces: cold-start correctness otherwise rests on the
                // Apple Event arriving *after* the handler above is registered.
                // `get_current` returns a link the plugin already captured, and the
                // SPA de-duplicates, so covering both costs nothing.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        deeplink::handle_deep_link(app.handle(), url.as_str());
                    }
                }
            }
            // Windows/Linux cold start: the very first process receives the URL in
            // its own argv, which no plugin callback covers.
            if let Some(url) = deeplink::deep_link_from_args(std::env::args()) {
                deeplink::handle_deep_link(app.handle(), &url);
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => lifecycle::intercept_exit(app, api),
        // Stop the sidecar as the process actually goes away, not when exit is
        // merely requested: `intercept_exit` can cancel that request, and a
        // library unmounted out from under a user who chose to stay would be
        // worse than a slightly later shutdown. Closing its stdin here lets it
        // release its ownership leases (ADR-0018 §3), so the next launch — here
        // or on another machine — acquires them silently.
        tauri::RunEvent::Exit => sidecar::shutdown(app),
        _ => {}
    });
    Ok(())
}

// Reports startup failure without panicking inside the packaged application
fn main() {
    if let Err(error) = run() {
        eprintln!("Cairndex desktop could not start: {error}");
    }
}
