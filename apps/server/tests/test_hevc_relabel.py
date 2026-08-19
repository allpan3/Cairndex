"""Relabelling ``hev1`` HEVC as ``hvc1`` without re-encoding.

The headline test is an equivalence: patching the offsets this module finds must
produce a file **byte-identical** to what ffmpeg writes for the same content with
``-tag:v hvc1``. That is the whole claim — if it holds, serving the patched header
with the original ``mdat`` is exactly a remux, for a fraction of the work — and
nothing weaker would establish it. A naive byte-search for the array bytes got
two of five offsets wrong, which is why the parse has to be real.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from cairndex.media.hevc_relabel import find_hevc_relabel

_FFMPEG = shutil.which("ffmpeg")
requires_hevc = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


def _encode(path: Path, *, tag: str, pix_fmt: str = "yuv420p", duration: int = 2) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error",
            "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=10:duration={duration}",
            "-c:v", "libx265", "-x265-params", "log-level=none",
            "-pix_fmt", pix_fmt, "-tag:v", tag, str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip


@requires_hevc
def test_patching_hev1_reproduces_the_hvc1_remux_byte_for_byte(tmp_path: Path) -> None:
    hev1 = tmp_path / "hev1.mp4"
    hvc1 = tmp_path / "hvc1.mp4"
    _encode(hev1, tag="hev1")
    _encode(hvc1, tag="hvc1")

    relabel = find_hevc_relabel(hev1)
    assert relabel is not None

    source = hev1.read_bytes()
    patched = relabel.apply(source, 0)

    assert patched == hvc1.read_bytes(), "a relabel must equal what ffmpeg's -tag:v hvc1 writes"
    # Five bytes: the fourCC differs in two (both share `h` and `1`), plus one
    # array_completeness bit for each of VPS, SPS and PPS.
    assert sum(a != b for a, b in zip(source, patched, strict=True)) == 5
    assert len(relabel.array_offsets) == 3


@requires_hevc
def test_it_patches_across_a_chunk_boundary(tmp_path: Path) -> None:
    """Serving is range-based, so the patch has to work on partial reads."""
    hev1 = tmp_path / "hev1.mp4"
    hvc1 = tmp_path / "hvc1.mp4"
    _encode(hev1, tag="hev1")
    _encode(hvc1, tag="hvc1")
    relabel = find_hevc_relabel(hev1)
    assert relabel is not None

    source = hev1.read_bytes()
    # Deliberately awkward chunking: a size that will split the patched region.
    chunk = 64
    rebuilt = b"".join(
        relabel.apply(source[start : start + chunk], start)
        for start in range(0, len(source), chunk)
    )

    assert rebuilt == hvc1.read_bytes()


@requires_hevc
def test_an_already_hvc1_file_needs_no_relabel(tmp_path: Path) -> None:
    hvc1 = tmp_path / "hvc1.mp4"
    _encode(hvc1, tag="hvc1")

    # Nothing to do, so nothing is claimed — the caller plays it directly as is.
    assert find_hevc_relabel(hvc1) is None


@requires_hevc
def test_ten_bit_hev1_relabels_the_same_way(tmp_path: Path) -> None:
    """Depth is orthogonal: WKWebView plays 10-bit hvc1 and refuses 10-bit hev1."""
    hev1 = tmp_path / "hev1-10.mp4"
    hvc1 = tmp_path / "hvc1-10.mp4"
    _encode(hev1, tag="hev1", pix_fmt="yuv420p10le")
    _encode(hvc1, tag="hvc1", pix_fmt="yuv420p10le")

    relabel = find_hevc_relabel(hev1)
    assert relabel is not None
    assert relabel.apply(hev1.read_bytes(), 0) == hvc1.read_bytes()


def test_a_non_mp4_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    junk = tmp_path / "notes.txt"
    junk.write_text("not a video at all")

    assert find_hevc_relabel(junk) is None


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    assert find_hevc_relabel(tmp_path / "absent.mp4") is None


@requires_hevc
def test_an_h264_mp4_has_no_hev1_entry(tmp_path: Path) -> None:
    h264 = tmp_path / "h264.mp4"
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(h264),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip

    assert find_hevc_relabel(h264) is None
