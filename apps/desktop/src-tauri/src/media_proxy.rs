use std::{
    io::{Cursor, Read},
    sync::{Arc, RwLock},
    thread,
    time::Duration,
};

use reqwest::{
    blocking::{Client, Response as UpstreamResponse},
    header::{HeaderName, HeaderValue, AUTHORIZATION},
    Method,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};
use url::Url;

const MAX_REQUEST_BODY: u64 = 1024 * 1024;
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// Fixes the relay to one server and the bearer issued by that server
#[derive(Clone)]
struct ProxyConfig {
    server_url: Url,
    token: Option<String>,
}

// Streams authenticated media to the webview without putting bearer tokens in URLs
pub(crate) struct MediaProxy {
    address: String,
    secret: String,
    config: Arc<RwLock<Option<ProxyConfig>>>,
}

impl MediaProxy {
    // Starts one loopback-only relay with an unguessable per-process route
    pub(crate) fn start() -> Result<Self, String> {
        let server = Server::http("127.0.0.1:0").map_err(|error| error.to_string())?;
        let address = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "media proxy did not bind an IP socket".to_string())?
            .to_string();
        let secret = random_secret()?;
        let config = Arc::new(RwLock::new(None));
        let worker_config = Arc::clone(&config);
        let worker_secret = secret.clone();
        thread::Builder::new()
            .name("cairndex-media-proxy".to_string())
            .spawn(move || serve(server, worker_secret, worker_config))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            address,
            secret,
            config,
        })
    }

    // Fixes the relay target to one normalized server and rotates its bearer
    fn configure(&self, server_url: &str, token: Option<String>) -> Result<String, String> {
        let normalized = crate::server_url::normalize_server_url(server_url)?;
        let server_url = Url::parse(&normalized).map_err(|error| error.to_string())?;
        let token = token.filter(|value| !value.is_empty());
        *self
            .config
            .write()
            .map_err(|_| "media proxy configuration is unavailable".to_string())? =
            Some(ProxyConfig { server_url, token });
        Ok(format!("http://{}/{}", self.address, self.secret))
    }
}

// Generates the capability route that protects the loopback relay
fn random_secret() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Accepts relay requests without ever exposing the configured target or token
fn serve(server: Server, secret: String, config: Arc<RwLock<Option<ProxyConfig>>>) {
    let client = match Client::builder()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    for request in server.incoming_requests() {
        handle_request(request, &client, &secret, &config);
    }
}

// Proxies one request to the configured server with a bounded request body
fn handle_request(
    mut request: Request,
    client: &Client,
    secret: &str,
    config: &RwLock<Option<ProxyConfig>>,
) {
    let origin = request_header(&request, "origin");
    if request.method().as_str() == "OPTIONS" {
        let _ = request.respond(cors_preflight(origin.as_deref()));
        return;
    }
    let Some(config) = config.read().ok().and_then(|guard| guard.clone()) else {
        let _ = request.respond(error_response(StatusCode(503), origin.as_deref()));
        return;
    };
    let Some(target) = target_url(&config.server_url, secret, request.url()) else {
        let _ = request.respond(error_response(StatusCode(404), origin.as_deref()));
        return;
    };
    let Ok(method) = Method::from_bytes(request.method().as_str().as_bytes()) else {
        let _ = request.respond(error_response(StatusCode(405), origin.as_deref()));
        return;
    };
    let mut upstream = client.request(method.clone(), target);
    for header in request.headers() {
        let name = header.field.as_str().as_str();
        if !forward_request_header(name) {
            continue;
        }
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_bytes(header.value.as_bytes()) else {
            continue;
        };
        upstream = upstream.header(name, value);
    }
    if let Some(token) = &config.token {
        upstream = upstream.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if method != Method::GET && method != Method::HEAD {
        let mut body = Vec::new();
        if request
            .as_reader()
            .take(MAX_REQUEST_BODY + 1)
            .read_to_end(&mut body)
            .is_err()
            || body.len() as u64 > MAX_REQUEST_BODY
        {
            let _ = request.respond(error_response(StatusCode(413), origin.as_deref()));
            return;
        }
        upstream = upstream.body(body);
    }
    match upstream.send() {
        Ok(response) => {
            let _ = request.respond(upstream_response(response, origin.as_deref()));
        }
        Err(_) => {
            let _ = request.respond(error_response(StatusCode(502), origin.as_deref()));
        }
    }
}

// Rebuilds a target URL under the configured server base without accepting a host
fn target_url(server_url: &Url, secret: &str, request_url: &str) -> Option<Url> {
    let route = request_url.strip_prefix(&format!("/{secret}"))?;
    if !route.starts_with('/') {
        return None;
    }
    let (path, query) = route
        .split_once('?')
        .map_or((route, None), |(path, query)| (path, Some(query)));
    let mut target = server_url.clone();
    let base_path = server_url.path().trim_end_matches('/');
    target.set_path(&format!("{base_path}{path}"));
    target.set_query(query);
    target.set_fragment(None);
    Some(target)
}

// Copies response metadata required by native media range and cache handling
fn upstream_response(
    response: UpstreamResponse,
    origin: Option<&str>,
) -> Response<UpstreamResponse> {
    let status = StatusCode(response.status().as_u16());
    let content_length = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok());
    let mut headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            if !forward_response_header(name.as_str()) {
                return None;
            }
            Header::from_bytes(name.as_str(), value.as_bytes()).ok()
        })
        .collect::<Vec<_>>();
    add_cors_headers(&mut headers, origin);
    Response::new(status, headers, response, content_length, None)
}

