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

import argparse
import contextlib
import socket
import sys
import threading

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


def watch_parent(server: uvicorn.Server) -> None:
    """Shut down gracefully when the shell's end of our stdin pipe closes.

    This is how the shell stops us, in preference to a signal, for two reasons.

    It is genuinely cross-platform: Windows has no SIGTERM, so a signal-based
    stop would need target-OS branches in the shell that plan 3 §2.1 exists to
    avoid.

    More importantly it survives the shell *not* getting to ask. A SIGTERM is
    only sent by a shell that is still alive enough to send it; a crash or a
    `kill -9` sends nothing, and the sidecar would then keep running — holding
    ownership leases that the user meets as a takeover prompt on their next
    launch. The pipe, by contrast, is closed by the kernel whatever killed the
    parent, so the graceful path that releases those leases still runs.

    Opt-in via ``--watch-parent`` rather than automatic: a sidecar started by
    hand may have stdin at ``/dev/null``, which is at EOF immediately and would
    make the server exit the moment it started.
    """

    def wait_for_eof() -> None:
        with contextlib.suppress(Exception):
            # Returns b"" only at EOF. The shell never writes to this pipe, so
            # anything it did send is deliberately ignored — the close is the
            # whole message.
            sys.stdin.buffer.read()
        server.should_exit = True

    threading.Thread(target=wait_for_eof, name="cairndex-parent-watch", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cairndex-sidecar", description=__doc__)
    parser.add_argument(
        "--watch-parent",
        action="store_true",
        help="stop when stdin reaches EOF (the desktop shell passes this)",
    )
    args = parser.parse_args(argv)

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
        if args.watch_parent:
            watch_parent(server)
        # Either route into the same graceful stop: uvicorn's own SIGTERM/SIGINT
        # handling, or `should_exit` set by the parent watch. Both run the app's
        # lifespan shutdown, which is what releases the ownership leases.
        server.run(sockets=[sock])
    finally:
        with contextlib.suppress(OSError):
            sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
