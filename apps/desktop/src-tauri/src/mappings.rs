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
}

// Returns structured, path-free failures across the Tauri command boundary
#[derive(Debug, Serialize)]
pub(crate) struct MappingError {
    code: MappingErrorCode,
    message: String,
}

impl MappingError {
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
}

// Couples one stored local root to the portable identity proven at locate time
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MappingRecord {
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

// Proves that a picked folder is the portable library the server described
fn validate_library_root(
    local_root: &Path,
    expected_library_uuid: &str,
) -> Result<PathBuf, MappingError> {
    validate_library_uuid(expected_library_uuid)?;
    let root = canonicalize_root(local_root)?;
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
    let manifest: LibraryManifest = serde_json::from_slice(&bytes).map_err(|_| {
        MappingError::new(
            MappingErrorCode::InvalidManifest,
            "The selected library manifest is invalid.",
        )
    })?;
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

// Re-proves library identity at handoff time, then containment plus existence
pub(crate) fn resolve_verified_path(
    local_root: &Path,
    expected_library_uuid: &str,
    relative_path: &str,
) -> Result<PathBuf, MappingError> {
    let relative = validate_relative_path(relative_path)?;
    let root = validate_library_root(local_root, expected_library_uuid)?;
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
    if !candidate.starts_with(&root) {
        return Err(MappingError::new(
            MappingErrorCode::PathOutsideLibrary,
            "The mapped file escapes the library root.",
        ));
    }
    Ok(candidate)
}

// Loads the complete shell-owned library-id to mapping-record map
fn load_mappings<R: Runtime>(
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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{
        resolve_verified_path, validate_library_id, validate_library_root, MappingErrorCode,
    };

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
    fn handoff_rejects_a_root_that_now_holds_a_different_library() {
        let root = TestDir::new();
        write_manifest(root.path(), "library-two");
        fs::write(root.path().join("movie.mp4"), b"fixture").expect("write file");

        let error = resolve_verified_path(root.path(), "library-one", "movie.mp4")
            .expect_err("swapped library");

        assert_eq!(error.code, MappingErrorCode::LibraryMismatch);
    }
}
