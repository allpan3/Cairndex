//! Native save dialog for server-generated export artifacts (plan 1 §10 / plan 3 D5b).
//!
//! This is the **seam only** — M11 owns the export UI and the server-side GIF /
//! contact-sheet pipelines. What the shell contributes is the one thing a browser
//! cannot do: put the artifact exactly where the user chooses, instead of dropping
//! it in the downloads folder.
//!
//! Safety boundary, matching the D3 handoff rule: the destination comes **only**
//! from the OS save dialog. The web layer supplies bytes and a suggested file
//! *name* — never a path — so no client-supplied absolute path is ever trusted,
//! and the shell cannot be steered into overwriting an arbitrary file.

use std::path::{Path, PathBuf};

use tauri::{async_runtime, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::mappings::MappingError;

/// Reduces a caller-supplied suggestion to a bare filename.
///
/// The dialog treats its argument as a name rather than a path, but the web layer
/// must not be able to influence the directory even in principle, so any path
/// structure is stripped here. Returns `None` when nothing usable remains.
pub(crate) fn sanitize_file_name(suggested: &str) -> Option<String> {
    let trimmed = suggested.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Take the last component under BOTH separators: a Windows-style name reaching
    // a Unix host would otherwise keep its backslash segments intact.
    let name = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim()
        // Strip characters that are path-significant or illegal on common systems.
        .replace(['\0', ':'], "");
    let name = name.trim_start_matches('.').trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_owned())
}

/// Saves one export artifact to a location the user picks in the native dialog.
///
/// Returns the chosen path on success and `None` when the user cancelled, so the
/// caller can distinguish "declined" from "failed" without an error round-trip.
#[tauri::command]
pub(crate) async fn save_export_file<R: Runtime>(
    app: AppHandle<R>,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, MappingError> {
    let name = sanitize_file_name(&suggested_name).ok_or_else(MappingError::host_action_failed)?;

    let (sender, receiver) = async_runtime::channel::<Option<PathBuf>>(1);
    app.dialog()
        .file()
        .set_file_name(&name)
        .save_file(move |path| {
            let _ = sender.blocking_send(path.and_then(|p| p.into_path().ok()));
        });
    let mut receiver = receiver;
    let Some(chosen) = receiver.recv().await.flatten() else {
        // Cancelled: not an error, and nothing was written.
        return Ok(None);
    };

    // Writing can block on a slow or network volume, so keep it off the IPC thread
    // exactly as the D3 review required for the mount-touching host commands.
    let written = async_runtime::spawn_blocking(move || write_artifact(&chosen, &bytes))
        .await
        .map_err(|_| MappingError::host_action_failed())??;
    Ok(Some(written))
}

/// Writes the artifact and returns the path as a string.
fn write_artifact(path: &Path, bytes: &[u8]) -> Result<String, MappingError> {
    std::fs::write(path, bytes).map_err(|_| MappingError::host_action_failed())?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(MappingError::unsupported_path_encoding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_an_ordinary_name() {
        assert_eq!(sanitize_file_name("clip.gif").as_deref(), Some("clip.gif"));
        assert_eq!(
            sanitize_file_name("  My Movie — sheet.jpg  ").as_deref(),
            Some("My Movie — sheet.jpg")
        );
    }

    // The destination must come from the dialog alone; a suggestion carrying path
    // structure is reduced to its final component rather than honored.
    #[test]
    fn strips_path_structure_from_a_suggestion() {
        assert_eq!(sanitize_file_name("/etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(
            sanitize_file_name("../../secrets.txt").as_deref(),
            Some("secrets.txt")
        );
        assert_eq!(
            sanitize_file_name(r"C:\Windows\System32\evil.dll").as_deref(),
            Some("evil.dll")
        );
        // A Windows-style path arriving on a Unix host keeps no backslash segments.
        assert_eq!(
            sanitize_file_name(r"..\..\evil.exe").as_deref(),
            Some("evil.exe")
        );
    }

    #[test]
    fn rejects_names_that_reduce_to_nothing() {
        assert_eq!(sanitize_file_name(""), None);
        assert_eq!(sanitize_file_name("   "), None);
        assert_eq!(sanitize_file_name("/"), None);
        assert_eq!(sanitize_file_name("///"), None);
        // A leading-dot-only name would create a hidden file with no stem.
        assert_eq!(sanitize_file_name("..."), None);
    }

    #[test]
    fn removes_characters_that_are_path_significant() {
        assert_eq!(
            sanitize_file_name("clip:1.gif").as_deref(),
            Some("clip1.gif")
        );
        assert_eq!(sanitize_file_name("a\0b.gif").as_deref(), Some("ab.gif"));
    }

    #[test]
    fn writes_bytes_to_the_chosen_path() {
        // Isolated scratch directory without a test-only dependency, matching the
        // convention in `mappings.rs`.
        let dir = std::env::temp_dir().join(format!("cairndex-exports-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch directory");
        let target = dir.join("out.gif");

        let written = write_artifact(&target, b"GIF89a").unwrap();
        assert_eq!(written, target.to_str().unwrap());
        assert_eq!(std::fs::read(&target).unwrap(), b"GIF89a");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
