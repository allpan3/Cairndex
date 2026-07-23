"""Fetch the pinned static ffmpeg/ffprobe for this platform (ADR-0019 §3).

Separate from the build so the build has no network dependency in the middle of
it, and so CI can cache the result. Downloads only what ``ffmpeg-manifest.json``
pins, and verifies the checksum before the binary is allowed near a bundle — an
unpinned "latest" download is a build that can change under you.

Sources publish these as zips more often than as bare binaries, so a pin may
name an ``archive_member``. The download is then verified *before* it is
unpacked, and only the one named member is extracted to a path chosen here, so a
tampered archive is rejected rather than unpacked and inspected afterwards.

    python packaging/fetch_ffmpeg.py
    python packaging/fetch_ffmpeg.py --platform macos-arm64
"""

import argparse
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from ffmpeg_manifest import (
    MEDIA_TOOLS,
    ManifestError,
    Pin,
    current_platform,
    pins_for,
    sha256,
    vendor_dir,
)

PACKAGING_DIR = Path(__file__).resolve().parent
USER_AGENT = "cairndex-packaging/1.0 (+https://github.com/allpan3/cairndex)"


def download(url: str, destination: Path) -> None:
    if not url.startswith("https://"):
        raise SystemExit(f"refusing to fetch over a non-HTTPS URL: {url}")
    # Named explicitly because urllib's default (`Python-urllib/3.x`) is refused
    # with a 403 by some build hosts, including the one currently pinned.
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    with tempfile.NamedTemporaryFile(delete=False, dir=destination.parent) as tmp:
        temp_path = Path(tmp.name)
    try:
        with (
            urllib.request.urlopen(request, timeout=300) as response,  # noqa: S310 — https enforced
            temp_path.open("wb") as sink,
        ):
            shutil.copyfileobj(response, sink)
        temp_path.replace(destination)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def extract_member(archive: Path, member: str, destination: Path) -> None:
    """Extract one named member to ``destination``.

    Deliberately not ``ZipFile.extractall``: the member name comes from the
    manifest rather than from the archive, and the output path is chosen here,
    so an archive cannot write outside the vendor directory by carrying an
    absolute or ``..`` path. It also drops permissions, which is why the caller
    sets the execute bit afterwards.
    """
    with zipfile.ZipFile(archive) as zf:
        try:
            info = zf.getinfo(member)
        except KeyError:
            contents = ", ".join(zf.namelist()[:10]) or "empty archive"
            raise SystemExit(
                f"{archive.name} has no member {member!r} (contains: {contents})"
            ) from None
        with zf.open(info) as source, destination.open("wb") as sink:
            shutil.copyfileobj(source, sink)


def verify(path: Path, expected: str, what: str) -> None:
    actual = sha256(path)
    if actual != expected:
        path.unlink(missing_ok=True)
        raise SystemExit(
            f"{what} checksum mismatch\n  expected {expected}\n  actual   {actual}\n"
            "Refusing to use a download that is not the reviewed one."
        )


def fetch(pin: Pin, workdir: Path, vendor: Path) -> Path:
    target = vendor / pin.tool
    if target.is_file() and sha256(target) == pin.sha256:
        print(f"  {pin.tool}: already present and verified", flush=True)
        return target

    print(f"  {pin.tool}: downloading...", flush=True)
    if pin.is_archive:
        assert pin.archive_member is not None and pin.archive_sha256 is not None
        archive = workdir / f"{pin.tool}-archive"
        download(pin.url, archive)
        verify(archive, pin.archive_sha256, f"{pin.tool} archive")
        extract_member(archive, pin.archive_member, target)
    else:
        download(pin.url, target)

    verify(target, pin.sha256, pin.tool)
    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  {pin.tool}: verified ({target.stat().st_size // 1024} KB)", flush=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=None, help="defaults to the current platform")
    args = parser.parse_args()

    target_platform = args.platform or current_platform()
    try:
        pins = pins_for(target_platform)
    except ManifestError as exc:
        print(exc, file=sys.stderr)
        return 1

    vendor = vendor_dir(target_platform)
    vendor.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cairndex-ffmpeg-") as tmp:
        workdir = Path(tmp)
        for tool in MEDIA_TOOLS:
            fetch(pins[tool], workdir, vendor)

    print(f"{target_platform} media tools ready in {vendor}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
