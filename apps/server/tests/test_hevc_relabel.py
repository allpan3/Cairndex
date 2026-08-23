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

from cairndex.media.hevc_relabel import Outcome, inspect_hevc

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

    relabel = inspect_hevc(hev1).relabel
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
    relabel = inspect_hevc(hev1).relabel
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
    assert inspect_hevc(hvc1).relabel is None


@requires_hevc
def test_ten_bit_hev1_relabels_the_same_way(tmp_path: Path) -> None:
    """Depth is orthogonal: WKWebView plays 10-bit hvc1 and refuses 10-bit hev1."""
    hev1 = tmp_path / "hev1-10.mp4"
    hvc1 = tmp_path / "hvc1-10.mp4"
    _encode(hev1, tag="hev1", pix_fmt="yuv420p10le")
    _encode(hvc1, tag="hvc1", pix_fmt="yuv420p10le")

    relabel = inspect_hevc(hev1).relabel
    assert relabel is not None
    assert relabel.apply(hev1.read_bytes(), 0) == hvc1.read_bytes()


def test_a_non_mp4_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    junk = tmp_path / "notes.txt"
    junk.write_text("not a video at all")

    assert inspect_hevc(junk).relabel is None


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    assert inspect_hevc(tmp_path / "absent.mp4").relabel is None


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

    assert inspect_hevc(h264).relabel is None


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


# --- refusals explain themselves ---------------------------------------------
# A refusal used to be an unadorned None, which reached the UI as a remux with no
# stated cause. These pin the words, because they are what someone reads when
# their file is the one that will not play directly.
@requires_hevc
def test_a_file_missing_a_parameter_set_says_which_one(tmp_path: Path) -> None:
    """The realistic refusal: a muxer that left a parameter set out of `hvcC`."""
    hev1 = tmp_path / "hev1.mp4"
    _encode(hev1, tag="hev1")
    source = hev1.read_bytes()

    # Drop the VPS array by renumbering it to a type nothing requires. The array
    # walk still parses; only the completeness guard changes its mind.
    relabel = inspect_hevc(hev1).relabel
    assert relabel is not None
    vps_offset = relabel.array_offsets[0]
    mangled = bytearray(source)
    assert mangled[vps_offset] & 0x3F == 32, "first parameter-set array should be the VPS"
    mangled[vps_offset] = (mangled[vps_offset] & ~0x3F) | 39  # SEI: not required
    stripped = tmp_path / "no-vps.mp4"
    stripped.write_bytes(bytes(mangled))

    outcome = inspect_hevc(stripped)

    assert outcome.relabel is None
    assert outcome.why == "its header carries no VPS, so the decoder needs them in-band"


@requires_hevc
def test_a_sample_entry_without_hvcc_says_so(tmp_path: Path) -> None:
    hev1 = tmp_path / "hev1.mp4"
    _encode(hev1, tag="hev1")
    source = hev1.read_bytes()
    # Rename `hvcC` so the sample entry no longer advertises a configuration.
    mangled = source.replace(b"hvcC", b"xxxC", 1)
    assert mangled != source
    broken = tmp_path / "no-hvcc.mp4"
    broken.write_bytes(mangled)

    outcome = inspect_hevc(broken)

    assert outcome.relabel is None
    assert outcome.why == "its sample entry carries no hvcC configuration"


@requires_hevc
def test_a_relabellable_file_offers_no_excuse(tmp_path: Path) -> None:
    hev1 = tmp_path / "hev1.mp4"
    _encode(hev1, tag="hev1")

    outcome = inspect_hevc(hev1)

    assert outcome.relabel is not None
    assert outcome.why is None


def test_a_file_that_was_never_hev1_is_not_explained(tmp_path: Path) -> None:
    """There was no relabel on offer, so there is nothing to excuse."""
    junk = tmp_path / "notes.txt"
    junk.write_text("not a video at all")

    assert inspect_hevc(junk) == Outcome(None, None)


