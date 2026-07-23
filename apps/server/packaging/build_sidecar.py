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
import shutil
import subprocess
import sys
from pathlib import Path

from ffmpeg_manifest import (
    MANIFEST,
    MEDIA_TOOLS,
    ManifestError,
    current_platform,
    pins_for,
    sha256,
    vendor_dir,
)

PACKAGING_DIR = Path(__file__).resolve().parent
SERVER_DIR = PACKAGING_DIR.parent
SPEC = PACKAGING_DIR / "cairndex-sidecar.spec"
DIST = PACKAGING_DIR / "dist"
BUILD = PACKAGING_DIR / "build"
BUNDLE = DIST / "cairndex-sidecar"


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


# Mach-O 64-bit header: magic, then cputype. Enough to name an architecture
# without shelling out to `file`.
_MACHO_MAGIC_64 = b"\xcf\xfa\xed\xfe"
_CPU_TYPES = {0x0100000C: "arm64", 0x01000007: "x86_64"}


def macho_arch(binary: Path) -> str | None:
    """Return ``arm64``/``x86_64``, or None if this is not a thin 64-bit Mach-O."""
    with binary.open("rb") as handle:
        header = handle.read(8)
    if len(header) < 8 or header[:4] != _MACHO_MAGIC_64:
        return None
    return _CPU_TYPES.get(int.from_bytes(header[4:8], "little"))


def check_bundle_arch(target_platform: str) -> None:
    """Refuse a bundle whose architecture is not the one being built for.

    The checksum gate cannot see this. It verifies that the *ffmpeg* matches the
    pin for ``--platform``, so staging Intel ffmpeg beside an arm64 sidecar
    passes every digest check and produces an app that dies on launch. This is
    the mistake a two-architecture matrix makes — one job on the wrong runner,
    or a `--platform` flag standing in for an interpreter it cannot change.

    Skipped on anything that is not a macOS build; Linux ELF has no stake here.
    """
    if not target_platform.startswith("macos-"):
        return
    executable = BUNDLE / "cairndex-sidecar"
    built = macho_arch(executable)
    expected = target_platform.removeprefix("macos-")
    if built is None:
        print(f"  warning: cannot read an architecture from {executable.name}", flush=True)
        return
    if built != expected:
        raise SystemExit(
            f"sidecar is {built} but --platform says {expected}.\n"
            "PyInstaller freezes the interpreter that runs it, so build this under an "
            f"{expected} Python rather than passing a flag."
        )
    print(f"  sidecar architecture: {built}", flush=True)


def stage_media_tools(source: Path, target_platform: str) -> None:
    """Copy the static ffmpeg/ffprobe into the bundle, checksum-verified.

    A package-manager ffmpeg will not work here: Homebrew's is a thin binary
    over a large dylib closure under its own prefix, so copying it produces
    something that runs on the build machine and nowhere else (ADR-0019 §3).
    ``fetch_ffmpeg.py`` fetches genuinely static builds.

    The pin is looked up per platform, and an unpinned binary is refused rather
    than bundled with a warning: this runs at the point where a binary becomes
    part of something published, which is the wrong place to be lenient. Builds
    that legitimately have no bundled ffmpeg pass ``--skip-ffmpeg``.

    ``copy2`` preserves mode and mtime and rewrites nothing inside the file, so
    a signed binary stays signed (ADR-0019 §4 — an invalid signature fails
    harder than an absent one).
    """
    pins = pins_for(target_platform)

    for tool in MEDIA_TOOLS:
        binary = source / tool
        if not binary.is_file():
            raise SystemExit(f"missing {tool} in {source} — run packaging/fetch_ffmpeg.py first")
        actual = sha256(binary)
        if pins[tool].sha256 != actual:
            raise SystemExit(
                f"{tool} checksum mismatch for {target_platform}\n"
                f"  expected {pins[tool].sha256}\n  actual   {actual}\n"
                f"Refusing to bundle a binary that is not the one pinned in {MANIFEST.name}."
            )
        destination = BUNDLE / tool
        shutil.copy2(binary, destination)
        destination.chmod(0o755)
        print(f"  staged {tool} ({destination.stat().st_size // 1024} KB)", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ffmpeg-dir",
        type=Path,
        default=None,
        help="directory holding static ffmpeg and ffprobe (default: the platform's vendor dir)",
    )
    parser.add_argument(
        "--skip-ffmpeg",
        action="store_true",
        help="build the Python bundle only (the sidecar then relies on a system ffmpeg)",
    )
    parser.add_argument(
        "--platform",
        default=None,
        help="which pin to verify against; defaults to the current platform",
    )
    args = parser.parse_args()

    # PyInstaller freezes the interpreter running it, so the bundle's
    # architecture is this process's — never a cross-compile. `--platform` picks
    # which pin to verify against, so an Intel build means running this script
    # under an Intel Python, not passing a flag.
    target_platform = args.platform or current_platform()

    print(f"building sidecar bundle for {target_platform}...", flush=True)
    run_pyinstaller()
    check_bundle_arch(target_platform)

    if args.skip_ffmpeg:
        print("  skipping ffmpeg staging (--skip-ffmpeg)", flush=True)
    else:
        try:
            stage_media_tools(args.ffmpeg_dir or vendor_dir(target_platform), target_platform)
        except ManifestError as exc:
            print(exc, file=sys.stderr)
            return 1

    size_mb = sum(p.stat().st_size for p in BUNDLE.rglob("*") if p.is_file()) // (1024 * 1024)
    print(f"built {BUNDLE.relative_to(SERVER_DIR)} ({size_mb} MB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
