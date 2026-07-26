use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{async_runtime, AppHandle, Emitter, Manager, Runtime, Window};

use crate::mappings::{self, MappingError};

// How long after a drag-out its files are still recognised as ours if they land
// back on our own window. Long enough to cover a drag the user held for a while,
// short enough that genuinely re-importing a file later is not blocked.
const SELF_DROP_WINDOW: Duration = Duration::from_secs(30);

/// The absolute paths of the most recent drag-out.
///
/// The web layer's guard is *timing*-based (a grace period after the drag-ended
/// event), and it loses the race: dropping a dragged card back on our own window
/// was being read as a fresh Finder drop and **copied the files into the library**.
/// In a grid every card is a drag source, so an ordinary click-drag could silently
/// duplicate files. This is the deterministic half of the answer — we compare the
/// dropped paths against what we actually put on the pasteboard, so recognising
/// our own drop does not depend on which event arrives first.
///
/// Absolute paths never leave the shell: the web layer asks a yes/no question and
/// gets a yes/no answer (plan 3 §5/§6).
#[derive(Default)]
pub(crate) struct RecentDragOut {
    inner: Mutex<Option<(HashSet<PathBuf>, Instant)>>,
}

impl RecentDragOut {
    fn remember(&self, paths: &[PathBuf]) {
        let set = paths.iter().cloned().collect();
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some((set, Instant::now()));
        }
    }

    /// Whether every dropped path came from our own recent drag-out. Requiring
    /// *all* of them keeps a genuine drag of new files alongside one of ours from
    /// being discarded.
    fn owns(&self, paths: &[PathBuf]) -> bool {
        if paths.is_empty() {
            return false;
        }
        let Ok(guard) = self.inner.lock() else {
            return false;
        };
        let Some((known, at)) = guard.as_ref() else {
            return false;
        };
        if at.elapsed() > SELF_DROP_WINDOW {
            return false;
        }
        paths.iter().all(|path| {
            known.contains(path)
                || std::fs::canonicalize(path).is_ok_and(|resolved| known.contains(&resolved))
        })
    }
}

/// Ask whether a drop is our own drag-out landing back on us.
///
/// Called by the drop router before anything is imported. Answers `false` on
/// anything it does not recognise, so a real Finder drop is never swallowed.
#[tauri::command]
pub(crate) async fn drop_is_self_drag<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> Result<bool, MappingError> {
    let owned: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    Ok(app.state::<RecentDragOut>().owns(&owned))
}

// A drag preview image is mandatory on macOS/Windows. A neutral document glyph
// rather than the app icon: the thing under the cursor is a *file* being carried
// out, and showing the Cairndex logo made it read as dragging the application.
// Embedded at compile time so the packaged shell never depends on a runtime path.
const DRAG_PREVIEW_ICON: &[u8] = include_bytes!("../icons/drag-file.png");

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

    // Remember what we are about to put on the pasteboard *before* the drag can
    // possibly be dropped, so a drop landing back on our window is recognised as
    // ours no matter how the events interleave.
    app.state::<RecentDragOut>().remember(&paths);

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

    // Starting the session is wrapped because it can **panic**, not merely fail:
    // AppKit's `beginDraggingSessionWithItems:event:source:` returns nil when it
    // has no live mouse-drag event to attach to, and the objc2 binding turns that
    // NULL into a panic — which aborts the whole app.
    //
    // We can reach that state legitimately: paths are resolved off-thread first
    // (canonicalizing an offline SMB mount must not block the UI), so by the time
    // this runs on the main thread the gesture that started it may be over — a
    // quick press-drag on a row is enough. A drag that cannot start is an
    // ordinary failure, so it is reported as one and the window survives.
    let start = std::panic::AssertUnwindSafe(move || {
        #[cfg(target_os = "linux")]
        {
            let gtk_window = window
                .gtk_window()
                .map_err(|_| MappingError::drag_action_failed())?;
            drag::start_drag(&gtk_window, item, image, on_drop, drag::Options::default())
                .map_err(|_| MappingError::drag_action_failed())
        }
        #[cfg(not(target_os = "linux"))]
        {
            drag::start_drag(window, item, image, on_drop, drag::Options::default())
                .map_err(|_| MappingError::drag_action_failed())
        }
    });
    std::panic::catch_unwind(start).unwrap_or_else(|_| {
        eprintln!("[dragout] the OS refused to start a drag session; ignoring this drag");
        Err(MappingError::drag_action_failed())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Recognising our own drag-out is what stops a dropped card being copied back
    // into the library as if it came from Finder, so these pin the recogniser
    // rather than the drag itself (which needs a live AppKit session).

    #[test]
    fn recognises_the_paths_it_just_dragged_out() {
        let recent = RecentDragOut::default();
        let paths = vec![PathBuf::from("/tmp/a.mkv"), PathBuf::from("/tmp/b.mkv")];

        recent.remember(&paths);

        assert!(recent.owns(&paths));
    }

    #[test]
    fn does_not_claim_a_drop_it_never_dragged() {
        let recent = RecentDragOut::default();
        recent.remember(&[PathBuf::from("/tmp/ours.mkv")]);

        // A genuine Finder drop must still be imported.
        assert!(!recent.owns(&[PathBuf::from("/tmp/theirs.mkv")]));
    }

    #[test]
    fn does_not_claim_a_mixed_drop() {
        // One of ours plus one from Finder is a real drop: discarding it would
        // silently lose the file the user meant to add.
        let recent = RecentDragOut::default();
        recent.remember(&[PathBuf::from("/tmp/ours.mkv")]);

        assert!(!recent.owns(&[
            PathBuf::from("/tmp/ours.mkv"),
            PathBuf::from("/tmp/theirs.mkv")
        ]));
    }

    #[test]
    fn claims_nothing_before_any_drag() {
        let recent = RecentDragOut::default();

        assert!(!recent.owns(&[PathBuf::from("/tmp/a.mkv")]));
    }

    #[test]
    fn an_empty_drop_is_never_ours() {
        let recent = RecentDragOut::default();
        recent.remember(&[PathBuf::from("/tmp/a.mkv")]);

        assert!(!recent.owns(&[]));
    }

    #[test]
    fn a_later_drag_replaces_the_one_before_it() {
        let recent = RecentDragOut::default();
        recent.remember(&[PathBuf::from("/tmp/first.mkv")]);
        recent.remember(&[PathBuf::from("/tmp/second.mkv")]);

        assert!(recent.owns(&[PathBuf::from("/tmp/second.mkv")]));
        assert!(!recent.owns(&[PathBuf::from("/tmp/first.mkv")]));
    }
}
