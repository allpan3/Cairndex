use url::Url;

// Normalizes a user-entered Cairndex server URL for storage and API resolution
pub(crate) fn normalize_server_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Enter a valid server URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The server URL must use http or https".to_string());
    }
    if url.host().is_none() {
        return Err("The server URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The server URL cannot include credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The server URL cannot include a query or fragment".to_string());
    }

    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url.as_str().trim_end_matches('/').to_string())
}

// Exposes URL validation to the shared SPA without duplicating Rust rules
#[tauri::command]
pub(crate) fn normalize_server_url_command(value: String) -> Result<String, String> {
    normalize_server_url(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Accepts the local and reverse-proxy URL shapes supported by Cairndex
    #[test]
    fn normalizes_supported_urls() {
        assert_eq!(
            normalize_server_url(" http://127.0.0.1:8000/ "),
            Ok("http://127.0.0.1:8000".to_string())
        );
        assert_eq!(
            normalize_server_url("https://nas.example/cairndex/"),
            Ok("https://nas.example/cairndex".to_string())
        );
        assert_eq!(
            normalize_server_url("http://[::1]:8000"),
            Ok("http://[::1]:8000".to_string())
        );
    }

    // Rejects URL features that should not be persisted or sent to fetch
    #[test]
    fn rejects_unsafe_or_ambiguous_urls() {
        for value in [
            "file:///tmp/cairndex",
            "http://user:secret@localhost:8000",
            "http://localhost:8000?debug=1",
            "http://localhost:8000/#fragment",
            "not a url",
        ] {
            assert!(normalize_server_url(value).is_err(), "accepted {value}");
        }
    }
}
