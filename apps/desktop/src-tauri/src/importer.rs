//! Copying dropped files into a library (plan 4 W5, ADR-0013 §7).
//!
//! The web layer cannot do this itself. In the shell, Tauri intercepts an OS
//! drop before the webview sees it, so the drop arrives as *absolute paths* —
//! and a browser cannot turn an absolute path into a readable `File`. Reading
//! the bytes is therefore the shell's job, and this module is the only place it
//! happens.
//!
//! **Two rules keep that from becoming "the web layer can exfiltrate any file
//! on the disk".**
//!
//! 1. **Only paths the user actually dropped.** The shell records the paths
//!    from each OS drop itself (`remember_drop`, wired to the window event) and
//!    refuses to upload anything it has not seen. The web layer names a path it
//!    was already given; it cannot invent one. This is the same shape as
//!    `PendingPick` — the shell holds the authority, the caller holds a
//!    reference — and it matters more here than there, because statting a path
//!    leaks its existence while uploading one leaks its contents.
//! 2. **The destination is not the caller's to choose.** The server URL and
//!    bearer come from the media proxy's own configuration, which the shell
//!    derives (`media_proxy::target_for`). A caller cannot point an upload at a
//!    server of its choosing.
//!
//! The upload streams from the file handle rather than reading it into memory:
//! a 60 GB video imports with a constant footprint on both ends.

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use tauri::{async_runtime, AppHandle, Emitter, Runtime, State};
use url::Url;

use crate::mappings;
use crate::media_proxy::MediaProxy;

/// How often the upload reports bytes-sent to the webview. Frequent enough for a
/// smooth bar, rare enough that a fast local upload does not flood the event bus.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
/// The event the webview listens on for per-file upload progress.
const PROGRESS_EVENT: &str = "import-progress";

/// One upload-progress tick. `path` identifies which dropped file this is about,
/// so the web layer can match it to the file it is showing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    path: String,
    sent: u64,
    total: u64,
}

/// Wraps the file handle so streaming it to the server also reports how far the
/// upload has got. reqwest reads this as the request body; every read advances
/// the counter, and a throttled tick is emitted so the UI can draw a bar and a
/// rate. Errors emitting are ignored — a missed tick must never fail an upload.
struct ProgressReader<R: Runtime> {
    inner: File,
    app: AppHandle<R>,
    path: String,
    sent: u64,
    total: u64,
    last_emit: Instant,
}

impl<R: Runtime> Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.sent += read as u64;
        let now = Instant::now();
        // Emit on the throttle interval, and always on the final read (EOF), so
        // the bar reliably reaches 100% rather than stopping a tick short.
        if read == 0 || now.duration_since(self.last_emit) >= PROGRESS_INTERVAL {
            self.last_emit = now;
            let _ = self.app.emit(
                PROGRESS_EVENT,
                ImportProgress {
                    path: self.path.clone(),
                    sent: self.sent,
                    total: self.total,
                },
            );
        }
        Ok(read)
    }
}

// Generous: an import is bounded by the size of the file and the speed of the
// link, not by anything this shell controls. Long enough that a large file over
// a slow share is not cut off, finite so a wedged server does not hang forever.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Paths from the most recent OS drop, and the only ones that may be uploaded.
///
/// Replaced rather than accumulated on each drop: a path the user dropped ten
/// minutes ago into a different library is not something a later request should
/// still be able to reach for.
#[derive(Default)]
pub(crate) struct DroppedFiles {
    inner: Mutex<HashSet<PathBuf>>,
}

impl DroppedFiles {
    /// Record one OS drop, replacing whatever the previous drop left.
    pub(crate) fn remember(&self, paths: &[PathBuf]) {
        let canonical = paths
            .iter()
            .filter_map(|path| std::fs::canonicalize(path).ok())
            .collect();
        if let Ok(mut guard) = self.inner.lock() {
            *guard = canonical;
        }
    }

