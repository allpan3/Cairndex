//! Parses `cairndex://` deep links and hands them to the SPA (plan 3 §7).
//!
//! Supported shapes:
//!
//! ```text
//! cairndex://bundle/<bundle_id>?library=<library_id>
//! cairndex://collection/<collection_id>?library=<library_id>
//! ```
//!
//! The `library` parameter is optional; without it the SPA opens the target in
//! whatever library is already active, which is the common case for a link the
//! owner copied out of their own running app.
//!
//! Cold start is the interesting case. On macOS the OS delivers the URL through
//! an Apple Event that can arrive *before* the webview exists, so a link that is
//! merely emitted is lost. Anything that arrives before the SPA subscribes is
//! therefore parked in [`PendingDeepLink`] and drained by an explicit
//! `take_pending_deep_link` call once the SPA is listening.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use url::Url;

pub(crate) const DEEP_LINK_EVENT: &str = "cairndex://deep-link";

/// A parsed deep link, in the vocabulary the SPA already routes on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkTarget {
    /// `bundle` or `collection`.
    pub(crate) kind: String,
    /// The target's server id.
    pub(crate) id: String,
    /// Optional server library id; `None` means "use the active library".
    pub(crate) library_id: Option<String>,
}

/// How long a parked link stays drainable.
///
/// The park exists to bridge the gap between an Apple Event and the SPA becoming
/// ready — seconds at most. Keeping it indefinitely means a webview reload (crash
/// recovery, or a dev refresh) would re-open a link the user clicked long ago,
/// with the SPA's own dedupe memory gone.
const PARK_TTL: Duration = Duration::from_secs(30);

/// Holds a link that arrived before the SPA could listen for it, with the time it
/// was parked so a stale one can be discarded rather than replayed.
#[derive(Default)]
pub(crate) struct PendingDeepLink(Mutex<Option<(DeepLinkTarget, Instant)>>);

/// Parses one `cairndex://` URL, rejecting anything that is not a known target.
///
/// Ids are taken verbatim from the URL path and are *not* trusted as filesystem
/// input anywhere downstream — they are server ids the SPA looks up over the API,
/// so the only validation needed here is shape.
pub(crate) fn parse_deep_link(raw: &str) -> Option<DeepLinkTarget> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "cairndex" {
        return None;
    }

    // `cairndex://bundle/<id>` parses with "bundle" as the host and "/<id>" as the
    // path. Tolerate `cairndex:///bundle/<id>` (empty host) as well, since some
    // launchers normalize one form into the other.
    let mut segments: Vec<String> = Vec::new();
    if let Some(host) = url.host_str() {
        if !host.is_empty() {
            segments.push(host.to_owned());
        }
    }
    if let Some(path_segments) = url.path_segments() {
        segments.extend(
            path_segments
                .filter(|segment| !segment.is_empty())
                // Percent-decoding matters: an id could legitimately contain a
                // character the launcher encoded on the way in.
                .map(|segment| percent_decode(segment).unwrap_or_else(|| segment.to_owned())),
        );
    }

    let kind = segments.first()?.as_str();
    if kind != "bundle" && kind != "collection" {
        return None;
    }
    let id = segments.get(1)?.trim().to_owned();
    if id.is_empty() || segments.len() > 2 {
        return None;
    }

    let library_id = url
        .query_pairs()
        .find(|(key, _)| key == "library")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.trim().is_empty());

    Some(DeepLinkTarget {
        kind: kind.to_owned(),
        id,
        library_id,
    })
}

/// Decodes one percent-encoded path segment.
fn percent_decode(segment: &str) -> Option<String> {
    // `Url` already decodes query pairs but leaves path segments encoded.
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

/// Routes a freshly received link: emit it, and park it if nothing is listening.
///
/// The emit is unconditional and the parked copy is drained explicitly, so a link
/// arriving *during* SPA startup is delivered exactly once by whichever path wins.
pub(crate) fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, raw: &str) {
    let Some(target) = parse_deep_link(raw) else {
        return;
    };
    if let Some(state) = app.try_state::<PendingDeepLink>() {
        if let Ok(mut pending) = state.0.lock() {
            // Last link wins: if several arrive before the SPA is ready, the most
            // recent is the one the user actually meant to open.
            *pending = Some((target.clone(), Instant::now()));
        }
    }
    let _ = app.emit(DEEP_LINK_EVENT, target);
    crate::app_menu::focus_main_window(app);
}

/// Drains any link that arrived before the SPA subscribed. Returns `None` when
/// the app was launched normally, or when the parked link has gone stale.
#[tauri::command]
pub(crate) fn take_pending_deep_link(
    state: tauri::State<'_, PendingDeepLink>,
) -> Result<Option<DeepLinkTarget>, String> {
    let mut pending = state.0.lock().map_err(|error| error.to_string())?;
    Ok(take_if_fresh(&mut pending, Instant::now()))
}

