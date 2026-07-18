use tauri::{async_runtime, AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::mappings::{self, MappingError};

// Reveals one server-described file only after resolving its safe local mapping
#[tauri::command]
pub(crate) async fn reveal_file<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    relative_path: String,
) -> Result<(), MappingError> {
    // Offline-mount stats can hang for the full SMB timeout; keep them off the IPC thread
    async_runtime::spawn_blocking(move || {
        let path = mappings::resolve_library_path(&app, &library_id, &relative_path)?;
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|_| MappingError::host_action_failed())
    })
    .await
    .map_err(|_| MappingError::host_action_failed())?
}

// Opens one server-described file only after resolving its safe local mapping
#[tauri::command]
pub(crate) async fn open_file<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    relative_path: String,
) -> Result<(), MappingError> {
    // Offline-mount stats can hang for the full SMB timeout; keep them off the IPC thread
    async_runtime::spawn_blocking(move || {
        let path = mappings::resolve_library_path(&app, &library_id, &relative_path)?;
        let path = path
            .to_str()
            .ok_or_else(MappingError::unsupported_path_encoding)?;
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|_| MappingError::host_action_failed())
    })
    .await
    .map_err(|_| MappingError::host_action_failed())?
}
