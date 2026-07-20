use std::{
    collections::HashSet,
    io::Cursor,
    sync::{mpsc, Arc, Mutex, RwLock},
    thread,
    time::Duration,
};

use reqwest::{
    blocking::{Client, Response as UpstreamResponse},
    header::{HeaderName, HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Method,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};
use url::Url;

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_READ_TIMEOUT: Duration = Duration::from_secs(30);
const PROXY_WORKERS: usize = 8;
const PROXY_QUEUE_DEPTH: usize = 32;
const ALLOWED_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:5173",
];

// Fixes the relay to one server and the bearer issued by that server
#[derive(Clone)]
struct ProxyConfig {
    server_url: Url,
    token: Option<String>,
    library_ids: HashSet<String>,
    /// Whether the bearer authorizes the whole server rather than the listed
    /// libraries.
    ///
    /// A paired device token (ADR-0015) is scoped, so it is attached only to
    /// libraries it explicitly grants — D2 made that fail closed deliberately.
    /// The desktop sidecar's loopback owner token (ADR-0018 §5) is a different
    /// credential: it authorizes the whole local server, and the set of
    /// libraries registered there changes as the user opens folders, so an
    /// enumerated scope would be stale the moment it was written. Kept as an
    /// explicit flag rather than overloading "empty `library_ids`", which today
    /// means "nothing approved" and must keep meaning that.
    server_scoped_token: bool,
    secret: String,
}

// Streams authenticated media to the webview without putting bearer tokens in URLs
pub(crate) struct MediaProxy {
    address: String,
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
        let config = Arc::new(RwLock::new(None));
        let worker_config = Arc::clone(&config);
        thread::Builder::new()
            .name("cairndex-media-proxy".to_string())
            .spawn(move || serve(server, worker_config))
            .map_err(|error| error.to_string())?;
        Ok(Self { address, config })
    }

    // Fixes the relay target to one normalized server and rotates its bearer
    fn configure(
        &self,
        server_url: &str,
        token: Option<String>,
        library_ids: Vec<String>,
        server_scoped_token: bool,
    ) -> Result<String, String> {
        let normalized = crate::server_url::normalize_server_url(server_url)?;
        let server_url = Url::parse(&normalized).map_err(|error| error.to_string())?;
        let token = token.filter(|value| !value.is_empty());
        let library_ids = library_ids
            .into_iter()
            .filter(|library_id| !library_id.is_empty())
            .collect();
        let secret = random_secret()?;
        *self
            .config
            .write()
            .map_err(|_| "media proxy configuration is unavailable".to_string())? =
            Some(ProxyConfig {
                server_url,
                token,
                library_ids,
                server_scoped_token,
                secret: secret.clone(),
            });
        Ok(format!("http://{}/{secret}", self.address))
    }
}

// Generates the capability route that protects the loopback relay
fn random_secret() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Builds the fixed-timeout, no-redirect upstream client shared by relay workers
fn proxy_client(read_timeout: Duration) -> Result<Client, reqwest::Error> {
    Client::builder()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .timeout(read_timeout) // blocking reqwest reapplies this bound to each body read
        .redirect(Policy::none())
        .build()
}

// Accepts relay requests without ever exposing the configured target or token
fn serve(server: Server, config: Arc<RwLock<Option<ProxyConfig>>>) {
    let client = match proxy_client(PROXY_READ_TIMEOUT) {
        Ok(client) => client,
        Err(_) => return,
    };
    let (sender, receiver) = mpsc::sync_channel(PROXY_QUEUE_DEPTH);
    let receiver = Arc::new(Mutex::new(receiver));
    for index in 0..PROXY_WORKERS {
        let client = client.clone();
        let config = Arc::clone(&config);
        let receiver = Arc::clone(&receiver);
        let _ = thread::Builder::new()
            .name(format!("cairndex-media-proxy-{index}"))
            .spawn(move || proxy_worker(receiver, client, config));
    }
    drop(receiver);
    for request in server.incoming_requests() {
        if sender.send(request).is_err() {
            return;
        }
    }
}