    /// Whether this exact file was in that drop, compared after canonicalizing
    /// so a symlink or a `/tmp` → `/private/tmp` alias cannot smuggle a
    /// different file past a matching string.
    fn contains(&self, path: &Path) -> bool {
        let Ok(canonical) = std::fs::canonicalize(path) else {
            return false;
        };
        self.inner
            .lock()
            .map(|guard| guard.contains(&canonical))
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().map(|guard| guard.len()).unwrap_or(0)
    }
}

/// Why an import could not be performed by the shell.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportError {
    /// Machine-readable, so the web layer can route a collision to the prompt
    /// rather than to an error toast.
    code: String,
    message: String,
    /// The name already in the way, for a `path_conflict`.
    conflicting_name: Option<String>,
}

impl ImportError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            conflicting_name: None,
        }
    }

    fn conflict(message: impl Into<String>, name: Option<String>) -> Self {
        Self {
            code: "path_conflict".to_string(),
            message: message.into(),
            conflicting_name: name,
        }
    }
}

/// What the server said about a completed import, passed straight through.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportOutcome {
    /// The library-relative path it landed at — not always the name that was
    /// sent, because "keep both" settles on a different one.
    path: String,
    operation_id: String,
    size_bytes: u64,
    skipped: bool,
}

/// Record an OS drop's paths so they become uploadable. Called from the window
/// event handler, never from the web layer.
pub(crate) fn remember_drop(dropped: &DroppedFiles, paths: &[PathBuf]) {
    dropped.remember(paths);
}

/// Stream one dropped file into a library through the server's import endpoint.
///
/// One file per call, mirroring the endpoint: each import gets its own
/// collision answer and its own undo, which a batched call could not offer.
#[tauri::command]
pub(crate) async fn import_dropped_file<R: Runtime>(
    app: AppHandle<R>,
    proxy: State<'_, MediaProxy>,
    dropped: State<'_, DroppedFiles>,
    library_id: String,
    path: String,
    dest_dir: String,
    on_conflict: Option<String>,
) -> Result<ImportOutcome, ImportError> {
    // Shape-checked before it is used to build a URL. Not a user-facing mistake:
    // the id comes from the web layer, so a malformed one means something other
    // than the library selector produced it.
    if !mappings::library_id_is_safe(&library_id) {
        return Err(ImportError::new("invalid_library", "No library selected."));
    }
    let source = PathBuf::from(&path);
    if !dropped.contains(&source) {
        // Not a refusal the user can act on, because a user never causes it:
        // it means something asked to upload a file that was not dropped.
        return Err(ImportError::new(
            "not_dropped",
            "That file was not part of a drop into this window.",
        ));
    }
    let Some((server_url, token)) = proxy.target_for(&library_id) else {
        return Err(ImportError::new(
            "no_server",
            "This window is not connected to a Cairndex server yet.",
        ));
    };
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| ImportError::new("unnamed_file", "That file has no usable name."))?;

    // Reading the file and waiting on the upload are both blocking; keep them
    // off the IPC thread so the window stays responsive during a large import.
    async_runtime::spawn_blocking(move || {
        upload(
            app,
            &server_url,
            token.as_deref(),
            &library_id,
            &source,
            &name,
            &dest_dir,
            on_conflict,
        )
    })
    .await
    .map_err(|_| ImportError::new("upload_task_failed", "The import could not be started."))?
}

