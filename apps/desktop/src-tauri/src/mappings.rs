use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "cairndex-settings.json";
const MAPPINGS_KEY: &str = "libraryMappings";

// Identifies one stable rejection class for the web UI
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MappingErrorCode {
    InvalidLibraryId,
    InvalidRelativePath,
    InvalidLibraryRoot,
    InvalidManifest,
    LibraryMismatch,
    LibraryUnmapped,
    VolumeNotMounted,
    PathNotFound,
    PathOutsideLibrary,
    MappingStoreUnavailable,
    HostActionFailed,
    DragActionFailed,
    NoDraggableFiles,
}

// Returns structured, path-free failures across the Tauri command boundary
#[derive(Debug, Serialize)]
pub(crate) struct MappingError {
    code: MappingErrorCode,
    message: String,
}

impl MappingError {
    // Hands the user-facing text to another module's error type
    pub(crate) fn into_message(self) -> String {
        self.message
    }

    // Builds one structured rejection without exposing local filesystem paths
    fn new(code: MappingErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    // Wraps opener failures after the path has passed every safety check
    pub(crate) fn host_action_failed() -> Self {
        Self::new(
            MappingErrorCode::HostActionFailed,
            "The operating system could not open this file.",
        )
    }

    // Reports a drag-out request in which none of the requested files resolved
    pub(crate) fn no_files_available() -> Self {
        Self::new(
            MappingErrorCode::NoDraggableFiles,
            "None of these files are available to drag.",
        )
    }

    // Wraps a failure to start the native drag session (distinct from reveal/open)
    pub(crate) fn drag_action_failed() -> Self {
        Self::new(
            MappingErrorCode::DragActionFailed,
            "The file drag could not be started.",
        )
    }

    // Rejects a canonical path the string-only opener interface cannot preserve
    pub(crate) fn unsupported_path_encoding() -> Self {
        Self::new(
            MappingErrorCode::InvalidRelativePath,
            "The mapped file uses an unsupported path encoding.",
        )
    }

    // Reports a failed background store task without exposing runtime details
    fn store_task_failed() -> Self {
        Self::new(
            MappingErrorCode::MappingStoreUnavailable,
            "Library mappings could not be loaded.",
        )
    }
}

// Reads only the portable identity needed to validate a selected library root
#[derive(Deserialize)]
struct LibraryManifest {
    library_uuid: String,
    // Optional: only the folder picker reads it, and an older manifest that
    // predates the field must still validate for reveal/open.
    #[serde(default)]
    display_name: Option<String>,
}

// Couples one stored local root to the portable identity proven at locate time
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MappingRecord {
    local_root: String,
    library_uuid: String,
}

// Requires the server-owned registry key used to select a local mapping
fn validate_library_id(library_id: &str) -> Result<(), MappingError> {
    if library_id.is_empty() {
        return Err(MappingError::new(
            MappingErrorCode::InvalidLibraryId,
            "The server library identity is missing.",
        ));
    }
    Ok(())
}

// Rejects client paths before they are ever joined to a local filesystem root
fn validate_relative_path(relative_path: &str) -> Result<&Path, MappingError> {
    let path = Path::new(relative_path);
    let mut has_normal_component = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal_component = true,
            Component::Prefix(_)
            | Component::RootDir
            | Component::ParentDir
            | Component::CurDir => {
                return Err(MappingError::new(
                    MappingErrorCode::InvalidRelativePath,
                    "The file path is not a safe library-relative path.",
                ));
            }
        }
    }
    if !has_normal_component {
        return Err(MappingError::new(
            MappingErrorCode::InvalidRelativePath,
            "The file path is empty.",
        ));
    }
    Ok(path)
}

// Canonicalizes a configured mount root or reports the removable-volume state
fn canonicalize_root(local_root: &Path) -> Result<PathBuf, MappingError> {
    let root = fs::canonicalize(local_root).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            MappingError::new(
                MappingErrorCode::VolumeNotMounted,
                "Volume not mounted. Reconnect it and try again.",
            )
        } else {
            MappingError::new(
                MappingErrorCode::InvalidLibraryRoot,
                "The mapped library folder is unavailable.",
            )
        }
    })?;
    if !root.is_dir() {
        return Err(MappingError::new(
            MappingErrorCode::InvalidLibraryRoot,
            "The selected library root is not a folder.",
        ));
    }
    Ok(root)
}