def test_a_missing_file_says_its_header_could_not_be_read(tmp_path: Path) -> None:
    assert inspect_hevc(tmp_path / "absent.mp4").why == "its header could not be read"


# --- and the decision says it, which is where anyone will actually read it -----
@requires_hevc
def test_a_client_taking_no_hevc_tag_is_told_that_is_why(
    client, library_id: str, library_root: Path
) -> None:
    """`hev1 codec tag is not in client capabilities` alone reads as arbitrary.

    The owner hit exactly this (2026-08-16): a remux, an HLS session, and no clue
    whether the file or the client was the obstacle.
    """
    (library_root / "Set07").mkdir(exist_ok=True)
    _encode(library_root / "Set07" / "tagless.mp4", tag="hev1")

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            "path": "Set07/tagless.mp4",
            # HEVC decodes, but only through MSE — no tag plays progressively.
            "caps": {"containers": ["mp4"], "video_codecs": ["hevc"], "audio_codecs": ["aac"]},
        },
    ).json()

    assert decision["method"] == "remux"
    assert decision["reason"].endswith("this client plays no HEVC tag progressively")


@requires_hevc
def test_a_file_that_cannot_be_relabelled_says_which_set_is_missing(
    client, library_id: str, library_root: Path
) -> None:
    (library_root / "Set08").mkdir(exist_ok=True)
    source = library_root / "Set08" / "whole.mp4"
    _encode(source, tag="hev1")
    relabel = inspect_hevc(source).relabel
    assert relabel is not None
    mangled = bytearray(source.read_bytes())
    offset = relabel.array_offsets[0]
    mangled[offset] = (mangled[offset] & ~0x3F) | 39
    (library_root / "Set08" / "novps.mp4").write_bytes(bytes(mangled))

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            "path": "Set08/novps.mp4",
            # This client *would* take the relabelled result; the file cannot give it.
            "caps": {
                "containers": ["mp4"],
                "video_codecs": ["hevc", "hvc1"],
                "audio_codecs": ["aac"],
            },
        },
    ).json()

    assert decision["method"] == "remux"
    assert decision["reason"].endswith(
        "its header carries no VPS, so the decoder needs them in-band"
    )


@requires_hevc
def test_a_direct_decision_carries_no_excuse(client, library_id: str, library_root: Path) -> None:
    """Nothing to explain when the relabel worked — the note is for refusals."""
    (library_root / "Set09").mkdir(exist_ok=True)
    _encode(library_root / "Set09" / "fine.mp4", tag="hev1")

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            "path": "Set09/fine.mp4",
            "caps": {
                "containers": ["mp4"],
                "video_codecs": ["hevc", "hvc1"],
                "audio_codecs": ["aac"],
            },
        },
    ).json()

    assert decision["method"] == "direct"
    assert ";" not in decision["reason"]


@requires_hevc
def test_a_tag_that_disagrees_with_the_header_is_reported_as_such(
    client, library_id: str, library_root: Path, monkeypatch
) -> None:
    """The one refusal that means a defect here, not a property of the file."""
    (library_root / "Set10").mkdir(exist_ok=True)
    # Genuinely `hvc1` on disk, so the parser finds no `hev1` entry to relabel...
    _encode(library_root / "Set10" / "mismatch.mp4", tag="hvc1")
    # ...while the probe insists it is `hev1`.
    from cairndex.media import probe_service

    real = probe_service.probe_path

    def lying_probe(abs_path: Path) -> dict[str, object]:
        meta = dict(real(abs_path))
        meta["video_codec_tag"] = "hev1"
        return meta

    monkeypatch.setattr(probe_service, "probe_path", lying_probe)

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            "path": "Set10/mismatch.mp4",
            "caps": {
                "containers": ["mp4"],
                "video_codecs": ["hevc", "hvc1"],
                "audio_codecs": ["aac"],
            },
        },
    ).json()

    assert decision["reason"].endswith("its container header does not match its probed codec tag")