#[allow(clippy::too_many_arguments)]
fn upload<R: Runtime>(
    app: AppHandle<R>,
    server_url: &Url,
    token: Option<&str>,
    library_id: &str,
    source: &Path,
    name: &str,
    dest_dir: &str,
    on_conflict: Option<String>,
) -> Result<ImportOutcome, ImportError> {
    let handle = File::open(source)
        .map_err(|error| ImportError::new("unreadable_file", readable(&error)))?;
    let size = handle
        .metadata()
        .map(|meta| meta.len())
        .map_err(|error| ImportError::new("unreadable_file", readable(&error)))?;

    let target = import_url(
        server_url,
        library_id,
        name,
        dest_dir,
        on_conflict.as_deref(),
    )
    .map_err(|error| ImportError::new("bad_server_url", error))?;
    let client = Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .map_err(|error| ImportError::new("client_failed", error.to_string()))?;

    // An opening tick at zero, so the file shows immediately at 0% rather than
    // only appearing once the first chunk has flushed.
    let path = source.to_string_lossy().into_owned();
    let _ = app.emit(
        PROGRESS_EVENT,
        ImportProgress {
            path: path.clone(),
            sent: 0,
            total: size,
        },
    );
    let reader = ProgressReader {
        inner: handle,
        app,
        path,
        sent: 0,
        total: size,
        last_emit: Instant::now(),
    };

    let mut request = client
        .post(target)
        .header(CONTENT_TYPE, "application/octet-stream")
        // Streams from the handle rather than buffering the file, and sets a
        // real Content-Length so the server is not left guessing.
        .body(reqwest::blocking::Body::sized(reader, size));
    if let Some(token) = token {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    let response = request
        .send()
        .map_err(|error| ImportError::new("upload_failed", readable_request(&error)))?;
    let status = response.status();
    let body: serde_json::Value = response.json().unwrap_or(serde_json::Value::Null);

    if status.is_success() {
        return Ok(ImportOutcome {
            path: string_at(&body, "path").unwrap_or_else(|| name.to_string()),
            operation_id: body
                .get("operation")
                .and_then(|operation| operation.get("id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            size_bytes: body
                .get("size_bytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            skipped: body
                .get("skipped")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        });
    }

    let message = string_at(&body, "message").unwrap_or_else(|| format!("HTTP {status}"));
    let details = body.get("details");
    let conflict = details
        .and_then(|value| value.get("code"))
        .and_then(serde_json::Value::as_str)
        == Some("path_conflict");
    if conflict {
        let conflicting = details
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        return Err(ImportError::conflict(message, conflicting));
    }
    Err(ImportError::new("import_refused", message))
}

/// Build the import URL, preserving any base path the server is mounted under.
///
/// The path is assembled segment by segment rather than by interpolating into a
/// string that is then parsed. Interpolation let a `library_id` carrying `..`,
/// `?` or `/` restructure the URL — and with a server-scoped token attached, that
/// would have pointed an authenticated POST (carrying the file body) at a path
/// nobody chose. Callers shape-check the id too; this is the half that cannot be
/// forgotten at a call site.
fn import_url(
    server_url: &Url,
    library_id: &str,
    filename: &str,
    dest_dir: &str,
    on_conflict: Option<&str>,
) -> Result<Url, String> {
    if !mappings::library_id_is_safe(library_id) {
        return Err("library id is not a valid identifier".to_string());
    }
    let mut url = server_url.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "server URL cannot carry a path".to_string())?;
        // A base URL ending in '/' leaves an empty trailing segment that would
        // otherwise become a '//' in the middle of the path.
        segments.pop_if_empty();
        segments.extend(["api", "v1", "libraries", library_id, "file-ops", "import"]);
    }
    url.query_pairs_mut()
        .append_pair("filename", filename)
        .append_pair("dest_dir", dest_dir)
        .append_pair("on_conflict", on_conflict.unwrap_or("fail"))
        // Copy the file in without bundling it. A drop into a folder is a
        // filesystem action — the file should land there and show in the File
        // Browser, not become a one-file bundle the owner did not ask for.
        .append_pair("link", "false");
    Ok(url)
}

fn string_at(body: &serde_json::Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

// Never echoes the absolute path back — the message reaches the web layer.
fn readable(error: &std::io::Error) -> String {
    error.kind().to_string()
}

fn readable_request(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The server stopped responding during the upload.".to_string()
    } else if error.is_connect() {
        "Could not reach the Cairndex server.".to_string()
    } else {
        "The upload did not complete.".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("cairndex-import-test-{name}"));
        std::fs::write(&path, b"payload").unwrap();
        path
    }

    #[test]
    fn only_dropped_paths_are_uploadable() {
        let dropped = DroppedFiles::default();
        let allowed = temp_file("allowed.mkv");
        let other = temp_file("other.mkv");
        dropped.remember(std::slice::from_ref(&allowed));

        assert!(dropped.contains(&allowed));
        // The whole point: a path the user never dropped cannot be uploaded,
        // even though it plainly exists and is readable.
        assert!(!dropped.contains(&other));
    }

    #[test]
    fn a_later_drop_replaces_the_previous_one() {
        let dropped = DroppedFiles::default();
        let first = temp_file("first.mkv");
        let second = temp_file("second.mkv");

        dropped.remember(std::slice::from_ref(&first));
        dropped.remember(std::slice::from_ref(&second));

        assert_eq!(dropped.len(), 1);
        assert!(dropped.contains(&second));
        // Stale: dropped into a previous context, possibly a different library.
        assert!(!dropped.contains(&first));
    }

    #[test]
    fn a_path_that_does_not_exist_is_never_uploadable() {
        let dropped = DroppedFiles::default();
        let missing = std::env::temp_dir().join("cairndex-import-test-missing.mkv");
        let _ = std::fs::remove_file(&missing);

        dropped.remember(std::slice::from_ref(&missing));

        assert!(!dropped.contains(&missing));
    }

    #[test]
    fn import_url_keeps_a_base_path_and_escapes_the_name() {
        let server = Url::parse("https://nas.example/cairndex").unwrap();

        let url = import_url(
            &server,
            "lib1",
            "my movie (1).mkv",
            "Show/S01",
            Some("replace"),
        )
        .unwrap();

        assert_eq!(
            url.path(),
            "/cairndex/api/v1/libraries/lib1/file-ops/import"
        );
        let query: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert!(query.contains(&("filename".into(), "my movie (1).mkv".into())));
        assert!(query.contains(&("dest_dir".into(), "Show/S01".into())));
        assert!(query.contains(&("on_conflict".into(), "replace".into())));
        // Imports do not auto-bundle: the file lands in the folder, unlinked.
        assert!(query.contains(&("link".into(), "false".into())));
    }

    #[test]
    fn import_url_defaults_to_failing_on_a_collision() {
        let server = Url::parse("http://127.0.0.1:8000").unwrap();

        let url = import_url(&server, "lib1", "a.mkv", "", None).unwrap();

        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "on_conflict" && value == "fail"));
    }

    #[test]
    fn import_url_takes_a_real_ulid_library_id() {
        let server = Url::parse("http://127.0.0.1:8000/").unwrap();

        let url = import_url(&server, "01KY9ZBDHXVPWXGZEDNV7AXPQ2", "a.mkv", "", None).unwrap();

        // A trailing slash on the base must not double up in the middle.
        assert_eq!(
            url.path(),
            "/api/v1/libraries/01KY9ZBDHXVPWXGZEDNV7AXPQ2/file-ops/import"
        );
    }

    #[test]
    fn import_url_refuses_a_library_id_that_would_rewrite_the_path() {
        let server = Url::parse("https://nas.example/cairndex").unwrap();

        // Each of these used to reach the URL verbatim through string
        // interpolation: traversal out of the intended path, a grafted query or
        // fragment, an extra path segment, or a percent-escape.
        for hostile in [
            "..",
            "lib1/../../../file-ops/empty-trash",
            "lib1?on_conflict=replace&x=",
            "lib1#frag",
            "lib1/extra",
            "%2e%2e",
            "",
        ] {
            assert!(
                import_url(&server, hostile, "a.mkv", "", None).is_err(),
                "library id {hostile:?} should be refused"
            );
        }
    }

    #[test]
    fn library_id_shape_accepts_server_ids_and_rejects_separators() {
        assert!(mappings::library_id_is_safe("01KY9ZBDHXVPWXGZEDNV7AXPQ2"));
        assert!(mappings::library_id_is_safe("lib_1-2"));
        for bad in ["", "..", "a/b", "a?b", "a#b", "a%2fb", "a.b", "a b"] {
            assert!(
                !mappings::library_id_is_safe(bad),
                "{bad:?} should be unsafe"
            );
        }
    }
}