// Requires the portable manifest identity a mapping is proven against
fn validate_library_uuid(library_uuid: &str) -> Result<(), MappingError> {
    if library_uuid.is_empty() {
        return Err(MappingError::new(
            MappingErrorCode::InvalidLibraryId,
            "The server library's portable identity is missing.",
        ));
    }
    Ok(())
}

// Reads and parses a candidate folder's library manifest.
//
// Split out so discovering an unknown library (`pick_library_folder`) and
// re-proving a known one (`validate_library_root`) apply exactly the same
// parsing and the same failure wording — a folder that is "not a Cairndex
// library" should say so identically whichever path noticed.
fn read_library_manifest(root: &Path) -> Result<LibraryManifest, MappingError> {
    let manifest_path = root.join(".cairndex").join("manifest.json");
    let bytes = fs::read(manifest_path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            MappingError::new(
                MappingErrorCode::InvalidManifest,
                "The selected folder is not a Cairndex library.",
            )
        } else {
            MappingError::new(
                MappingErrorCode::InvalidManifest,
                "The selected library manifest could not be read.",
            )
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        MappingError::new(
            MappingErrorCode::InvalidManifest,
            "The selected library manifest is invalid.",
        )
    })
}

// Proves that a picked folder is the portable library the server described
fn validate_library_root(
    local_root: &Path,
    expected_library_uuid: &str,
) -> Result<PathBuf, MappingError> {
    validate_library_uuid(expected_library_uuid)?;
    let root = canonicalize_root(local_root)?;
    let manifest = read_library_manifest(&root)?;
    if !manifest
        .library_uuid
        .eq_ignore_ascii_case(expected_library_uuid)
    {
        return Err(MappingError::new(
            MappingErrorCode::LibraryMismatch,
            "The selected folder belongs to a different Cairndex library.",
        ));
    }
    Ok(root)
}

// Re-proves library identity at handoff time, then containment plus existence.
// Relative-path validation runs before the manifest re-proof so a malformed client
// path is rejected as such regardless of mount state.
pub(crate) fn resolve_verified_path(
    local_root: &Path,
    expected_library_uuid: &str,
    relative_path: &str,
) -> Result<PathBuf, MappingError> {
    let relative = validate_relative_path(relative_path)?;
    let root = validate_library_root(local_root, expected_library_uuid)?;
    finish_resolve(&root, relative)
}

// Resolves one relative path against a root whose identity/availability was
// already proven — used when validating many files against one library (drag-out)
// so the mount is canonicalized and re-proven once, not once per file (drag-out).
pub(crate) fn resolve_within_verified_root(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, MappingError> {
    let relative = validate_relative_path(relative_path)?;
    finish_resolve(root, relative)
}

// Canonicalizes root+relative and enforces containment (the symlink-escape check)
fn finish_resolve(root: &Path, relative: &Path) -> Result<PathBuf, MappingError> {
    let candidate = fs::canonicalize(root.join(relative)).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            MappingError::new(
                MappingErrorCode::PathNotFound,
                "The mapped file does not exist.",
            )
        } else {
            MappingError::new(
                MappingErrorCode::InvalidRelativePath,
                "The mapped file path could not be resolved.",
            )
        }
    })?;
    if !candidate.starts_with(root) {
        return Err(MappingError::new(
            MappingErrorCode::PathOutsideLibrary,
            "The mapped file escapes the library root.",
        ));
    }
    Ok(candidate)
}

