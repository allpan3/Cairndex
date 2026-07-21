//! Manages the bundled local-server sidecar (ADR-0018 §5, plan 3 D6).
//!
//! Opening a library folder on this Mac needs a server, and asking a user to
//! start one from a terminal is exactly the administration D6 exists to remove.
//! So the shell spawns the packaged server itself, on demand, and owns its whole
//! lifetime.
//!
//! Three properties this module is responsible for:
//!
//! - **The sidecar is reachable only by us.** It binds loopback, and every
//!   request needs a token generated here and handed over in the environment at
//!   spawn — never on a command line, where any process listing would show it.
//! - **We learn the port from the sidecar, not the other way round.** It binds
//!   an ephemeral port and prints it; picking a free port here and passing it
//!   down would leave a window for something else to take it first.
//! - **It stops when we stop, including when we crash.** Shutdown closes its
//!   stdin rather than sending a signal. A signal needs a shell alive enough to
//!   send it, so a crash would orphan a process still holding ownership leases —
//!   which the user would meet as a takeover prompt on their next launch. The
//!   kernel closes the pipe no matter how we die.
//!
//! No target-OS conditionals live here (plan 3 §2.1): pipes and process spawning
//! are portable, which is precisely why stdin-close was chosen over SIGTERM.

use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

// The line the sidecar prints once it is listening. Contract with
// `cairndex.sidecar`; keep the two in step.
const PORT_ANNOUNCE_PREFIX: &str = "CAIRNDEX_SIDECAR_PORT=";
// A cold start pays for Python interpreter startup plus SQLite schema setup.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(15);
// Overrides the bundled binary, for development (where no Tauri resource dir
// exists yet) and for the lifecycle test. Checked unconditionally, so a packaged
// app launched with it set will honour it too — acceptable because anyone who
// can set this app's environment is already running as the user, which is
// outside the threat model the loopback token addresses.
const DEV_BINARY_ENV: &str = "CAIRNDEX_SIDECAR_BIN";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SidecarErrorCode {
    NotBundled,
    SpawnFailed,
    StartupTimeout,
    StartupFailed,
    DataDirUnavailable,
    TokenGenerationFailed,
}

#[derive(Debug, Serialize)]
pub(crate) struct SidecarError {
    code: SidecarErrorCode,
    message: String,
}

impl SidecarError {
    fn new(code: SidecarErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// What the SPA needs to talk to the sidecar.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct LocalServerInfo {
    pub(crate) base_url: String,
    /// The bearer the SPA must send. It never leaves this machine — the sidecar
    /// listens on loopback only — and is regenerated on every start, so a token
    /// recovered from an old session is worthless.
    pub(crate) token: String,
}

struct Running {
    child: Child,
    info: LocalServerInfo,
}

#[derive(Default)]
pub(crate) struct LocalServer {
    running: Mutex<Option<Running>>,
    /// Serializes start attempts end to end.
    ///
    /// `running` alone is not enough: it is unlocked across the seconds-long
    /// launch, so two callers can both observe an empty slot and both spawn a
    /// server. The second insertion would then terminate the first child while
    /// its caller was already holding that sidecar's URL and token — a handle to
    /// a dead process. React StrictMode double-invoking a mount effect is
    /// exactly how a UI produces those two calls, so this is a real path, not a
    /// theoretical one.
    startup: Mutex<()>,
}

impl LocalServer {
    fn info(&self) -> Option<LocalServerInfo> {
        self.running
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|running| running.info.clone()))
    }
}

/// Lock through a poisoned mutex rather than failing.
///
/// Poisoning means some thread panicked while holding the lock; the data here is
/// an `Option<Running>` and a unit, neither of which can be left half-updated in
/// a way that matters. Refusing to start the local server for the rest of the
/// session would be the worse outcome.
fn lock_through_poison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Generates the per-start bearer the sidecar requires on every request
fn random_token() -> Result<String, SidecarError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        SidecarError::new(SidecarErrorCode::TokenGenerationFailed, error.to_string())
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Locates the packaged sidecar, or the development override
fn binary_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, SidecarError> {
    if let Some(override_path) = std::env::var_os(DEV_BINARY_ENV) {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(SidecarError::new(
            SidecarErrorCode::NotBundled,
            format!("{DEV_BINARY_ENV} does not point at an executable"),
        ));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| SidecarError::new(SidecarErrorCode::NotBundled, error.to_string()))?;
    let path = resource_dir
        .join("cairndex-sidecar")
        .join("cairndex-sidecar");
    if path.is_file() {
        Ok(path)
    } else {
        Err(SidecarError::new(
            SidecarErrorCode::NotBundled,
            "This build does not include a local server.",
        ))
    }
}

