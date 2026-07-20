"""Entry point for the desktop local-server sidecar (ADR-0018 §5).

Started by the Tauri shell, not by a person. That difference drives everything
here:

- **The port is chosen by the OS, not by us.** A fixed port would collide with
  whatever else the user runs, and having the shell pick a free port and pass it
  leaves a race between the check and the bind. Instead we bind ``:0``, then
  print the port we actually got on stdout in a line the shell parses. Binding
  first and announcing second means the announced port is always live.
- **Loopback only, always.** A sidecar serves one machine's own desktop app.
  The bind address is not configurable, so no combination of environment or
  arguments can turn it into a LAN server by accident; ``auth/local_token.py``
  is a second gate on top, not the only one.
- **Shutdown must be orderly**, because the app's lifespan releases ownership
  leases on the way out (ADR-0018 §3). A killed sidecar leaves leases to age into
  staleness and demand a confirmation the user should never have seen, so SIGTERM
  is handled as a graceful stop.

Run as ``cairndex-sidecar`` (the PyInstaller entry point, ADR-0019 §2) or as
``python -m cairndex.sidecar`` in development.
"""

import contextlib
import socket
import sys

import uvicorn

# The shell scans stdout for this prefix to learn where to connect. Keep the
# format stable: it is a contract with `apps/desktop/src-tauri`, and it is
# deliberately a single greppable token rather than JSON so a partial line can
# never be half-parsed as valid.
PORT_ANNOUNCE_PREFIX = "CAIRNDEX_SIDECAR_PORT="
HOST = "127.0.0.1"


def bind_loopback_socket() -> socket.socket:
    """Bind an ephemeral loopback port and return the listening socket.

    Handing uvicorn an already-bound socket, rather than asking it to bind a
    port we picked, is what removes the race: nothing can take the port between
    our choosing it and uvicorn listening on it.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, 0))
    sock.listen(128)
    return sock


def announce_port(port: int) -> None:
    """Tell the shell where we are listening, and flush.

    The flush matters: stdout is a pipe here, not a terminal, so Python block-
    buffers it and the shell would wait for the buffer to fill — which for a
    quiet server is never.
    """
    sys.stdout.write(f"{PORT_ANNOUNCE_PREFIX}{port}\n")
    sys.stdout.flush()


def main() -> int:
    from cairndex.auth.local_token import sidecar_mode

    if not sidecar_mode():
        # Refuse rather than serve unauthenticated. A sidecar without its token
        # is an open API on a loopback port any local process can reach, and the
        # shell always sets it — so this means a misconfiguration, not a valid
        # mode we should silently support.
        sys.stderr.write(
            "refusing to start: CAIRNDEX_LOCAL_TOKEN is not set. "
            "The desktop shell sets this when it spawns the sidecar.\n"
        )
        return 2

    sock = bind_loopback_socket()
    try:
        announce_port(sock.getsockname()[1])
        # `factory=False` and an import string would make uvicorn re-import the
        # app in a way PyInstaller's frozen module table does not always follow;
        # importing it here keeps resolution in ordinary Python.
        from cairndex.main import app

        config = uvicorn.Config(app, log_level="warning", access_log=False)
        server = uvicorn.Server(config)
        # uvicorn installs its own SIGTERM/SIGINT handling and runs the app's
        # lifespan shutdown, which is what releases the ownership leases.
        server.run(sockets=[sock])
    finally:
        with contextlib.suppress(OSError):
            sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