// Identity-verifies one library's canonical root from already-loaded mappings,
// without resolving any file — the once-per-library step for a multi-file drag-out.
pub(crate) fn verified_root_for(
    mappings: &BTreeMap<String, MappingRecord>,
    library_id: &str,
) -> Result<PathBuf, MappingError> {
    validate_library_id(library_id)?;
    let record = mappings.get(library_id).ok_or_else(|| {
        MappingError::new(
            MappingErrorCode::LibraryUnmapped,
            "This library is not located on this computer.",
        )
    })?;
    validate_library_root(Path::new(&record.local_root), &record.library_uuid)
}

// Loads the complete shell-owned library-id to mapping-record map
pub(crate) fn load_mappings<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<BTreeMap<String, MappingRecord>, MappingError> {
    let store = app.store(STORE_PATH).map_err(|_| {
        MappingError::new(
            MappingErrorCode::MappingStoreUnavailable,
            "Library mappings could not be loaded.",
        )
    })?;
    match store.get(MAPPINGS_KEY) {
        Some(value) => {
            let raw: BTreeMap<String, serde_json::Value> =
                serde_json::from_value(value).map_err(|_| {
                    MappingError::new(
                        MappingErrorCode::MappingStoreUnavailable,
                        "Library mappings are invalid.",
                    )
                })?;
            // Entries without a proven identity (pre-release root-only strings)
            // surface as unmapped so the owner re-locates them once
            Ok(raw
                .into_iter()
                .filter_map(|(library_id, value)| {
                    serde_json::from_value::<MappingRecord>(value)
                        .ok()
                        .map(|record| (library_id, record))
                })
                .collect())
        }
        None => Ok(BTreeMap::new()),
    }
}

// Persists all mappings atomically through the existing shell settings store
fn save_mappings<R: Runtime>(
    app: &AppHandle<R>,
    mappings: &BTreeMap<String, MappingRecord>,
) -> Result<(), MappingError> {
    let store = app.store(STORE_PATH).map_err(|_| {
        MappingError::new(
            MappingErrorCode::MappingStoreUnavailable,
            "Library mappings could not be saved.",
        )
    })?;
    store.set(
        MAPPINGS_KEY,
        serde_json::to_value(mappings).map_err(|_| {
            MappingError::new(
                MappingErrorCode::MappingStoreUnavailable,
                "Library mappings could not be saved.",
            )
        })?,
    );
    store.save().map_err(|_| {
        MappingError::new(
            MappingErrorCode::MappingStoreUnavailable,
            "Library mappings could not be saved.",
        )
    })
}

// Returns the configured local root without resolving any media path
#[tauri::command]
pub(crate) async fn get_library_mapping<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<Option<String>, MappingError> {
    validate_library_id(&library_id)?;
    // First store access reads the settings file; keep that off the IPC thread
    async_runtime::spawn_blocking(move || {
        Ok(load_mappings(&app)?
            .get(&library_id)
            .map(|record| record.local_root.clone()))
    })
    .await
    .map_err(|_| MappingError::store_task_failed())?
}

/// A library folder the user picked, resolved but **not** exposed to the web.
///
/// The absolute path stays inside the shell. Handing it to the web layer would
/// invert plan 3 §5 in the direction that actually matters: `reverse_map_paths`
/// only echoes paths the web already supplied, whereas this one the shell
/// *originates*. Once it were in web state nothing could bound where it went —
/// a connection switch between pick and submit, a query cache, an error toast
/// printing a request body. `sidecar::open_library_folder` consumes this
/// in-process instead, so the web layer only ever sees ids.
pub(crate) struct PickedFolder {
    pub(crate) root: PathBuf,
    pub(crate) library_uuid: String,
    /// `None` when the manifest omits it, so the caller can choose its own
    /// fallback (the folder basename) rather than being handed an empty string
    /// that has to be tested for.
    pub(crate) display_name: Option<String>,
}

/// Prompt for an existing Cairndex library folder on this machine (plan 3 D6).
///
/// Unlike `validate_library_root` no library is known yet — this *discovers*
/// one, so the manifest supplies the identity rather than being checked against
/// an expected one. `Ok(None)` means the user cancelled, which is not an error.
pub(crate) fn pick_library_folder<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PickedFolder>, MappingError> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Open Library Folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|_| {
        MappingError::new(
            MappingErrorCode::InvalidLibraryRoot,
            "The selected library folder is not a local filesystem path.",
        )
    })?;
    let root = canonicalize_root(&selected)?;
    let manifest = read_library_manifest(&root)?;
    validate_library_uuid(&manifest.library_uuid)?;
    Ok(Some(PickedFolder {
        root,
        library_uuid: manifest.library_uuid,
        display_name: manifest.display_name,
    }))
}