// The sidecar's private application-data directory
fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, SidecarError> {
    let base = app.path().app_data_dir().map_err(|error| {
        SidecarError::new(SidecarErrorCode::DataDirUnavailable, error.to_string())
    })?;
    // Its own subdirectory, not the app data root: the sidecar's registry is
    // invisible plumbing (ADR-0018 §5) and must not mingle with shell state such
    // as the Tauri store, which the user may reasonably delete or migrate.
    let dir = base.join("local-server");
    std::fs::create_dir_all(&dir).map_err(|error| {
        SidecarError::new(SidecarErrorCode::DataDirUnavailable, error.to_string())
    })?;
    Ok(dir)
}

// Reads the sidecar's stdout until it announces its port
fn spawn_port_reader(child: &mut Child) -> mpsc::Receiver<Option<u16>> {
    let (sender, receiver) = mpsc::channel();
    let Some(stdout) = child.stdout.take() else {
        let _ = sender.send(None);
        return receiver;
    };
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut announced = false;
        for line in reader.lines().map_while(Result::ok) {
            if !announced {
                if let Some(port) = line.strip_prefix(PORT_ANNOUNCE_PREFIX) {
                    announced = true;
                    let _ = sender.send(port.trim().parse::<u16>().ok());
                    continue;
                }
            }
            // Keep draining after the announcement. An unread pipe fills and
            // then blocks the sidecar's own writes, which would wedge a server
            // that is otherwise healthy.
            if !line.is_empty() {
                eprintln!("[sidecar] {line}");
            }
        }
        if !announced {
            let _ = sender.send(None);
        }
    });
    receiver
}

// Waits for the sidecar to answer its health endpoint
fn await_health(base_url: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let url = format!("{base_url}/api/v1/health");
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

// Starts the sidecar and blocks until it is serving
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<LocalServerInfo, SidecarError> {
    let state = app.state::<LocalServer>();
    start_once(&state, || {
        let binary = binary_path(app)?;
        let data = data_dir(app)?;
        launch(&binary, &data)
    })
}

/// The check-launch-insert critical section.
///
/// Takes the launcher as a closure so a test can drive *this* function rather
/// than re-implement it. That distinction is not cosmetic: the first version of
/// the concurrency test built its own `LocalServer` and repeated the locking
/// inline, so it proved the pattern worked while proving nothing about whether
/// `start` used it — deleting the lock from the real path left every test green.
fn start_once(
    state: &LocalServer,
    launch_one: impl FnOnce() -> Result<(Child, LocalServerInfo), SidecarError>,
) -> Result<LocalServerInfo, SidecarError> {
    // Held across the whole check-launch-insert. A second caller blocks here and
    // then finds the slot filled, so it returns the running server rather than
    // spawning a rival — the check and the insert have to be one critical
    // section or neither caller can trust what it is handed back.
    let _startup = lock_through_poison(&state.startup);

    if let Some(info) = state.info() {
        return Ok(info);
    }

    let (child, info) = launch_one()?;

    let mut guard = lock_through_poison(&state.running);
    // Nothing else can have inserted while we hold `startup`, but a leaked child
    // here would be an orphaned lease holder, so drop any occupant explicitly
    // rather than letting one fall out of scope.
    if let Some(mut previous) = guard.take() {
        terminate(&mut previous.child);
    }
    *guard = Some(Running {
        child,
        info: info.clone(),
    });
    Ok(info)
}

/// Spawn the sidecar and wait until it is healthy.
///
/// Split from [`start`] so the whole lifecycle — spawn, port announcement,
/// health, shutdown — is reachable from a test without a Tauri app. Compiling
/// this module proves nothing about whether the sidecar it manages actually
/// comes up.
fn launch(binary: &Path, data_dir: &Path) -> Result<(Child, LocalServerInfo), SidecarError> {
    let token = random_token()?;

    let mut command = Command::new(binary);
    command
        // The sidecar exits when this pipe closes, which is how we stop it.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .arg("--watch-parent")
        // Environment, not argv: a command line is world-readable through the
        // process list, and this token is the sidecar's only access gate.
        .env("CAIRNDEX_LOCAL_TOKEN", &token)
        .env("CAIRNDEX_DATA_DIR", data_dir);

    // Bundled media tools sit beside the binary. Without these the sidecar falls
    // back to PATH — which, for an app launched from Finder, is launchd's
    // minimal one and usually has no ffmpeg at all.
    if let Some(dir) = binary.parent() {
        let ffmpeg = dir.join("ffmpeg");
        let ffprobe = dir.join("ffprobe");
        if ffmpeg.is_file() && ffprobe.is_file() {
            command.env("CAIRNDEX_FFMPEG_PATH", ffmpeg);
            command.env("CAIRNDEX_FFPROBE_PATH", ffprobe);
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| SidecarError::new(SidecarErrorCode::SpawnFailed, error.to_string()))?;

    let receiver = spawn_port_reader(&mut child);
    let port = match receiver.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Some(port)) => port,
        Ok(None) => {
            terminate(&mut child);
            return Err(SidecarError::new(
                SidecarErrorCode::StartupFailed,
                "The local server stopped before it was ready.",
            ));
        }
        Err(_) => {
            terminate(&mut child);
            return Err(SidecarError::new(
                SidecarErrorCode::StartupTimeout,
                "The local server did not start in time.",
            ));
        }
    };

    let base_url = format!("http://127.0.0.1:{port}");
    if !await_health(&base_url) {
        terminate(&mut child);
        return Err(SidecarError::new(
            SidecarErrorCode::StartupFailed,
            "The local server started but did not become healthy.",
        ));
    }

    Ok((child, LocalServerInfo { base_url, token }))
}