/// Takes the parked link unless it has outlived [`PARK_TTL`]. Always clears the
/// slot, so a stale link cannot be replayed by a later drain either.
fn take_if_fresh(
    pending: &mut Option<(DeepLinkTarget, Instant)>,
    now: Instant,
) -> Option<DeepLinkTarget> {
    let (target, parked_at) = pending.take()?;
    (now.duration_since(parked_at) <= PARK_TTL).then_some(target)
}

/// Scans process arguments for a `cairndex://` URL.
///
/// Windows and Linux deliver deep links as an argv entry — on a cold start to the
/// first process, and on a warm start to the second process, whose argv the
/// single-instance plugin forwards. macOS uses an Apple Event instead and never
/// takes this path.
pub(crate) fn deep_link_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .map(|arg| arg.as_ref().to_owned())
        .find(|arg| parse_deep_link(arg).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_bundle_link_with_an_explicit_library() {
        let target = parse_deep_link("cairndex://bundle/abc123?library=lib-1").unwrap();
        assert_eq!(target.kind, "bundle");
        assert_eq!(target.id, "abc123");
        assert_eq!(target.library_id.as_deref(), Some("lib-1"));
    }

    #[test]
    fn parses_a_collection_link_without_a_library() {
        let target = parse_deep_link("cairndex://collection/c-9").unwrap();
        assert_eq!(target.kind, "collection");
        assert_eq!(target.id, "c-9");
        assert_eq!(target.library_id, None);
    }

    // Some launchers normalize `scheme://host/path` into `scheme:///host/path`.
    #[test]
    fn tolerates_an_empty_authority() {
        let target = parse_deep_link("cairndex:///bundle/abc123").unwrap();
        assert_eq!(target.kind, "bundle");
        assert_eq!(target.id, "abc123");
    }

    #[test]
    fn decodes_percent_encoded_ids() {
        let target = parse_deep_link("cairndex://bundle/a%20b").unwrap();
        assert_eq!(target.id, "a b");
    }

    // A blank library parameter must mean "active library", not a library whose
    // id is the empty string — the SPA would otherwise look up nothing.
    #[test]
    fn treats_a_blank_library_parameter_as_absent() {
        let target = parse_deep_link("cairndex://bundle/abc?library=%20").unwrap();
        assert_eq!(target.library_id, None);
    }

    #[test]
    fn rejects_unknown_or_malformed_links() {
        // Foreign scheme: never act on a link another app's handler owns.
        assert!(parse_deep_link("https://example.com/bundle/1").is_none());
        // Unknown target kind.
        assert!(parse_deep_link("cairndex://settings/1").is_none());
        // Missing id.
        assert!(parse_deep_link("cairndex://bundle").is_none());
        assert!(parse_deep_link("cairndex://bundle/").is_none());
        // Deeper paths are not a shape we define; guessing could open the wrong
        // thing, so reject rather than take the first two segments.
        assert!(parse_deep_link("cairndex://bundle/a/b").is_none());
        assert!(parse_deep_link("not a url").is_none());
    }

    // A warm-delivered link stays parked after the event was consumed. A webview
    // reload would otherwise drain it and re-open a target the user chose long
    // ago, since the SPA's dedupe memory does not survive the reload.
    #[test]
    fn discards_a_parked_link_that_has_gone_stale() {
        let target = parse_deep_link("cairndex://bundle/abc").unwrap();
        let now = Instant::now();

        let mut fresh = Some((target.clone(), now));
        assert_eq!(take_if_fresh(&mut fresh, now), Some(target.clone()));
        // Draining always clears the slot, so a second drain finds nothing.
        assert_eq!(take_if_fresh(&mut fresh, now), None);

        let mut stale = Some((target, now));
        assert_eq!(
            take_if_fresh(&mut stale, now + PARK_TTL + Duration::from_secs(1)),
            None
        );
        assert!(
            stale.is_none(),
            "a stale link must not stay parked for a later drain"
        );
    }

    #[test]
    fn finds_a_deep_link_among_process_arguments() {
        let args = vec!["/path/to/app", "--flag", "cairndex://bundle/xyz"];
        assert_eq!(
            deep_link_from_args(args).as_deref(),
            Some("cairndex://bundle/xyz")
        );
    }

    // argv[0] is the executable path; a binary that happened to live at a
    // cairndex:// path must not be mistaken for a link.
    #[test]
    fn ignores_the_executable_argument_and_reports_none_when_absent() {
        assert_eq!(deep_link_from_args(vec!["cairndex://bundle/xyz"]), None);
        assert_eq!(deep_link_from_args(vec!["/path/to/app", "--flag"]), None);
    }
}