// Returns a small path-redacted relay error
fn error_response(status: StatusCode, origin: Option<&str>) -> Response<Cursor<Vec<u8>>> {
    let mut headers = vec![Header::from_bytes("Content-Type", "text/plain").expect("valid header")];
    add_cors_headers(&mut headers, origin);
    Response::new(
        status,
        headers,
        Cursor::new(b"Cairndex media relay failed".to_vec()),
        None,
        None,
    )
}

// Answers local browser preflights without forwarding them to the NAS
fn cors_preflight(origin: Option<&str>) -> Response<Cursor<Vec<u8>>> {
    let mut headers = vec![
        Header::from_bytes("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            .expect("valid header"),
        Header::from_bytes(
            "Access-Control-Allow-Headers",
            "Content-Type, Range, If-None-Match, If-Modified-Since",
        )
        .expect("valid header"),
        Header::from_bytes("Access-Control-Max-Age", "600").expect("valid header"),
    ];
    add_cors_headers(&mut headers, origin);
    Response::new(
        StatusCode(204),
        headers,
        Cursor::new(Vec::new()),
        Some(0),
        None,
    )
}

// Reflects only the requesting page origin because the relay uses no cookies
fn add_cors_headers(headers: &mut Vec<Header>, origin: Option<&str>) {
    if let Some(origin) = origin {
        if let Ok(header) = Header::from_bytes("Access-Control-Allow-Origin", origin) {
            headers.push(header);
        }
        headers.push(Header::from_bytes("Vary", "Origin").expect("valid header"));
        headers
            .push(Header::from_bytes("Access-Control-Expose-Headers", "*").expect("valid header"));
    }
}

// Reads one request header case-insensitively
fn request_header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

// Prevents caller-supplied authority/auth headers from escaping the relay
fn forward_request_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "connection"
            | "content-length"
            | "cookie"
            | "host"
            | "proxy-authorization"
    )
}

// Drops hop-by-hop and upstream CORS headers before adding relay-local CORS
fn forward_response_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "access-control-allow-origin"
            | "access-control-allow-credentials"
            | "connection"
            | "content-length"
            | "keep-alive"
            | "proxy-authenticate"
            | "set-cookie"
            | "transfer-encoding"
            | "upgrade"
    )
}

// Reconfigures the fixed-target relay from the initialized web platform seam
#[tauri::command]
pub(crate) fn configure_media_proxy(
    proxy: tauri::State<'_, MediaProxy>,
    server_url: String,
    token: Option<String>,
) -> Result<String, String> {
    proxy.configure(&server_url, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Keeps reverse-proxy base paths while refusing a route without the secret
    #[test]
    fn maps_only_secret_scoped_paths_to_the_configured_server() {
        let server = Url::parse("https://nas.example/cairndex").unwrap();
        assert_eq!(
            target_url(&server, "secret", "/secret/api/v1/file?size=1")
                .unwrap()
                .as_str(),
            "https://nas.example/cairndex/api/v1/file?size=1"
        );
        assert!(target_url(&server, "secret", "/wrong/api/v1/file").is_none());
    }

    // Rejects authority and credential forwarding while preserving range headers
    #[test]
    fn filters_request_and_response_hop_headers() {
        assert!(!forward_request_header("Authorization"));
        assert!(!forward_request_header("Cookie"));
        assert!(!forward_request_header("Host"));
        assert!(forward_request_header("Range"));
        assert!(!forward_response_header("Content-Length"));
        assert!(!forward_response_header("Set-Cookie"));
        assert!(forward_response_header("Content-Range"));
    }

    // Preserves byte ranges while injecting the configured bearer into the upstream request
    #[test]
    fn streams_authenticated_range_responses() {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_address = upstream.server_addr().to_ip().unwrap();
        let worker = thread::spawn(move || {
            let request = upstream.recv().unwrap();
            assert_eq!(request.url(), "/base/api/media");
            assert_eq!(
                request_header(&request, "authorization").as_deref(),
                Some("Bearer cdx_test")
            );
            assert_eq!(
                request_header(&request, "range").as_deref(),
                Some("bytes=2-4")
            );
            let response = Response::from_string("cde")
                .with_status_code(StatusCode(206))
                .with_header(Header::from_bytes("Content-Range", "bytes 2-4/6").unwrap());
            request.respond(response).unwrap();
        });
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                &format!("http://{upstream_address}/base"),
                Some("cdx_test".to_string()),
            )
            .unwrap();

        let response = Client::new()
            .get(format!("{proxy_base}/api/media"))
            .header("Range", "bytes=2-4")
            .send()
            .unwrap();

        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-4/6");
        assert_eq!(response.text().unwrap(), "cde");
        worker.join().unwrap();
    }
}
