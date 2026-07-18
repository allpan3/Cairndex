use std::{path::PathBuf, sync::mpsc};

use serde::Deserialize;
use tauri::{async_runtime, AppHandle, Runtime, Window};

use crate::mappings::{self, MappingError};

// A drag preview image is mandatory on macOS/Windows. Embed the app icon at
// compile time so the packaged shell never depends on a runtime asset path.
const DRAG_PREVIEW_ICON: &[u8] = include_bytes!("../icons/32x32.png");

// One server-described file requested for a native drag-out. It crosses the IPC
// boundary as an id plus a server-provided library-relative path — never an
// absolute path. The shell owns path resolution (plan 3 §5/§6), so the web layer
// cannot inject a filesystem path here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragOutItem {
    library_id: String,
    relative_path: String,
}

// Puts real absolute paths on the OS drag pasteboard for the requested files so
// Finder and other apps receive them. Every path is resolved and validated
// through the shell-owned library mapping exactly as reveal/open are (§5).
#[tauri::command]
pub(crate) async fn start_file_drag<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    items: Vec<DragOutItem>,
) -> Result<(), MappingError> {
    let resolver = app.clone();
    // Resolve + validate off the IPC thread: canonicalizing a path on an offline
    // SMB mount can stall for the full mount timeout and must never block the UI.
    let paths = async_runtime::spawn_blocking(move || resolve_drag_paths(&resolver, &items))
        .await
        .map_err(|_| MappingError::host_action_failed())??;

    // The native drag session has to be created on the main thread.
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(begin_native_drag(&window, paths));
    })
    .map_err(|_| MappingError::host_action_failed())?;
    rx.recv().map_err(|_| MappingError::host_action_failed())?
}

// Resolves every requested item to a validated absolute path. Missing or
// unavailable members are skipped so a bundle with one vanished file still drags
// the rest ("offered when mapped and files available", §6); the whole drag fails
// only when nothing resolves, surfacing the first structured rejection.
fn resolve_drag_paths<R: Runtime>(
    app: &AppHandle<R>,
    items: &[DragOutItem],
) -> Result<Vec<PathBuf>, MappingError> {
    let mut resolved = Vec::new();
    let mut first_error: Option<MappingError> = None;
    for item in items {
        match mappings::resolve_library_path(app, &item.library_id, &item.relative_path) {
            Ok(path) => resolved.push(path),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if resolved.is_empty() {
        Err(first_error.unwrap_or_else(MappingError::no_files_available))
    } else {
        Ok(resolved)
    }
}

// Starts the OS drag with the pre-validated absolute paths through the
// cross-platform `drag` engine. The only OS-conditional edge is obtaining the
// native window handle (§2.1): GTK on Linux, the raw window handle elsewhere.
fn begin_native_drag<R: Runtime>(
    window: &Window<R>,
    paths: Vec<PathBuf>,
) -> Result<(), MappingError> {
    let item = drag::DragItem::Files(paths);
    let image = drag::Image::Raw(DRAG_PREVIEW_ICON.to_vec());
    let on_drop = |_result: drag::DragResult, _cursor: drag::CursorPosition| {};

    #[cfg(target_os = "linux")]
    let outcome = {
        let gtk_window = window
            .gtk_window()
            .map_err(|_| MappingError::host_action_failed())?;
        drag::start_drag(&gtk_window, item, image, on_drop, drag::Options::default())
    };
    #[cfg(not(target_os = "linux"))]
    let outcome = drag::start_drag(window, item, image, on_drop, drag::Options::default());

    outcome.map_err(|_| MappingError::host_action_failed())
}
