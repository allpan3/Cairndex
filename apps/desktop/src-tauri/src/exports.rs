//! Native save dialog for generated export artifacts (plan 1 §10 / plan 3 D5b).
//!
//! The web layer builds the artifact — a contact sheet on a canvas, a GIF the
//! server encoded — and the shell contributes the one thing a browser cannot:
//! putting it exactly where the user chooses, instead of dropping it in the
//! downloads folder. Landed in D5b as a seam with no callers; both M11 exports
//! now use it.
//!
//! Safety boundary, matching the D3 handoff rule: the destination comes **only**
//! from the OS save dialog. The web layer supplies bytes and a suggested file
//! *name* — never a path — so no client-supplied absolute path is ever trusted,
//! and the shell cannot be steered into overwriting an arbitrary file.

use std::path::{Path, PathBuf};

use tauri::{async_runtime, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

use crate::mappings::{MappingError, STORE_PATH};

/// Where exports land without asking, when the owner has chosen a folder in
/// Settings. Absent (the default) means every save asks via the native dialog.
const EXPORT_DIR_KEY: &str = "exportDir";

/// The configured default export folder, if it is set *and still exists* — a
/// folder deleted since it was chosen falls back to the dialog rather than an
/// error the owner cannot see the reason for.
fn stored_export_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let store = app.store(STORE_PATH).ok()?;
    let value = store.get(EXPORT_DIR_KEY)?;
    let path = PathBuf::from(value.as_str()?);
    path.is_dir().then_some(path)
}

/// A destination inside `dir` that does not overwrite: `name`, then
/// `name (2)`, `name (3)`, … — the same keep-both convention the library's own
/// collision policy uses. Original media safety does not apply here (this is an
/// export folder), but silently replacing the previous export would still lose
/// the owner's file.
fn vacant_destination(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_owned(), format!(".{ext}")),
        _ => (name.to_owned(), String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .expect("the counter is unbounded")
}

/// The configured default export folder, for the Settings display.
#[tauri::command]
pub(crate) fn get_export_dir<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    stored_export_dir(&app).and_then(|p| p.to_str().map(str::to_owned))
}

/// Lets the owner pick (and persist) the default export folder.
///
/// The path enters the store only from the OS folder picker — the web layer can
/// ask for the dialog but never name a path, the same boundary as every other
/// filesystem-touching command.
#[tauri::command]
pub(crate) async fn pick_export_dir<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, MappingError> {
    let (sender, receiver) = async_runtime::channel::<Option<PathBuf>>(1);
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.blocking_send(path.and_then(|p| p.into_path().ok()));
    });
    let mut receiver = receiver;
    let Some(chosen) = receiver.recv().await.flatten() else {
        return Ok(None); // cancelled; the stored value is untouched
    };
    let text = chosen
        .to_str()
        .map(str::to_owned)
        .ok_or_else(MappingError::unsupported_path_encoding)?;
    let store = app
        .store(STORE_PATH)
        .map_err(|_| MappingError::host_action_failed())?;
    store.set(EXPORT_DIR_KEY, serde_json::Value::String(text.clone()));
    Ok(Some(text))
}

/// Back to ask-every-time.
#[tauri::command]
pub(crate) fn clear_export_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), MappingError> {
    let store = app
        .store(STORE_PATH)
        .map_err(|_| MappingError::host_action_failed())?;
    store.delete(EXPORT_DIR_KEY);
    Ok(())
}

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
        // Strip characters that are path-significant or illegal on common systems,
        // so the dialog's prefill is usable as-is on Windows too.
        .replace(['\0', ':', '<', '>', '"', '|', '?', '*'], "");
    let name = name.trim_start_matches('.').trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_owned())
}

/// Header carrying the suggested filename alongside a raw-body artifact.
///
/// Percent-encoded by the caller: an HTTP header value is ASCII-only, and a
/// display title can hold anything — an em dash, CJK, an emoji.
const SUGGESTED_NAME_HEADER: &str = "x-suggested-name";

/// Read the artifact's bytes and its suggested name out of a raw IPC request.
///
/// The bytes travel as the request **body** rather than as a JSON argument.
/// They used to be a JSON number array (`Array.from(bytes)`), which was
/// tolerable for a seam with no callers but turns a few-megabyte GIF into tens
/// of megabytes of JSON serialized on the main thread — flagged in plan 1 §10
/// as the thing to fix before M11 shipped a real export flow, which is now.
/// Split from the `Request` it is read out of purely so it can be tested:
/// `tauri::ipc::Request` has private fields and is constructible only by the
/// runtime, whereas an `InvokeBody` and a `HeaderMap` can both be built here.
/// This is the half of the seam's contract that is ours to get right.
fn artifact_parts(
    body: &tauri::ipc::InvokeBody,
    headers: &tauri::http::HeaderMap,
) -> Result<(String, Vec<u8>), MappingError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        // A JSON body means the web layer sent the old number-array shape, or
        // something else entirely; either way these are not the bytes we want.
        return Err(MappingError::host_action_failed());
    };
    let raw_name = headers
        .get(SUGGESTED_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(raw_name)
        .decode_utf8()
        .map_err(|_| MappingError::host_action_failed())?;
    let name = sanitize_file_name(&decoded).ok_or_else(MappingError::host_action_failed)?;
    Ok((name, bytes.clone()))
}

fn artifact_from(request: &tauri::ipc::Request<'_>) -> Result<(String, Vec<u8>), MappingError> {
    artifact_parts(request.body(), request.headers())
}