// Opens a native folder picker, validates manifest identity, then stores the map
#[tauri::command]
pub(crate) async fn locate_library_mapping<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    library_uuid: String,
) -> Result<Option<String>, MappingError> {
    validate_library_id(&library_id)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Locate Cairndex Library")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|_| {
        MappingError::new(
            MappingErrorCode::InvalidLibraryRoot,
            "The selected library folder is not a local filesystem path.",
        )
    })?;
    let root = validate_library_root(&selected, &library_uuid)?;
    let root_text = root
        .to_str()
        .ok_or_else(|| {
            MappingError::new(
                MappingErrorCode::InvalidLibraryRoot,
                "The selected library folder uses an unsupported path encoding.",
            )
        })?
        .to_owned();
    let mut mappings = load_mappings(&app)?;
    mappings.insert(
        library_id,
        MappingRecord {
            local_root: root_text.clone(),
            library_uuid,
        },
    );
    save_mappings(&app, &mappings)?;
    Ok(Some(root_text))
}

// Removes one local mapping without touching the server library or its files
#[tauri::command]
pub(crate) async fn clear_library_mapping<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
) -> Result<(), MappingError> {
    validate_library_id(&library_id)?;
    // Persisting the trimmed map writes the settings file; keep it off the IPC thread
    async_runtime::spawn_blocking(move || {
        let mut mappings = load_mappings(&app)?;
        mappings.remove(&library_id);
        save_mappings(&app, &mappings)
    })
    .await
    .map_err(|_| MappingError::store_task_failed())?
}

// Resolves one command request from its persisted mapping
pub(crate) fn resolve_library_path<R: Runtime>(
    app: &AppHandle<R>,
    library_id: &str,
    relative_path: &str,
) -> Result<PathBuf, MappingError> {
    validate_library_id(library_id)?;
    let mappings = load_mappings(app)?;
    let record = mappings.get(library_id).ok_or_else(|| {
        MappingError::new(
            MappingErrorCode::LibraryUnmapped,
            "This library is not located on this computer.",
        )
    })?;
    resolve_verified_path(
        Path::new(&record.local_root),
        &record.library_uuid,
        relative_path,
    )
}

// Reports the drag-in reverse-mapping outcome for one library, categorized per
// dropped path (plan 3 §6). `inside` holds the library-relative paths of dropped
// regular files within the mapped root (offered to the fast-add flow). `outside`
// echoes the dropped ABSOLUTE paths of regular files that fell outside the root,
// so the plan 4 W5 copy-in seam can act on exactly that subset without re-running
// reverse-map; echoing them is not a new absolute-path leak, since the web layer
// supplied those exact strings from the OS drop event — only *library-internal*
// paths must stay relative. `directories` counts dropped folders (in or out of the
// root): folders aren't recursed yet, so they get their own message rather than the
// "move it into the library" one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReverseMapResult {
    inside: Vec<String>,
    outside: Vec<String>,
    directories: usize,
}

// Reverse-maps absolute Finder paths against one library's local root (plan 3
// §6 drag-in). Paths whose real location is inside the mapped, identity-verified
// root become library-relative paths; everything else is counted as outside.
#[tauri::command]
pub(crate) async fn reverse_map_paths<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    paths: Vec<String>,
) -> Result<ReverseMapResult, MappingError> {
    validate_library_id(&library_id)?;
    // Canonicalizing dropped paths touches the mount; keep it off the IPC thread.
    async_runtime::spawn_blocking(move || {
        let mappings = load_mappings(&app)?;
        let Some(record) = mappings.get(&library_id) else {
            // An un-located library has no local root, so nothing can be inside it;
            // echo every dropped path as outside (the web short-circuits unmapped
            // libraries before calling this, so this is only defensive).
            return Ok(ReverseMapResult {
                inside: Vec::new(),
                outside: paths.clone(),
                directories: 0,
            });
        };
        // Re-prove identity + availability before attributing any file to this
        // library (mirrors the handoff re-proof; offline roots surface as
        // volume_not_mounted rather than silently mapping nothing).
        let root = validate_library_root(Path::new(&record.local_root), &record.library_uuid)?;
        Ok(reverse_map_under_root(&root, &paths))
    })
    .await
    .map_err(|_| MappingError::store_task_failed())?
}

