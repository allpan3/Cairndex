use tauri::{plugin::TauriPlugin, Manager, Runtime};
use url::Url;

// Keeps dropped files and external pages from replacing the privileged app renderer
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation")
        .on_navigation(|webview, target| {
            let dev_url = if tauri::is_dev() {
                webview.app_handle().config().build.dev_url.as_ref()
            } else {
                None
            };
            navigation_allowed(target, dev_url)
        })
        .build()
}

// Allows bundled app routes and the exact configured development origin
fn navigation_allowed(target: &Url, dev_url: Option<&Url>) -> bool {
    if !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    if let Some(dev) = dev_url {
        return matches!(target.scheme(), "http" | "https") && same_origin(target, dev);
    }
    matches!(
        (target.scheme(), target.host_str(), target.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    )
}

// Compares URL components instead of trusting host prefixes or opaque URL origins
fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

// Covers packaged and development navigation without loading owner files
#[cfg(test)]
mod tests {
    use super::*;

    // Parses invented URLs used to exercise the shell navigation boundary
    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    // Retains reloads and routes on each supported bundled origin
    #[test]
    fn bundled_routes_and_reload_remain_available() {
        for value in [
            "tauri://localhost/",
            "tauri://localhost/index.html#/files",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html?view=files",
        ] {
            assert!(navigation_allowed(&url(value), None), "{value}");
        }
    }

    // Blocks native file-drop navigation even when the renderer misses the drop
    #[test]
    fn dropped_files_and_external_documents_cannot_replace_the_app() {
        for value in [
            "file:///tmp/synthetic-image.png",
            "file:///tmp/synthetic-page.html",
            "https://example.com/",
            "data:text/html,example",
            "javascript:alert(1)",
            "blob:tauri://localhost/example",
            "about:blank",
        ] {
            assert!(!navigation_allowed(&url(value), None), "{value}");
        }
    }

    // Rejects host lookalikes, alternate ports and embedded credentials
    #[test]
    fn lookalike_origins_and_credentials_are_rejected() {
        for value in [
            "tauri://localhost.example.com/",
            "https://tauri.localhost.example.com/",
            "http://tauri.localhost:5173/",
            "tauri://other/",
            "tauri://user@localhost/",
        ] {
            assert!(!navigation_allowed(&url(value), None), "{value}");
        }
        let mut with_password = url("https://tauri.localhost/");
        with_password
            .set_password(Some("synthetic-password"))
            .unwrap();
        assert!(!navigation_allowed(&with_password, None));
    }

    // Keeps development navigation tied to the configured server and port
    #[test]
    fn development_routes_require_the_configured_origin() {
        let dev = url("http://127.0.0.1:5173/");
        assert!(navigation_allowed(
            &url("http://127.0.0.1:5173/files#item"),
            Some(&dev)
        ));
        for value in [
            "http://127.0.0.1:5174/",
            "http://localhost:5173/",
            "https://127.0.0.1:5173/",
            "http://user@127.0.0.1:5173/",
            "file:///tmp/synthetic-image.png",
        ] {
            assert!(!navigation_allowed(&url(value), Some(&dev)), "{value}");
        }
    }

    // Excludes the configured development server from packaged navigation
    #[test]
    fn packaged_builds_do_not_allow_the_development_server() {
        assert!(!navigation_allowed(&url("http://127.0.0.1:5173/"), None));
    }
}
