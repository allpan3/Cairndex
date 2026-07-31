"""Exercise `just dev` shutdown against a generated, throwaway library."""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    """Reserve an ephemeral loopback port long enough to learn its number."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(port: int, path: str, *, method: str = "GET", payload: object = None) -> Any:
    """Send one JSON request to the scratch source server."""
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)


def _wait_until_ready(server_port: int, web_port: int) -> None:
    """Wait until both children of the development stack are accepting connections."""
    for _ in range(150):
        try:
            with socket.create_connection(("127.0.0.1", web_port), timeout=0.2):
                _request(server_port, "/api/v1/health")
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("development stack did not become ready")


def _run() -> None:
    """Acquire a lease, interrupt `just dev`, and require a clean release."""
    scratch = Path(tempfile.mkdtemp(prefix="cairndex-dev-smoke."))
    data_dir = scratch / "data"
    library_root = scratch / "library"
    log_path = scratch / "dev.log"
    data_dir.mkdir()
    library_root.mkdir()
    server_port = _free_port()
    web_port = _free_port()
    while web_port == server_port:
        web_port = _free_port()

    env = os.environ.copy()
    env.update(
        {
            "CAIRNDEX_DATA_DIR": str(data_dir),
            "CAIRNDEX_DEV_SERVER_PORT": str(server_port),
            "CAIRNDEX_DEV_WEB_PORT": str(web_port),
            "CAIRNDEX_WORKER_ENABLED": "false",
            "CAIRNDEX_SQLITE_MAINTENANCE_ENABLED": "false",
        }
    )

    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            ["just", "dev"],
            cwd=REPO_ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    try:
        _wait_until_ready(server_port, web_port)
        library = _request(
            server_port,
            "/api/v1/libraries/create",
            method="POST",
            payload={"root_path": str(library_root), "display_name": "Scratch"},
        )
        library_id = library["id"]
        _request(server_port, f"/api/v1/libraries/{library_id}/collections")
        _request(
            server_port,
            f"/api/v1/libraries/{library_id}/write-mode",
            method="PUT",
            payload={"enabled": True},
        )

        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=20)
        lease = json.loads(
            (library_root / ".cairndex/locks/active-owner.json").read_text(encoding="utf-8")
        )
        if process.returncode != 130:
            raise RuntimeError(f"`just dev` exited with {process.returncode}, expected 130")
        if "released_at" not in lease:
            raise RuntimeError("Ctrl-C left the scratch library lease unreleased")
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        print(log_path.read_text(encoding="utf-8"))
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    print("dev stack Ctrl-C released the scratch library lease")


if __name__ == "__main__":
    _run()