// Serves queued requests with fixed concurrency so long media streams cannot block metadata
fn proxy_worker(
    receiver: Arc<Mutex<mpsc::Receiver<Request>>>,
    client: Client,
    config: Arc<RwLock<Option<ProxyConfig>>>,
) {
    loop {
        let request = match receiver.lock() {
            Ok(receiver) => receiver.recv(),
            Err(_) => return,
        };
        match request {
            Ok(request) => handle_request(request, &client, &config),
            Err(_) => return,
        }
    }
}

// Proxies one allowlisted read request to the fixed configured server
fn handle_request(request: Request, client: &Client, config: &RwLock<Option<ProxyConfig>>) {
    let origin = request_header(&request, "origin");
    if !request_origin_allowed(origin.as_deref()) {
        let _ = request.respond(error_response(StatusCode(403), None));
        return;
    }
    if request.method().as_str() == "OPTIONS" {
        let response = if origin.is_some() {
            cors_preflight(origin.as_deref())
        } else {
            error_response(StatusCode(403), None)
        };
        let _ = request.respond(response);
        return;
    }
    let Ok(method) = Method::from_bytes(request.method().as_str().as_bytes()) else {
        let _ = request.respond(error_response(StatusCode(405), origin.as_deref()));
        return;
    };
    if method != Method::GET && method != Method::HEAD {
        let _ = request.respond(error_response(StatusCode(405), origin.as_deref()));
        return;
    }
    let Some(config) = config.read().ok().and_then(|guard| guard.clone()) else {
        let _ = request.respond(error_response(StatusCode(503), origin.as_deref()));
        return;
    };
    let Some(target) = target_url(&config.server_url, &config.secret, request.url()) else {
        let _ = request.respond(error_response(StatusCode(404), origin.as_deref()));
        return;
    };
    let base_path = config.server_url.path().trim_end_matches('/');
    let Some(media_path) = target.path().strip_prefix(base_path) else {
        let _ = request.respond(error_response(StatusCode(404), origin.as_deref()));
        return;
    };
    let Some(library_id) = media_route_library_id(media_path) else {
        let _ = request.respond(error_response(StatusCode(404), origin.as_deref()));
        return;
    };
    let Some(token) = config
        .token
        .as_ref()
        .filter(|_| config.server_scoped_token || config.library_ids.contains(library_id))
    else {
        let _ = request.respond(error_response(StatusCode(403), origin.as_deref()));
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
    upstream = upstream.header(AUTHORIZATION, format!("Bearer {token}"));
    match upstream.send() {
        Ok(response) if response.status().is_redirection() => {
            let _ = request.respond(error_response(StatusCode(502), origin.as_deref()));
        }
        Ok(response) => {
            let _ = request.respond(upstream_response(response, origin.as_deref()));
        }
        Err(_) => {
            let _ = request.respond(error_response(StatusCode(502), origin.as_deref()));
        }
    }
}

// Allows only read-only media endpoints whose bearer must stay out of a URL
fn media_route_library_id(path: &str) -> Option<&str> {
    let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() < 5 || segments[..3] != ["api", "v1", "libraries"] {
        return None;
    }
    let library_id = segments[3];
    if library_id.is_empty() {
        return None;
    }
    let route = &segments[4..];
    let allowed = match route {
        ["bundles", _, "thumbnail"]
        | ["bundles", _, "files", _, "thumbnail"]
        | ["collections", _, "thumbnail"]
        | ["files", _, "stream" | "content" | "preview" | "storyboard.vtt"]
        | ["subtitles", _, "vtt"]
        | ["file"]
        | ["file", "preview"] => true,
        ["files", _, "storyboard", sheet_name] => sheet_name.ends_with(".jpg"),
        ["files", _, "playback-sessions", _, artifact] => !artifact.is_empty(),
        _ => false,
    };
    allowed.then_some(library_id)
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
        .with_chunked_threshold(usize::MAX)
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
        Header::from_bytes("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
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

// Restricts the loopback capability to packaged shells and the fixed dev host
fn request_origin_allowed(origin: Option<&str>) -> bool {
    origin.is_none_or(|value| ALLOWED_ORIGINS.contains(&value))
}

// Reflects only an allowlisted shell origin because the relay uses no cookies
fn add_cors_headers(headers: &mut Vec<Header>, origin: Option<&str>) {
    if let Some(origin) = origin.filter(|value| ALLOWED_ORIGINS.contains(value)) {
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
            | "location"
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
    library_ids: Vec<String>,
    server_scoped_token: Option<bool>,
) -> Result<String, String> {
    proxy.configure(
        &server_url,
        token,
        library_ids,
        server_scoped_token.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    // Holds a response body open until its test releases the stream
    struct GateReader {
        release: mpsc::Receiver<()>,
        complete: bool,
    }

    impl Read for GateReader {
        // Blocks the first body read so another request must use a different relay worker
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.complete || buffer.is_empty() {
                return Ok(0);
            }
            self.release.recv().map_err(std::io::Error::other)?;
            buffer[0] = b's';
            self.complete = true;
            Ok(1)
        }
    }

    // Keeps reverse-proxy base paths while refusing a route without the secret
    #[test]
    fn maps_only_secret_scoped_paths_to_the_configured_server() {
        let server = Url::parse("https://nas.example/cairndex").unwrap();
        assert_eq!(
            target_url(
                &server,
                "secret",
                "/secret/api/v1/libraries/lib/files/file/stream?size=1",
            )
            .unwrap()
            .as_str(),
            "https://nas.example/cairndex/api/v1/libraries/lib/files/file/stream?size=1"
        );
        assert!(target_url(&server, "secret", "/wrong/api/v1/file").is_none());
        assert_eq!(
            media_route_library_id("/api/v1/libraries/lib/files/file/stream"),
            Some("lib")
        );
        assert_eq!(
            media_route_library_id("/api/v1/libraries/lib/files/file/playback-sessions/s/art.m4s"),
            Some("lib")
        );
        assert!(media_route_library_id("/api/v1/libraries/lib/bundles/bundle").is_none());
        assert!(media_route_library_id("/api/v1/auth/devices").is_none());
    }

    // Rejects authority and credential forwarding while preserving range headers
    #[test]
    fn filters_request_and_response_hop_headers() {
        assert!(!forward_request_header("Authorization"));
        assert!(!forward_request_header("Cookie"));
        assert!(!forward_request_header("Host"));
        assert!(forward_request_header("Range"));
        assert!(!forward_response_header("Content-Length"));
        assert!(!forward_response_header("Location"));
        assert!(!forward_response_header("Set-Cookie"));
        assert!(forward_response_header("Content-Range"));
        assert!(request_origin_allowed(Some("tauri://localhost")));
        assert!(!request_origin_allowed(Some("https://attacker.example")));
    }

    // Preserves large byte-range lengths while injecting the scoped bearer
    #[test]
    fn streams_authenticated_range_responses() {
        let body = vec![b'x'; 64 * 1024];
        let expected_length = body.len();
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_address = upstream.server_addr().to_ip().unwrap();
        let worker = thread::spawn(move || {
            let request = upstream.recv().unwrap();
            assert_eq!(
                request.url(),
                "/base/api/v1/libraries/lib/files/file/stream"
            );
            assert_eq!(
                request_header(&request, "authorization").as_deref(),
                Some("Bearer cdx_test")
            );
            assert_eq!(
                request_header(&request, "range").as_deref(),
                Some("bytes=0-65535")
            );
            let response = Response::from_data(body)
                .with_status_code(StatusCode(206))
                .with_header(Header::from_bytes("Content-Range", "bytes 0-65535/131072").unwrap())
                .with_chunked_threshold(usize::MAX);
            request.respond(response).unwrap();
        });
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                &format!("http://{upstream_address}/base"),
                Some("cdx_test".to_string()),
                vec!["lib".to_string()],
                false,
            )
            .unwrap();

        let response = Client::new()
            .get(format!(
                "{proxy_base}/api/v1/libraries/lib/files/file/stream"
            ))
            .header("Origin", "tauri://localhost")
            .header("Range", "bytes=0-65535")
            .send()
            .unwrap();

        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 0-65535/131072");
        assert_eq!(
            response.headers()["content-length"],
            expected_length.to_string()
        );
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
        assert_eq!(response.bytes().unwrap().len(), expected_length);
        worker.join().unwrap();
    }

    // Refuses untrusted pages, write methods, non-media paths, and unapproved scopes
    #[test]
    fn rejects_requests_outside_the_read_only_scoped_boundary() {
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                "http://127.0.0.1:9",
                Some("cdx_test".to_string()),
                vec!["allowed".to_string()],
                false,
            )
            .unwrap();
        let client = Client::new();
        let allowed_path = format!("{proxy_base}/api/v1/libraries/allowed/files/file/stream");

        assert_eq!(
            client
                .get(&allowed_path)
                .header("Origin", "https://attacker.example")
                .send()
                .unwrap()
                .status()
                .as_u16(),
            403
        );
        assert_eq!(
            client
                .delete(&allowed_path)
                .send()
                .unwrap()
                .status()
                .as_u16(),
            405
        );
        assert_eq!(
            client
                .get(format!("{proxy_base}/api/v1/libraries/allowed/bundles"))
                .send()
                .unwrap()
                .status()
                .as_u16(),
            404
        );
        assert_eq!(
            client
                .get(format!(
                    "{proxy_base}/api/v1/libraries/denied/files/file/stream"
                ))
                .send()
                .unwrap()
                .status()
                .as_u16(),
            403
        );
    }

    // A server-scoped bearer covers libraries no enumerated scope could list
    #[test]
    fn a_server_scoped_token_reaches_libraries_absent_from_the_scope_list() {
        // The sidecar case: the loopback owner token authorizes the whole local
        // server, and libraries appear there as the user opens folders, so an
        // enumerated scope would always be a step behind.
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                "http://127.0.0.1:9",
                Some("local_token".to_string()),
                Vec::new(),
                true,
            )
            .unwrap();

        // 502, not 403: the request was authorized and forwarded, and only then
        // failed to reach the deliberately dead upstream. A scoped token would
        // have been refused at the gate before any connection was attempted.
        let status = Client::new()
            .get(format!(
                "{proxy_base}/api/v1/libraries/never-enumerated/files/file/stream"
            ))
            .send()
            .unwrap()
            .status()
            .as_u16();
        assert_ne!(
            status, 403,
            "a server-scoped token must not be scope-refused"
        );
    }

    // An unscoped device token still fails closed (the D2 guarantee)
    #[test]
    fn an_unscoped_token_is_still_refused_without_the_server_scope_flag() {
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                "http://127.0.0.1:9",
                Some("device_token".to_string()),
                Vec::new(),
                false,
            )
            .unwrap();

        assert_eq!(
            Client::new()
                .get(format!(
                    "{proxy_base}/api/v1/libraries/any/files/file/stream"
                ))
                .send()
                .unwrap()
                .status()
                .as_u16(),
            403
        );
    }

    // Rotates the capability route whenever server auth configuration changes
    #[test]
    fn rotates_the_capability_route_on_configuration() {
        let proxy = MediaProxy::start().unwrap();
        let first = proxy
            .configure("http://127.0.0.1:9", None, Vec::new(), false)
            .unwrap();
        let second = proxy
            .configure("http://127.0.0.1:9", None, Vec::new(), false)
            .unwrap();

        assert_ne!(first, second);
    }

    // Refuses upstream redirects rather than following the bearer to another target
    #[test]
    fn rejects_upstream_redirects() {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_address = upstream.server_addr().to_ip().unwrap();
        let worker = thread::spawn(move || {
            let request = upstream.recv().unwrap();
            request
                .respond(Response::empty(StatusCode(302)).with_header(
                    Header::from_bytes("Location", "http://127.0.0.1:9/private").unwrap(),
                ))
                .unwrap();
        });
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                &format!("http://{upstream_address}"),
                Some("cdx_test".to_string()),
                vec!["lib".to_string()],
                false,
            )
            .unwrap();

        let response = Client::new()
            .get(format!(
                "{proxy_base}/api/v1/libraries/lib/files/file/stream"
            ))
            .send()
            .unwrap();

        assert_eq!(response.status().as_u16(), 502);
        worker.join().unwrap();
    }

    // Bounds a stalled upstream read so one worker eventually becomes available again
    #[test]
    fn times_out_a_stalled_upstream_body() {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_address = upstream.server_addr().to_ip().unwrap();
        let (release_sender, release_receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let request = upstream.recv().unwrap();
            request
                .respond(Response::new(
                    StatusCode(200),
                    Vec::new(),
                    GateReader {
                        release: release_receiver,
                        complete: false,
                    },
                    Some(1),
                    None,
                ))
                .unwrap();
        });
        let result = proxy_client(Duration::from_millis(50))
            .unwrap()
            .get(format!("http://{upstream_address}/stalled"))
            .send()
            .and_then(|response| response.bytes());

        assert!(result.is_err());
        release_sender.send(()).unwrap();
        worker.join().unwrap();
    }

    // Keeps short asset requests responsive while a media response is still streaming
    #[test]
    fn serves_requests_concurrently_while_a_stream_is_open() {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_address = upstream.server_addr().to_ip().unwrap();
        let (slow_seen_sender, slow_seen_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let upstream_worker = thread::spawn(move || {
            let slow_request = upstream.recv().unwrap();
            assert_eq!(
                slow_request.url(),
                "/api/v1/libraries/lib/files/slow/stream"
            );
            slow_seen_sender.send(()).unwrap();
            let slow_responder = thread::spawn(move || {
                slow_request
                    .respond(Response::new(
                        StatusCode(200),
                        Vec::new(),
                        GateReader {
                            release: release_receiver,
                            complete: false,
                        },
                        Some(1),
                        None,
                    ))
                    .unwrap();
            });
            let fast_request = upstream.recv().unwrap();
            assert_eq!(
                fast_request.url(),
                "/api/v1/libraries/lib/files/fast/stream"
            );
            fast_request.respond(Response::from_string("fast")).unwrap();
            slow_responder.join().unwrap();
        });
        let proxy = MediaProxy::start().unwrap();
        let proxy_base = proxy
            .configure(
                &format!("http://{upstream_address}"),
                Some("cdx_test".to_string()),
                vec!["lib".to_string()],
                false,
            )
            .unwrap();
        let slow_base = proxy_base.clone();
        let slow_client = thread::spawn(move || {
            Client::new()
                .get(format!(
                    "{slow_base}/api/v1/libraries/lib/files/slow/stream"
                ))
                .send()
                .unwrap()
                .text()
                .unwrap()
        });
        slow_seen_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let (fast_sender, fast_receiver) = mpsc::channel();
        let fast_client = thread::spawn(move || {
            let result = Client::new()
                .get(format!(
                    "{proxy_base}/api/v1/libraries/lib/files/fast/stream"
                ))
                .send()
                .and_then(|response| response.text());
            fast_sender.send(result).unwrap();
        });
        let fast_result = fast_receiver.recv_timeout(Duration::from_secs(2));
        release_sender.send(()).unwrap();

        assert_eq!(fast_result.unwrap().unwrap(), "fast");
        assert_eq!(slow_client.join().unwrap(), "s");
        fast_client.join().unwrap();
        upstream_worker.join().unwrap();
    }
}
