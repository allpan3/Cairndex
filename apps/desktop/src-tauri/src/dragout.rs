use std::{collections::BTreeMap, path::PathBuf};

use serde::Deserialize;
use tauri::{async_runtime, AppHandle, Emitter, Runtime, Window};

use crate::mappings::{self, MappingError};

// A drag preview image is mandatory on macOS/Windows. Embed the app icon at
// compile time so the packaged shell never depends on a runtime asset path.
const DRAG_PREVIEW_ICON: &[u8] = include_bytes!("../icons/32x32.png");

// Emitted when a shell-initiated drag-out session ends (drop or cancel) so the SPA
// can clear its "drag-out in flight" guard and stop ignoring its own file drops.
pub(crate) const DRAG_ENDED_EVENT: &str = "cairndex://drag-out-ended";

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
// through the shell-owned library mapping exactly as reveal/open do (§5).
#[tauri::command]
pub(crate) async fn start_file_drag<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    items: Vec<DragOutItem>,
    // Caller-assigned id echoed back in DRAG_ENDED_EVENT, so the SPA clears the
    // guard only for the drag it started and ignores a stale event (D4 review P0-4).
    drag_id: u64,
) -> Result<(), MappingError> {
    let resolver = app.clone();
    // Resolve + validate off the IPC thread: canonicalizing a path on an offline
    // SMB mount can stall for the full mount timeout and must never block the UI.
    let paths = async_runtime::spawn_blocking(move || resolve_drag_paths(&resolver, &items))
        .await
        .map_err(|_| MappingError::drag_action_failed())??;

    // The native drag session has to be created on the main thread. Bridge its
    // synchronous result back to this async command without blocking a worker.
    let (tx, mut rx) = async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.try_send(begin_native_drag(&window, paths, drag_id));
    })
    .map_err(|_| MappingError::drag_action_failed())?;
    rx.recv()
        .await
        .unwrap_or_else(|| Err(MappingError::drag_action_failed()))
}

// Resolves every requested item to a validated absolute path. The mount for each
// distinct library is canonicalized and identity-re-proven once (not once per
// file), mirroring reverse-mapping. Missing or unavailable members are skipped so
// a bundle with one vanished file still drags the rest ("offered when mapped and
// files available", §6); the whole drag fails only when nothing resolves,
// surfacing the first structured rejection.
fn resolve_drag_paths<R: Runtime>(
    app: &AppHandle<R>,
    items: &[DragOutItem],
) -> Result<Vec<PathBuf>, MappingError> {
    let mappings = mappings::load_mappings(app)?;
    // Per distinct library id: Some(canonical root) once verified, None once it has
    // failed — so an offline mount is stat-ed once, not once per dragged file.
    let mut roots: BTreeMap<&str, Option<PathBuf>> = BTreeMap::new();
    let mut resolved = Vec::new();
    let mut first_error: Option<MappingError> = None;

    for item in items {
        if !roots.contains_key(item.library_id.as_str()) {
            let root = match mappings::verified_root_for(&mappings, &item.library_id) {
                Ok(root) => Some(root),
                Err(error) => {
                    capture(&mut first_error, error);
                    None
                }
            };
            roots.insert(item.library_id.as_str(), root);
        }
        let Some(root) = roots.get(item.library_id.as_str()).and_then(Clone::clone) else {
            continue;
        };
        match mappings::resolve_within_verified_root(&root, &item.relative_path) {
            Ok(path) => resolved.push(path),
            Err(error) => capture(&mut first_error, error),
        }
    }

    if resolved.is_empty() {
        Err(first_error.unwrap_or_else(MappingError::no_files_available))
    } else {
        Ok(resolved)
    }
}

// Records the first rejection so a fully-failed drag reports a real reason
fn capture(slot: &mut Option<MappingError>, error: MappingError) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

// Starts the OS drag with the pre-validated absolute paths through the
// cross-platform `drag` engine. The only OS-conditional edge is obtaining the
// native window handle (§2.1): GTK on Linux, the raw window handle elsewhere.
fn begin_native_drag<R: Runtime>(
    window: &Window<R>,
    paths: Vec<PathBuf>,
    drag_id: u64,
) -> Result<(), MappingError> {
    let item = drag::DragItem::Files(paths);
    let image = drag::Image::Raw(DRAG_PREVIEW_ICON.to_vec());
    // Notify the SPA when this drag ends so it stops ignoring its own drops (P1-4),
    // echoing the caller's id so a stale event can't clear a later drag (P0-4).
    let emitter = window.clone();
    let on_drop = move |_result: drag::DragResult, _cursor: drag::CursorPosition| {
        let _ = emitter.emit(DRAG_ENDED_EVENT, drag_id);
    };

    #[cfg(target_os = "linux")]
    let outcome = {
        let gtk_window = window
            .gtk_window()
            .map_err(|_| MappingError::drag_action_failed())?;
        drag::start_drag(&gtk_window, item, image, on_drop, drag::Options::default())
    };
    #[cfg(not(target_os = "linux"))]
    let outcome = drag::start_drag(window, item, image, on_drop, drag::Options::default());

    outcome.map_err(|_| MappingError::drag_action_failed())
}