// Categorizes each dropped absolute path against the given canonical root: an
// in-library regular file (→ relative path), an out-of-library regular file (→ the
// dropped absolute echoed back), or a directory (→ counted).
fn reverse_map_under_root(root: &Path, paths: &[String]) -> ReverseMapResult {
    let mut inside = Vec::new();
    let mut outside = Vec::new();
    let mut directories = 0;
    for raw in paths {
        match categorize_drop(root, raw) {
            DropCategory::Inside(relative) => inside.push(relative),
            DropCategory::Outside => outside.push(raw.clone()),
            DropCategory::Directory => directories += 1,
        }
    }
    ReverseMapResult {
        inside,
        outside,
        directories,
    }
}

// One dropped path's category relative to a library root.
enum DropCategory {
    // A regular file inside the root, as its forward-slash library-relative path.
    Inside(String),
    // A regular file outside the root, a non-existent path, or one that can't be
    // expressed as a UTF-8 relative path (the caller echoes the dropped absolute).
    Outside,
    // Any directory (in or out of the root): folders aren't recursed in D4.
    Directory,
}

// Categorizes one dropped absolute path. Canonicalizing resolves symlinks and
// makes containment correct across case-insensitive volumes, symlinked mounts
// (e.g. /tmp -> /private/tmp), trailing slashes, and `..`; a symlink whose target
// escapes the root therefore resolves outside and is not mapped in.
fn categorize_drop(root: &Path, absolute: &str) -> DropCategory {
    let path = Path::new(absolute);
    if !path.is_absolute() {
        return DropCategory::Outside;
    }
    let Ok(canonical) = fs::canonicalize(path) else {
        // A path that no longer exists can't be linked; treat as outside.
        return DropCategory::Outside;
    };
    if canonical.is_dir() {
        return DropCategory::Directory;
    }
    if !canonical.is_file() {
        // Sockets/FIFOs and the like are not linkable files.
        return DropCategory::Outside;
    }
    match canonical
        .strip_prefix(root)
        .ok()
        .and_then(relative_segments)
    {
        Some(relative) => DropCategory::Inside(relative),
        None => DropCategory::Outside,
    }
}