// Stops a sidecar, preferring the graceful path that releases its leases
fn terminate(child: &mut Child) {
    // Dropping stdin closes the pipe, which the sidecar is watching. That runs
    // its lifespan shutdown: leases released, WAL folded in. Killing instead
    // would leave both undone.
    drop(child.stdin.take());

    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    // Last resort only. Reached when the sidecar is wedged, in which case an
    // unreleased lease is the lesser problem — and it ages out to a takeover
    // the user can confirm.
    let _ = child.kill();
    let _ = child.wait();
}

/// Start the local server, or return the running one.
#[tauri::command]
pub(crate) async fn start_local_server<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalServerInfo, SidecarError> {
    // No fast path here on purpose. Checking outside `start` is what made two
    // concurrent callers both decide to spawn; `start` re-checks under its
    // startup lock, which is the only place the answer is trustworthy.
    //
    // Spawning, reading a pipe, and polling health all block; the IPC thread
    // must not be the one waiting through a 45-second cold start.
    tauri::async_runtime::spawn_blocking(move || start(&app))
        .await
        .map_err(|error| SidecarError::new(SidecarErrorCode::SpawnFailed, error.to_string()))?
}

/// Stop the local server if it is running.
#[tauri::command]
pub(crate) async fn stop_local_server<R: Runtime>(app: AppHandle<R>) -> Result<(), SidecarError> {
    let _ = tauri::async_runtime::spawn_blocking(move || shutdown(&app)).await;
    Ok(())
}

/// Report the running local server, if any, without starting one.
#[tauri::command]
pub(crate) fn local_server_status<R: Runtime>(app: AppHandle<R>) -> Option<LocalServerInfo> {
    app.state::<LocalServer>().info()
}

