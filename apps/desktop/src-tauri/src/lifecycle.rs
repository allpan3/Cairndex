use std::{
    sync::atomic::{AtomicU8, Ordering},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, ExitRequestApi, Manager, Runtime};

pub(crate) const EXIT_REQUESTED_EVENT: &str = "cairndex://exit-requested";
const EXIT_FALLBACK_DELAY: Duration = Duration::from_secs(1);
const EXIT_IDLE: u8 = 0;
const EXIT_PREPARING: u8 = 1;
const EXIT_READY: u8 = 2;

// Serializes application-level exit preparation across menu, shortcut, and OS paths
#[derive(Default)]
pub(crate) struct ExitGate(AtomicU8);

impl ExitGate {
    // Claims the one shutdown preparation window
    fn begin(&self) -> bool {
        self.0
            .compare_exchange(
                EXIT_IDLE,
                EXIT_PREPARING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    // Marks the next application exit request safe to complete
    fn finish(&self) {
        self.0.store(EXIT_READY, Ordering::SeqCst);
    }

    // Reports whether persistence preparation has completed
    fn is_ready(&self) -> bool {
        self.0.load(Ordering::SeqCst) == EXIT_READY
    }
}

// Requests one SPA shutdown flush while preventing application exit races
pub(crate) fn intercept_exit<R: Runtime>(app: &AppHandle<R>, api: ExitRequestApi) {
    let gate = app.state::<ExitGate>();
    if gate.is_ready() {
        return;
    }
    api.prevent_exit();
    request_exit(app);
}

// Starts the shared SPA shutdown handshake from native menu or OS exit paths
pub(crate) fn request_exit<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<ExitGate>().begin() {
        return;
    }
    let _ = app.emit(EXIT_REQUESTED_EVENT, ());
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(EXIT_FALLBACK_DELAY);
        app.state::<ExitGate>().finish();
        app.exit(0);
    });
}

// Completes an application exit after the SPA queues its pagehide work
#[tauri::command]
pub(crate) fn finish_exit(app: AppHandle) {
    app.state::<ExitGate>().finish();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ensures repeated quit signals schedule only one shutdown flush
    #[test]
    fn exit_gate_is_single_use() {
        let gate = ExitGate::default();
        assert!(gate.begin());
        assert!(!gate.begin());
        assert!(!gate.is_ready());
        gate.finish();
        assert!(gate.is_ready());
    }
}
