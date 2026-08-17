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


# --- end to end: an hev1 file plays directly and arrives as hvc1 --------------
@requires_hevc
def test_an_hev1_file_decides_direct_and_streams_as_hvc1(
    client, library_id: str, session, library_root: Path
) -> None:
    """The point of the whole exercise, through the API.

    An `hev1` file used to be a `remux` — an ffmpeg session, with everything that
    hangs off one. It is `direct` now, and the bytes the client receives are the
    ones a remux would have produced.
    """
    from cairndex.domain.enums import FileRole, MediaKind
    from cairndex.services import bundles as bundle_service

    _encode(library_root / "hev1.mp4", tag="hev1")
    bundle = bundle_service.create_bundle(session, title="hev1.mp4")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="hev1.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    # A WKWebView-shaped client: hvc1 yes, hev1 no — measured, see the module docs.
    caps = {
        "containers": ["mp4"],
        "video_codecs": ["h264", "hevc", "hvc1", "hevc10"],
        "audio_codecs": ["aac"],
    }
    decision = client.post(
        f"/api/v1/libraries/{library_id}/files/{video.id}/playback-decision",
        json={"caps": caps},
    ).json()

    assert decision["method"] == "direct", decision["reason"]
    assert decision["session"] is None

    served = client.get(decision["stream_url"])
    assert served.status_code == 200
    assert served.headers["accept-ranges"] == "bytes"
    # Byte-identical to a real hvc1 remux of the same content.
    reference = library_root / "reference-hvc1.mp4"
    _encode(reference, tag="hvc1")
    assert served.content == reference.read_bytes()


@requires_hevc
def test_a_client_that_cannot_take_hvc1_still_gets_a_session(
    client, library_id: str, session, library_root: Path
) -> None:
    """The relabel only helps a client that accepts `hvc1`; others must remux."""
    from cairndex.domain.enums import FileRole, MediaKind
    from cairndex.services import bundles as bundle_service

    _encode(library_root / "hev1b.mp4", tag="hev1")
    bundle = bundle_service.create_bundle(session, title="hev1b.mp4")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="hev1b.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    decision = client.post(
        f"/api/v1/libraries/{library_id}/files/{video.id}/playback-decision",
        json={"caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]}},
    ).json()

    assert decision["method"] == "transcode"


@requires_hevc
def test_an_unindexed_hev1_path_is_relabelled_too(
    client, library_id: str, library_root: Path
) -> None:
    """The File Browser path reader benefits most: no row, so no session metadata."""
    (library_root / "Set07").mkdir()
    _encode(library_root / "Set07" / "hev1.mp4", tag="hev1")
    reference = library_root / "ref.mp4"
    _encode(reference, tag="hvc1")

    served = client.get(f"/api/v1/libraries/{library_id}/file", params={"path": "Set07/hev1.mp4"})

    assert served.status_code == 200
    assert served.content == reference.read_bytes()
