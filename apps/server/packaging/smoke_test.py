"""Run the *packaged* sidecar and exercise real request paths (ADR-0019 §2).

PyInstaller finds imports by reading source, so anything resolved at runtime is
invisible to it and the failure surfaces only when that code path first runs —
in a user's app, not in the build. The unit suite cannot catch this: it imports
from source, where every module is present.

So this deliberately drives the frozen binary over HTTP, through the paths whose
imports are resolved dynamically:

- creating a library    -> SQLAlchemy's sqlite dialect (loaded by entry-point
                           name) and the FTS5 search schema;
- a scan job            -> the background worker and the job handler registry;
- a thumbnail job       -> Pillow's plugin discovery, the usual casualty;
- SIGTERM               -> the lifespan shutdown that releases ownership leases,
                           which is what keeps a takeover prompt from appearing
                           on the user's next launch.

    python packaging/smoke_test.py [--bundle path/to/cairndex-sidecar]

Exits non-zero with the sidecar's own output on any failure.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parent
DEFAULT_BUNDLE = PACKAGING_DIR / "dist" / "cairndex-sidecar" / "cairndex-sidecar"
PORT_PREFIX = "CAIRNDEX_SIDECAR_PORT="
TOKEN = "smoke-test-token"
STARTUP_TIMEOUT = 60.0
JOB_TIMEOUT = 90.0


class SmokeFailure(RuntimeError):
    pass


def request(port: int, path: str, *, method: str = "GET", body: dict | None = None) -> tuple:
    """Return ``(status, parsed_json_or_none)``; never raises for an HTTP error."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(  # noqa: S310 — fixed loopback URL
        f"http://127.0.0.1:{port}{path}", data=data, method=method
    )
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return exc.code, None


def anonymous_status(port: int, path: str) -> int:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


def wait_for_port(process: subprocess.Popen, log: Path) -> int:
    """Read the announced port from the sidecar's stdout."""
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SmokeFailure(f"sidecar exited during startup (code {process.returncode})")
        for line in log.read_text(errors="replace").splitlines():
            if line.startswith(PORT_PREFIX):
                return int(line[len(PORT_PREFIX) :].strip())
        time.sleep(0.2)
    raise SmokeFailure(f"sidecar never announced a port within {STARTUP_TIMEOUT:.0f}s")


def await_job(port: int, job_id: str, label: str) -> None:
    deadline = time.monotonic() + JOB_TIMEOUT
    while time.monotonic() < deadline:
        status, job = request(port, f"/api/v1/jobs/{job_id}")
        if status != 200 or job is None:
            raise SmokeFailure(f"could not read {label} job: HTTP {status}")
        if job["status"] in ("succeeded", "failed", "cancelled"):
            if job["status"] != "succeeded":
                raise SmokeFailure(f"{label} job {job['status']}: {job.get('error')}")
            return
        time.sleep(0.5)
    raise SmokeFailure(f"{label} job did not finish within {JOB_TIMEOUT:.0f}s")


def write_fixtures(library_root: Path) -> None:
    """Small generated images. No user media, ever (AGENTS.md).

    The HEIC one earns its place: ``media/previews.py`` imports ``pillow_heif``
    *inside a function*, so it is the one media import whose resolution the
    JPEG/PNG paths never prove. Without a HEIC fixture, "HEIC previews work in
    the packaged app" would be an assumption rather than a test.
    """
    from PIL import Image
    from pillow_heif import register_heif_opener

    Image.new("RGB", (640, 480), (200, 80, 40)).save(library_root / "photo.jpg", "JPEG")
    Image.new("RGB", (320, 240), (20, 120, 200)).save(library_root / "shot.png", "PNG")

    register_heif_opener()
    Image.new("RGB", (400, 300), (90, 160, 60)).save(library_root / "camera.heic", "HEIF")


def check(port: int, library_root: Path) -> None:
    if anonymous_status(port, "/api/v1/health") != 200:
        raise SmokeFailure("health should be reachable without the owner token")
    if anonymous_status(port, "/api/v1/libraries") != 401:
        raise SmokeFailure("the API must refuse an unauthenticated request")

    # SQLAlchemy's sqlite dialect + the FTS5 schema, both resolved at runtime.
    status, library = request(
        port,
        "/api/v1/libraries/create",
        method="POST",
        body={"root_path": str(library_root), "display_name": "Smoke"},
    )
    if status != 201 or library is None:
        raise SmokeFailure(f"could not create a library: HTTP {status} {library}")
    library_id = library["id"]

    status, _ = request(port, f"/api/v1/libraries/{library_id}/collections")
    if status != 200:
        raise SmokeFailure(f"could not open the library DB: HTTP {status}")

    lease = library_root / ".cairndex" / "locks" / "active-owner.json"
    if not lease.is_file():
        raise SmokeFailure("serving a library did not acquire its ownership lease")

    write_fixtures(library_root)

    status, job = request(port, f"/api/v1/libraries/{library_id}/jobs/scan", method="POST", body={})
    if status not in (200, 201, 202) or job is None:
        raise SmokeFailure(f"could not queue a scan: HTTP {status}")
    await_job(port, job["id"], "scan")

    # Pillow's plugin discovery — the import most likely to be missing.
    status, job = request(
        port, f"/api/v1/libraries/{library_id}/jobs/thumbnails", method="POST", body={}
    )
    if status not in (200, 201, 202) or job is None:
        raise SmokeFailure(f"could not queue thumbnails: HTTP {status}")
    await_job(port, job["id"], "thumbnail")

    status, bundles = request(port, f"/api/v1/libraries/{library_id}/bundles?limit=1")
    if status != 200 or not (bundles or {}).get("items"):
        raise SmokeFailure("the scan produced no bundles from the generated fixtures")

    bundle_id = bundles["items"][0]["id"]
    req = urllib.request.Request(  # noqa: S310
        f"http://127.0.0.1:{port}/api/v1/libraries/{library_id}/bundles/{bundle_id}/thumbnail"
    )
    req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        image = resp.read()
    # Asserting on the bytes, not the status: a frozen Pillow that cannot decode
    # would still let the route answer, just with nothing useful in it.
    if not image.startswith(b"\xff\xd8\xff"):
        raise SmokeFailure(f"thumbnail is not a JPEG ({len(image)} bytes)")

    check_heic_preview(port, library_id)