/// Stop the sidecar as the shell exits (called from the exit path).
pub(crate) fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<LocalServer>() else {
        return;
    };
    let running = state.running.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut running) = running {
        terminate(&mut running.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_announced_port_line() {
        assert_eq!(
            "CAIRNDEX_SIDECAR_PORT=54321"
                .strip_prefix(PORT_ANNOUNCE_PREFIX)
                .and_then(|value| value.trim().parse::<u16>().ok()),
            Some(54321)
        );
    }

    #[test]
    fn ignores_ordinary_log_lines() {
        assert!("INFO: started".strip_prefix(PORT_ANNOUNCE_PREFIX).is_none());
    }

    #[test]
    fn rejects_a_malformed_port() {
        assert_eq!(
            "CAIRNDEX_SIDECAR_PORT=not-a-port"
                .strip_prefix(PORT_ANNOUNCE_PREFIX)
                .and_then(|value| value.trim().parse::<u16>().ok()),
            None
        );
    }

    // Drives the real packaged sidecar through its whole lifecycle. Skipped
    // unless CAIRNDEX_SIDECAR_BIN points at a built bundle, because building it
    // needs Python and PyInstaller — the desktop crate's own gates must stay
    // runnable without them. CI sets it after `build_sidecar.py`.
    fn built_bundle() -> Option<PathBuf> {
        let path = PathBuf::from(std::env::var_os(DEV_BINARY_ENV)?);
        path.is_file().then_some(path)
    }

    #[test]
    fn launches_the_real_sidecar_and_stops_it_cleanly() {
        let Some(binary) = built_bundle() else {
            eprintln!("skipping: set {DEV_BINARY_ENV} to a built sidecar bundle");
            return;
        };
        let workdir =
            std::env::temp_dir().join(format!("cairndex-sidecar-test-{}", std::process::id()));
        std::fs::create_dir_all(&workdir).expect("workdir");

        let (mut child, info) = launch(&binary, &workdir).expect("sidecar should launch");

        // The port came from the sidecar, and it is genuinely loopback-only.
        assert!(info.base_url.starts_with("http://127.0.0.1:"));
        assert_eq!(info.token.len(), 64);

        let client = reqwest::blocking::Client::new();
        // Health is open so the shell can wait for readiness.
        let health = client
            .get(format!("{}/api/v1/health", info.base_url))
            .send()
            .expect("health request");
        assert!(health.status().is_success());

        // Everything else demands the token this run generated.
        let anonymous = client
            .get(format!("{}/api/v1/libraries", info.base_url))
            .send()
            .expect("anonymous request");
        assert_eq!(anonymous.status().as_u16(), 401);

        let authorized = client
            .get(format!("{}/api/v1/libraries", info.base_url))
            .bearer_auth(&info.token)
            .send()
            .expect("authorized request");
        assert!(authorized.status().is_success());

        // Closing stdin must be enough — no signal, no kill.
        terminate(&mut child);
        assert!(
            child.try_wait().expect("wait").is_some(),
            "the sidecar should have exited after its stdin closed"
        );

        // And the port is genuinely free again, not merely un-polled.
        let after = client
            .get(format!("{}/api/v1/health", info.base_url))
            .timeout(Duration::from_secs(2))
            .send();
        assert!(after.is_err(), "the sidecar should no longer be listening");

        let _ = std::fs::remove_dir_all(&workdir);
    }

    #[test]
    fn concurrent_starts_yield_one_live_server() {
        let Some(binary) = built_bundle() else {
            eprintln!("skipping: set {DEV_BINARY_ENV} to a built sidecar bundle");
            return;
        };
        // Drives the real `start_once`, not a copy of it. An earlier version of
        // this test repeated the locking inline and so stayed green when the
        // lock was deleted from the production path.
        let state = std::sync::Arc::new(LocalServer::default());
        let workdir =
            std::env::temp_dir().join(format!("cairndex-race-test-{}", std::process::id()));
        std::fs::create_dir_all(&workdir).expect("workdir");

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let state = std::sync::Arc::clone(&state);
                let binary = binary.clone();
                let workdir = workdir.clone();
                std::thread::spawn(move || {
                    start_once(&state, || launch(&binary, &workdir)).expect("start")
                })
            })
            .collect();

        let results: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().expect("join"))
            .collect();

        // Both callers got the same server...
        assert_eq!(results[0].base_url, results[1].base_url);
        assert_eq!(results[0].token, results[1].token);

        // ...and it is the one still running, not a terminated rival.
        let client = reqwest::blocking::Client::new();
        let response = client
            .get(format!("{}/api/v1/libraries", results[0].base_url))
            .bearer_auth(&results[0].token)
            .send()
            .expect("the returned sidecar should still be alive");
        assert!(response.status().is_success());

        let running = lock_through_poison(&state.running).take();
        if let Some(mut running) = running {
            terminate(&mut running.child);
        }
        let _ = std::fs::remove_dir_all(&workdir);
    }

    #[test]
    fn tokens_are_unique_and_full_length() {
        let first = random_token().expect("token");
        let second = random_token().expect("token");
        // 32 bytes rendered as hex.
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
