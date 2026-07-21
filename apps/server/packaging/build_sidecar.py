"""Build the desktop sidecar bundle (ADR-0019 §2/§3).

Produces ``packaging/dist/cairndex-sidecar/`` — a PyInstaller one-dir bundle the
Tauri shell stages as a resource and spawns on demand.

ffmpeg is staged rather than fetched. Downloading during a build would put an
unpinned network dependency in the middle of it and defeat CI caching, so
acquisition is a separate step (``fetch_ffmpeg.py``) and this script only copies
what that produced, refusing anything whose checksum does not match the
committed manifest.

    python packaging/build_sidecar.py
    python packaging/build_sidecar.py --ffmpeg-dir path/to/static/binaries
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parent
SERVER_DIR = PACKAGING_DIR.parent
SPEC = PACKAGING_DIR / "cairndex-sidecar.spec"
DIST = PACKAGING_DIR / "dist"
BUILD = PACKAGING_DIR / "build"
BUNDLE = DIST / "cairndex-sidecar"
MANIFEST = PACKAGING_DIR / "ffmpeg-manifest.json"

MEDIA_TOOLS = ("ffmpeg", "ffprobe")


def run_pyinstaller() -> None:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--noconfirm",
            "--distpath",
            str(DIST),
            "--workpath",
            str(BUILD),
            str(SPEC),
        ],
        cwd=PACKAGING_DIR,
        check=True,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_media_tools(source: Path) -> None:
    """Copy the static ffmpeg/ffprobe into the bundle, checksum-verified.

    A package-manager ffmpeg will not work here: Homebrew's is a thin binary
    over a large dylib closure under its own prefix, so copying it produces
    something that runs on the build machine and nowhere else (ADR-0019 §3).
    ``fetch_ffmpeg.py`` fetches genuinely static builds.
    """
    expected: dict[str, str] = {}
    if MANIFEST.is_file():
        expected = json.loads(MANIFEST.read_text(encoding="utf-8")).get("sha256", {})

    for tool in MEDIA_TOOLS:
        binary = source / tool
        if not binary.is_file():
            raise SystemExit(f"missing {tool} in {source} — run packaging/fetch_ffmpeg.py first")
        actual = sha256(binary)
        if tool in expected and expected[tool] != actual:
            raise SystemExit(
                f"{tool} checksum mismatch\n  expected {expected[tool]}\n  actual   {actual}\n"
                "Refusing to bundle a binary that is not the reviewed one."
            )
        if tool not in expected:
            print(f"  warning: {tool} is not in {MANIFEST.name}; bundling unverified", flush=True)
        destination = BUNDLE / tool
        shutil.copy2(binary, destination)
        destination.chmod(0o755)
        print(f"  staged {tool} ({destination.stat().st_size // 1024} KB)", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ffmpeg-dir",
        type=Path,
        default=PACKAGING_DIR / "vendor" / "ffmpeg",
        help="directory holding static ffmpeg and ffprobe binaries",
    )
    parser.add_argument(
        "--skip-ffmpeg",
        action="store_true",
        help="build the Python bundle only (the sidecar then relies on a system ffmpeg)",
    )
    args = parser.parse_args()

    print("building sidecar bundle...", flush=True)
    run_pyinstaller()

    if args.skip_ffmpeg:
        print("  skipping ffmpeg staging (--skip-ffmpeg)", flush=True)
    else:
        stage_media_tools(args.ffmpeg_dir)

    size_mb = sum(p.stat().st_size for p in BUNDLE.rglob("*") if p.is_file()) // (1024 * 1024)
    print(f"built {BUNDLE.relative_to(SERVER_DIR)} ({size_mb} MB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