/// Saves one export artifact to a location the user picks in the native dialog.
///
/// Returns the chosen path on success and `None` when the user cancelled, so the
/// caller can distinguish "declined" from "failed" without an error round-trip.
#[tauri::command]
pub(crate) async fn save_export_file<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>, MappingError> {
    let (name, bytes) = artifact_from(&request)?;

    // A configured default folder saves straight there (keep-both on a name
    // collision) — that is the whole point of the setting. Unset, or pointing
    // at a folder that no longer exists, falls back to asking.
    if let Some(dir) = stored_export_dir(&app) {
        let destination = vacant_destination(&dir, &name);
        let written = async_runtime::spawn_blocking(move || write_artifact(&destination, &bytes))
            .await
            .map_err(|_| MappingError::host_action_failed())??;
        return Ok(Some(written));
    }

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
    fn a_vacant_destination_keeps_both_with_a_counter() {
        let dir =
            std::env::temp_dir().join(format!("cairndex-exports-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(vacant_destination(&dir, "sheet.jpg"), dir.join("sheet.jpg"));
        std::fs::write(dir.join("sheet.jpg"), b"x").unwrap();
        assert_eq!(
            vacant_destination(&dir, "sheet.jpg"),
            dir.join("sheet (2).jpg")
        );
        std::fs::write(dir.join("sheet (2).jpg"), b"x").unwrap();
        assert_eq!(
            vacant_destination(&dir, "sheet.jpg"),
            dir.join("sheet (3).jpg")
        );
        // A dotless name counts whole.
        std::fs::write(dir.join("raw"), b"x").unwrap();
        assert_eq!(vacant_destination(&dir, "raw"), dir.join("raw (2)"));

        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn removes_characters_that_are_path_significant_or_illegal() {
        assert_eq!(
            sanitize_file_name("clip:1.gif").as_deref(),
            Some("clip1.gif")
        );
        assert_eq!(sanitize_file_name("a\0b.gif").as_deref(), Some("ab.gif"));
        // Illegal on Windows; harmless elsewhere, but the prefill should be usable
        // on any host the shell runs on.
        assert_eq!(
            sanitize_file_name(r#"a<b>c"d|e?f*g.gif"#).as_deref(),
            Some("abcdefg.gif")
        );
    }

    // The name rides in an ASCII-only header, so the web layer percent-encodes
    // it. A title with an em dash or CJK must survive the round trip; anything
    // that decodes to path structure must not.
    #[test]
    fn decodes_a_percent_encoded_suggested_name() {
        let decode = |raw: &str| {
            percent_encoding::percent_decode_str(raw)
                .decode_utf8()
                .ok()
                .and_then(|decoded| sanitize_file_name(&decoded))
        };

        assert_eq!(decode("clip.gif").as_deref(), Some("clip.gif"));
        assert_eq!(
            decode("My%20Movie%20%E2%80%94%20clip.gif").as_deref(),
            Some("My Movie — clip.gif")
        );
        assert_eq!(
            decode("%E6%98%A0%E7%94%BB.gif").as_deref(),
            Some("映画.gif")
        );
        // Encoded separators are still separators once decoded.
        assert_eq!(decode("..%2F..%2Fevil.gif").as_deref(), Some("evil.gif"));
        assert_eq!(decode("%2Fetc%2Fpasswd").as_deref(), Some("passwd"));
        assert_eq!(decode(""), None);
    }

    /// A raw body with a percent-encoded name header, as the web layer sends.
    fn raw_request(name: &str, bytes: &[u8]) -> (tauri::ipc::InvokeBody, tauri::http::HeaderMap) {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(SUGGESTED_NAME_HEADER, name.parse().unwrap());
        (tauri::ipc::InvokeBody::Raw(bytes.to_vec()), headers)
    }

    // The seam's own half of the contract: bytes arrive as the body, the name
    // as an encoded header. The JS-to-Rust hop itself can only be exercised in
    // a running app, but everything after it is pinned here.
    #[test]
    fn reads_the_artifact_out_of_a_raw_body_and_its_header() {
        let (body, headers) = raw_request("My%20Movie%20%E2%80%94%20clip.gif", b"GIF89a");
        let (name, bytes) = artifact_parts(&body, &headers).unwrap();

        assert_eq!(name, "My Movie — clip.gif");
        assert_eq!(bytes, b"GIF89a");
    }

    // A JSON body is the old number-array shape, or something unrelated —
    // either way it is not the artifact, and guessing would write nonsense.
    #[test]
    fn refuses_a_json_body() {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(SUGGESTED_NAME_HEADER, "clip.gif".parse().unwrap());
        let body = tauri::ipc::InvokeBody::Json(serde_json::json!([71, 73, 70]));

        assert!(artifact_parts(&body, &headers).is_err());
    }

    #[test]
    fn refuses_a_body_whose_name_header_is_missing_or_unusable() {
        let empty = tauri::http::HeaderMap::new();
        let body = tauri::ipc::InvokeBody::Raw(b"GIF89a".to_vec());
        assert!(artifact_parts(&body, &empty).is_err());

        // Decodes to path structure: reduced to its last component, never
        // honored as a directory.
        let (raw, headers) = raw_request("..%2F..%2Fevil.gif", b"GIF89a");
        assert_eq!(artifact_parts(&raw, &headers).unwrap().0, "evil.gif");
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