// Joins a canonical relative path's components into a forward-slash string, or None
// if it is empty (the root itself) or has a non-UTF-8 / non-normal segment.
fn relative_segments(relative: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            // A non-UTF-8 segment (`to_str()` → None) makes the whole path count
            // outside. The server API is UTF-8 relative paths, so a non-UTF-8 name
            // could not be linked anyway; revisit only if a real Linux/other-locale
            // library needs it.
            Component::Normal(segment) => parts.push(segment.to_str()?.to_owned()),
            // A canonical path under the root yields only normal components.
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{
        resolve_verified_path, resolve_within_verified_root, reverse_map_under_root,
        validate_library_id, validate_library_root, MappingErrorCode,
    };

    // Canonicalizes a scratch root the way the command does before reverse-mapping
    fn canonical(path: &Path) -> PathBuf {
        fs::canonicalize(path).expect("canonical root")
    }

    // Renders one absolute path as the string the drop event delivers
    fn dropped(path: &Path) -> String {
        path.to_str().expect("utf-8 path").to_owned()
    }

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    // Owns one unique scratch directory and removes only that directory on drop
    struct TestDir(PathBuf);

    impl TestDir {
        // Creates an isolated directory without adding a test-only dependency
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("cairndex-mappings-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).expect("create scratch directory");
            Self(path)
        }

        // Returns the scratch path
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        // Removes the exact generated scratch directory
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Creates one portable manifest fixture
    fn write_manifest(root: &Path, library_uuid: &str) {
        let marker = root.join(".cairndex");
        fs::create_dir_all(&marker).expect("create marker directory");
        fs::write(
            marker.join("manifest.json"),
            format!(r#"{{"library_uuid":"{library_uuid}"}}"#),
        )
        .expect("write manifest");
    }

    #[test]
    fn validates_manifest_identity() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");

        let validated = validate_library_root(root.path(), "library-one").expect("valid root");

        assert_eq!(
            validated,
            fs::canonicalize(root.path()).expect("canonical root")
        );
    }

    #[test]
    fn rejects_a_different_manifest_identity() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-two");

        let error = validate_library_root(root.path(), "library-one").expect_err("mismatch");

        assert_eq!(error.code, MappingErrorCode::LibraryMismatch);
    }

    #[test]
    fn rejects_a_missing_manifest() {
        let root = TestDir::new();

        let error = validate_library_root(root.path(), "library-one").expect_err("no manifest");

        assert_eq!(error.code, MappingErrorCode::InvalidManifest);
    }

    #[test]
    fn rejects_a_malformed_manifest() {
        let root = TestDir::new();
        let marker = root.path().join(".cairndex");
        fs::create_dir_all(&marker).expect("create marker directory");
        fs::write(marker.join("manifest.json"), b"not-json").expect("write malformed manifest");

        let error = validate_library_root(root.path(), "library-one").expect_err("bad manifest");

        assert_eq!(error.code, MappingErrorCode::InvalidManifest);
    }

    #[test]
    fn rejects_an_empty_server_library_id() {
        let error = validate_library_id("").expect_err("empty registry id");

        assert_eq!(error.code, MappingErrorCode::InvalidLibraryId);
    }

    #[test]
    fn resolves_an_existing_contained_file() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("folder")).expect("create folder");
        fs::write(root.path().join("folder/movie.mp4"), b"fixture").expect("write file");

        let resolved = resolve_verified_path(root.path(), "library-one", "folder/movie.mp4")
            .expect("safe path");

        assert_eq!(
            resolved,
            fs::canonicalize(root.path().join("folder/movie.mp4")).expect("canonical file")
        );
    }

    #[test]
    fn rejects_empty_absolute_and_parent_paths() {
        let root = TestDir::new();
        for relative in ["", ".", "../movie.mp4", "folder/../movie.mp4"] {
            let error = resolve_verified_path(root.path(), "library-one", relative)
                .expect_err("unsafe path");
            assert_eq!(error.code, MappingErrorCode::InvalidRelativePath);
        }
        let absolute = root.path().join("movie.mp4");
        let error = resolve_verified_path(
            root.path(),
            "library-one",
            absolute.to_str().expect("utf-8 path"),
        )
        .expect_err("absolute path");
        assert_eq!(error.code, MappingErrorCode::InvalidRelativePath);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        let outside = TestDir::new();
        fs::write(outside.path().join("secret.mp4"), b"fixture").expect("write outside file");
        symlink(outside.path(), root.path().join("escape")).expect("create symlink");

        let error = resolve_verified_path(root.path(), "library-one", "escape/secret.mp4")
            .expect_err("escape");

        assert_eq!(error.code, MappingErrorCode::PathOutsideLibrary);
    }

    #[test]
    fn reports_a_missing_mount_as_volume_not_mounted() {
        let root = TestDir::new();
        let missing_root = root.path().join("offline-volume");

        let error = resolve_verified_path(&missing_root, "library-one", "movie.mp4")
            .expect_err("offline mount");

        assert_eq!(error.code, MappingErrorCode::VolumeNotMounted);
    }

    #[test]
    fn rejects_a_missing_file() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");

        let error = resolve_verified_path(root.path(), "library-one", "missing.mp4")
            .expect_err("missing file");

        assert_eq!(error.code, MappingErrorCode::PathNotFound);
    }

    #[test]
    fn resolves_a_file_within_an_already_verified_root() {
        // The drag-out batch verifies the mount once, then resolves each file this
        // way against the pre-canonicalized root.
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::write(root.path().join("clip.mp4"), b"fixture").expect("write file");
        let verified_root = fs::canonicalize(root.path()).expect("canonical root");

        let resolved = resolve_within_verified_root(&verified_root, "clip.mp4").expect("safe path");

        assert_eq!(
            resolved,
            fs::canonicalize(root.path().join("clip.mp4")).expect("canonical file")
        );
    }

    #[test]
    fn resolve_within_root_rejects_traversal_and_missing() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        let verified_root = fs::canonicalize(root.path()).expect("canonical root");

        let traversal =
            resolve_within_verified_root(&verified_root, "../x.mp4").expect_err("traversal");
        assert_eq!(traversal.code, MappingErrorCode::InvalidRelativePath);
        let missing =
            resolve_within_verified_root(&verified_root, "missing.mp4").expect_err("missing");
        assert_eq!(missing.code, MappingErrorCode::PathNotFound);
    }

    #[test]
    fn handoff_rejects_a_root_that_now_holds_a_different_library() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-two");
        fs::write(root.path().join("movie.mp4"), b"fixture").expect("write file");

        let error = resolve_verified_path(root.path(), "library-one", "movie.mp4")
            .expect_err("swapped library");

        assert_eq!(error.code, MappingErrorCode::LibraryMismatch);
    }

    // --- drag-in reverse mapping (plan 3 §6) --------------------------------

    #[test]
    fn reverse_maps_a_contained_file_to_its_relative_path() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("dir")).expect("create dir");
        fs::write(root.path().join("dir/clip.mp4"), b"fixture").expect("write file");
        let canonical_root = canonical(root.path());

        let result = reverse_map_under_root(
            &canonical_root,
            &[dropped(&canonical_root.join("dir/clip.mp4"))],
        );

        assert_eq!(result.inside, vec!["dir/clip.mp4".to_string()]);
        assert!(result.outside.is_empty());
        assert_eq!(result.directories, 0);
    }

    #[test]
    fn reverse_map_preserves_exact_case_and_uses_forward_slashes() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("MixedCase/Sub")).expect("create dirs");
        fs::write(root.path().join("MixedCase/Sub/Clip.MP4"), b"fixture").expect("write file");
        let canonical_root = canonical(root.path());

        let result = reverse_map_under_root(
            &canonical_root,
            &[dropped(&canonical_root.join("MixedCase/Sub/Clip.MP4"))],
        );

        // Real on-disk case is preserved; separators are always '/'.
        assert_eq!(result.inside, vec!["MixedCase/Sub/Clip.MP4".to_string()]);
    }

    // A case-insensitive volume (the macOS default) must still recognize a dropped
    // path whose casing differs from disk, and return the real on-disk casing.
    #[cfg(target_os = "macos")]
    #[test]
    fn reverse_map_is_case_insensitive_on_macos() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("Alpha")).expect("create dir");
        fs::write(root.path().join("Alpha/Beta.mp4"), b"fixture").expect("write file");
        let canonical_root = canonical(root.path());
        let wrong_case = root.path().join("ALPHA/beta.mp4");
        // Skip on the rare case-sensitive macOS volume where the alias won't resolve.
        if fs::canonicalize(&wrong_case).is_err() {
            return;
        }

        let result = reverse_map_under_root(&canonical_root, &[dropped(&wrong_case)]);

        assert_eq!(result.inside, vec!["Alpha/Beta.mp4".to_string()]);
        assert!(result.outside.is_empty());
        assert_eq!(result.directories, 0);
    }

    #[test]
    fn reverse_map_counts_a_directory_drop_as_a_directory() {
        // A dropped directory (even inside the root, with a normalized trailing
        // slash) is not a linkable file and can't be recursed yet, so it lands in
        // its own `directories` bucket — not `outside`, which would wrongly tell the
        // user to move an in-library folder into the library.
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("folder")).expect("create dir");
        let canonical_root = canonical(root.path());
        let trailing = format!("{}/", dropped(&canonical_root.join("folder")));

        let result = reverse_map_under_root(&canonical_root, &[trailing]);

        assert!(result.inside.is_empty());
        assert!(result.outside.is_empty());
        assert_eq!(result.directories, 1);
    }

    #[cfg(unix)]
    #[test]
    fn reverse_map_resolves_a_symlink_that_leads_into_the_root() {
        use std::os::unix::fs::symlink;

        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("real")).expect("create dir");
        fs::write(root.path().join("real/clip.mp4"), b"fixture").expect("write file");
        // An access path outside the root that symlinks back into it must map to
        // the file's real relative location, not be treated as an outside file.
        let alias = TestDir::new();
        let link = alias.path().join("alias");
        symlink(root.path().join("real"), &link).expect("create symlink");
        let canonical_root = canonical(root.path());

        let result = reverse_map_under_root(&canonical_root, &[dropped(&link.join("clip.mp4"))]);

        assert_eq!(result.inside, vec!["real/clip.mp4".to_string()]);
        assert!(result.outside.is_empty());
        assert_eq!(result.directories, 0);
    }

    #[cfg(unix)]
    #[test]
    fn reverse_map_counts_a_symlink_escape_as_outside() {
        use std::os::unix::fs::symlink;

        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        let outside = TestDir::new();
        fs::write(outside.path().join("secret.mp4"), b"fixture").expect("write outside file");
        // A link that lives inside the root but points outside it must not be mapped
        // in — its real target escapes the library.
        symlink(
            outside.path().join("secret.mp4"),
            root.path().join("link.mp4"),
        )
        .expect("create symlink");
        let canonical_root = canonical(root.path());

        // The dropped path (the link itself) is echoed back verbatim as outside,
        // since its real target escapes the library.
        let dropped_link = dropped(&root.path().join("link.mp4"));
        let result = reverse_map_under_root(&canonical_root, std::slice::from_ref(&dropped_link));

        assert!(result.inside.is_empty());
        assert_eq!(result.outside, vec![dropped_link]);
        assert_eq!(result.directories, 0);
    }

    #[test]
    fn reverse_map_counts_the_root_itself_as_a_directory() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        let canonical_root = canonical(root.path());

        let result = reverse_map_under_root(&canonical_root, &[dropped(&canonical_root)]);

        assert!(result.inside.is_empty());
        assert!(result.outside.is_empty());
        assert_eq!(result.directories, 1);
    }

    #[test]
    fn reverse_map_categorizes_inside_outside_directory_and_echoes_absolutes() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-one");
        fs::create_dir_all(root.path().join("dir")).expect("create dir");
        fs::write(root.path().join("dir/in.mp4"), b"fixture").expect("write file");
        fs::create_dir_all(root.path().join("sub")).expect("create in-root dir");
        let sibling = TestDir::new();
        fs::write(sibling.path().join("out.mp4"), b"fixture").expect("write sibling file");
        let canonical_root = canonical(root.path());

        let out_abs = dropped(&sibling.path().join("out.mp4"));
        let missing_abs = dropped(&canonical_root.join("dir/missing.mp4"));
        let result = reverse_map_under_root(
            &canonical_root,
            &[
                dropped(&canonical_root.join("dir/in.mp4")),
                out_abs.clone(),
                // A path that no longer exists cannot be canonicalized → echoed out.
                missing_abs.clone(),
                // A non-absolute path never came from a real Finder drop → outside.
                "relative/not/absolute.mp4".to_string(),
                // An in-library directory → its own bucket, not "outside".
                dropped(&canonical_root.join("sub")),
            ],
        );

        assert_eq!(result.inside, vec!["dir/in.mp4".to_string()]);
        // `outside` echoes exactly the dropped absolute strings the seam will copy.
        assert_eq!(
            result.outside,
            vec![
                out_abs,
                missing_abs,
                "relative/not/absolute.mp4".to_string()
            ]
        );
        assert_eq!(result.directories, 1);
    }
}