def check_heic_preview(port: int, library_id: str) -> None:
    """Render a preview of the HEIC fixture — the pillow_heif import path.

    HEIC is not browser-native, so this is the derivative that makes such files
    viewable at all; if the frozen bundle cannot load ``pillow_heif`` the app
    silently loses every HEIC in a user's library.
    """
    # Files are reached through their bundle, so walk every bundle's members.
    status, bundles = request(port, f"/api/v1/libraries/{library_id}/bundles?limit=50")
    if status != 200 or bundles is None:
        raise SmokeFailure(f"could not list bundles: HTTP {status}")

    heic = None
    for bundle in bundles.get("items", []):
        status, files = request(
            port, f"/api/v1/libraries/{library_id}/bundles/{bundle['id']}/files?limit=50"
        )
        if status != 200 or files is None:
            continue
        items = files.get("items", files) if isinstance(files, dict) else files
        heic = next(
            (f for f in items if str(f.get("relative_path", "")).lower().endswith(".heic")),
            None,
        )
        if heic is not None:
            break
    if heic is None:
        raise SmokeFailure("the scan did not index the HEIC fixture")

    req = urllib.request.Request(  # noqa: S310
        f"http://127.0.0.1:{port}/api/v1/libraries/{library_id}/files/{heic['id']}/preview"
    )
    req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            preview = resp.read()
    except urllib.error.HTTPError as exc:
        raise SmokeFailure(
            f"HEIC preview failed with HTTP {exc.code} — pillow_heif may be missing "
            f"from the bundle: {exc.read()[:300]!r}"
        ) from None

    # A preview is re-encoded to a browser format, so JPEG/PNG/WebP magic all
    # count; what must not happen is the original HEIC coming back untouched.
    if not (
        preview.startswith(b"\xff\xd8\xff")
        or preview.startswith(b"\x89PNG")
        or preview[8:12] == b"WEBP"
    ):
        raise SmokeFailure(f"HEIC preview is not a browser image format ({len(preview)} bytes)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    args = parser.parse_args()

    if not args.bundle.is_file():
        print(f"no packaged sidecar at {args.bundle} — run build_sidecar.py first", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="cairndex-smoke-") as workdir:
        work = Path(workdir)
        data_dir = work / "data"
        library_root = work / "library"
        data_dir.mkdir()
        library_root.mkdir()
        log = work / "sidecar.log"

        env = {
            **os.environ,
            "CAIRNDEX_DATA_DIR": str(data_dir),
            "CAIRNDEX_LOCAL_TOKEN": TOKEN,
            # Short intervals so the run does not wait on production timings.
            "CAIRNDEX_SQLITE_MAINTENANCE_INTERVAL": "5",
            "CAIRNDEX_SQLITE_IDLE_CHECKPOINT_AFTER": "1",
        }
        bundled_ffmpeg = args.bundle.parent / "ffmpeg"
        if bundled_ffmpeg.is_file():
            env["CAIRNDEX_FFMPEG_PATH"] = str(bundled_ffmpeg)
            env["CAIRNDEX_FFPROBE_PATH"] = str(args.bundle.parent / "ffprobe")

        with log.open("wb") as sink:
            # `--watch-parent` because that is how the shell actually runs it,
            # and the flag changes shutdown behaviour: it starts a thread that
            # blocks reading stdin. Running without it here once hid a fatal
            # abort at interpreter shutdown that only the packaged app hit.
            process = subprocess.Popen(
                [str(args.bundle), "--watch-parent"],
                stdin=subprocess.PIPE,
                env=env,
                stdout=sink,
                stderr=subprocess.STDOUT,
            )
            try:
                port = wait_for_port(process, log)
                check(port, library_root)

                # SIGTERM is what the shell sends. The lifespan shutdown it
                # triggers is what releases the ownership lease — skip it and
                # the user's next launch meets a takeover prompt.
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    raise SmokeFailure("sidecar ignored the stop signal") from None

                # A crash still "stops" the process, so the exit code has to be
                # checked: SIGABRT (-6) is how a fatal interpreter-shutdown
                # error looks, and it skips the lifespan shutdown entirely.
                if process.returncode in (-signal.SIGABRT, 128 + signal.SIGABRT):
                    raise SmokeFailure(
                        f"sidecar aborted on shutdown (exit {process.returncode}); "
                        "check for a Fatal Python error in the log below"
                    )
                if "Fatal Python error" in log.read_text(errors="replace"):
                    raise SmokeFailure("sidecar logged a fatal Python error during shutdown")

                lease = json.loads(
                    (library_root / ".cairndex" / "locks" / "active-owner.json").read_text()
                )
                if "released_at" not in lease:
                    raise SmokeFailure("clean shutdown did not release the ownership lease")
            except SmokeFailure as failure:
                print(f"SMOKE TEST FAILED: {failure}\n", file=sys.stderr)
                print(log.read_text(errors="replace")[-4000:], file=sys.stderr)
                return 1
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)

    print("packaged sidecar smoke test passed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
