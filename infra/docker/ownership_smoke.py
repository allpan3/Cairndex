"""Exercise library permissions against a local image with disposable bind mounts"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


# Run only the named disposable container or image operation
def docker(*args: str) -> str:
    return subprocess.check_output(["docker", *args], text=True).strip()


# Preserve structured HTTP errors for assertions
def request(base: str, path: str, payload: dict | None = None) -> tuple[int, object]:
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


# Compare every package file, including SQLite sidecars and lease state
def snapshot(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file()
    }


# Real container root-read-only and bind-mount controls, never host library data
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="cairndex-ownership-test:local")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cairndex-permissions-") as directory:
        root = Path(directory)
        root.chmod(0o777)
        library = root / "library"
        library.mkdir(mode=0o777)
        library.chmod(0o777)
        docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/data:uid=10001,gid=10001",
            "-v",
            f"{library}:/library",
            "--entrypoint",
            "python",
            args.image,
            "-c",
            "from pathlib import Path; from cairndex.registry.library_package import create_package; "
            "create_package(Path('/library'), 'Synthetic Permissions'); "
            "Path('/library/source.txt').write_text('synthetic source'); "
            "Path('/library/source.txt').chmod(0o444)",
        )
        for writable_metadata in (False, True):
            name = f"cairndex-permissions-{uuid4().hex[:10]}"
            before = snapshot(library)
            mounts = ["-v", f"{library}:/library:ro"]
            if writable_metadata:
                mounts += ["-v", f"{library / '.cairndex'}:/library/.cairndex:rw"]
            try:
                docker(
                    "run",
                    "-d",
                    "--name",
                    name,
                    "--read-only",
                    "--tmpfs",
                    "/tmp",
                    "--tmpfs",
                    "/data:uid=10001,gid=10001",
                    "--user",
                    "10001:10001",
                    "-e",
                    "CAIRNDEX_WORKER_ENABLED=false",
                    "-p",
                    "127.0.0.1::8000",
                    *mounts,
                    args.image,
                )
                address = docker("port", name, "8000/tcp")
                base = f"http://{address}"
                for _ in range(100):
                    try:
                        if request(base, "/api/v1/health")[0] == 200:
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    time.sleep(0.1)
                status, registered = request(
                    base, "/api/v1/libraries/register", {"root_path": "/library"}
                )
                assert status == 201, (status, registered)
                library_id = registered["id"]
                status, result = request(
                    base, f"/api/v1/libraries/{library_id}/bundles/browse"
                )
                if writable_metadata:
                    assert status == 200, (status, result)
                    status, result = request(
                        base, f"/api/v1/libraries/{library_id}/ownership/release", {}
                    )
                    assert status == 200 and result["state"] == "locally_released"
                else:
                    assert (
                        status == 409
                        and result["code"] == "library_metadata_unwritable"
                    ), (status, result)
                    assert snapshot(library) == before
                assert (library / "source.txt").read_text() == "synthetic source"
                print(
                    f"read-only root / protected sources / metadata writable={writable_metadata}: passed"
                )
            finally:
                subprocess.run(
                    ["docker", "stop", "-t", "35", name],
                    stdout=subprocess.DEVNULL,
                    check=False,
                )
                subprocess.run(
                    ["docker", "rm", name], stdout=subprocess.DEVNULL, check=False
                )


if __name__ == "__main__":
    main()
