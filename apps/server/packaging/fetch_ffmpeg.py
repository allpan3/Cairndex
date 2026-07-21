"""Fetch the pinned static ffmpeg/ffprobe for this platform (ADR-0019 §3).

Separate from the build so the build has no network dependency in the middle of
it, and so CI can cache the result. Downloads only what ``ffmpeg-manifest.json``
pins, and verifies the checksum before the binary is allowed near a bundle — an
unpinned "latest" download is a build that can change under you.

    python packaging/fetch_ffmpeg.py
    python packaging/fetch_ffmpeg.py --platform macos-arm64
"""

import argparse
import hashlib
import json
import platform
import shutil
import stat
import sys
import tempfile
import urllib.request
from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parent
MANIFEST = PACKAGING_DIR / "ffmpeg-manifest.json"
VENDOR = PACKAGING_DIR / "vendor" / "ffmpeg"
TOOLS = ("ffmpeg", "ffprobe")


def current_platform() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64", "amd64": "x86_64"}.get(
        machine, machine
    )
    if system == "darwin":
        return f"macos-{arch}"
    return f"{system}-{arch}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    if not url.startswith("https://"):
        raise SystemExit(f"refusing to fetch over a non-HTTPS URL: {url}")
    with tempfile.NamedTemporaryFile(delete=False, dir=destination.parent) as tmp:
        temp_path = Path(tmp.name)
    try:
        with (
            urllib.request.urlopen(url, timeout=300) as response,  # noqa: S310 — https enforced
            temp_path.open("wb") as sink,
        ):
            shutil.copyfileobj(response, sink)
        temp_path.replace(destination)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=current_platform())
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entry = manifest.get("platforms", {}).get(args.platform)
    if entry is None:
        raise SystemExit(f"{args.platform} is not listed in {MANIFEST.name}")

    if not all(entry.get(tool) for tool in TOOLS):
        print(
            f"{MANIFEST.name} has no pinned build for {args.platform}.\n"
            "Choosing an ffmpeg source is an owner decision (supply chain, and any\n"
            "practical static build is GPL — see ADR-0019 §3). Populate the manifest\n"
            "with a URL and sha256 per tool, or build with --skip-ffmpeg for now.",
            file=sys.stderr,
        )
        return 1

    VENDOR.mkdir(parents=True, exist_ok=True)
    expected = manifest.get("sha256", {})
    for tool in TOOLS:
        target = VENDOR / tool
        if target.is_file() and expected.get(tool) == sha256(target):
            print(f"  {tool}: already present and verified", flush=True)
            continue
        print(f"  {tool}: downloading...", flush=True)
        download(entry[tool], target)
        actual = sha256(target)
        if tool in expected and expected[tool] != actual:
            target.unlink(missing_ok=True)
            raise SystemExit(
                f"{tool} checksum mismatch\n  expected {expected[tool]}\n  actual   {actual}"
            )
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        print(f"  {tool}: verified ({target.stat().st_size // 1024} KB)", flush=True)

    print(f"static media tools ready in {VENDOR}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
