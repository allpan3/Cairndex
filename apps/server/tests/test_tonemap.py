"""HDR tone mapping on the transcode path.

Two things have to hold at once and they are tested differently. Whether this
ffmpeg *can* tone map is a property of the build, so it is probed and the probe
is tested against real ``-filters`` output — the flags column is two characters
wide on ffmpeg 8 and three on 7, and keying on its width silently matches
nothing at all. Whether the chain *works* is a property of the filters, so it is
tested by running one and reading the colour tags back off the result.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from cairndex.media import tonemap

# Resolved the way the app resolves it (configured path, then PATH, then known
# prefixes) rather than by `which`, so pointing CAIRNDEX_FFMPEG_PATH at a
# zscale-capable build makes the integration test below actually run.
from cairndex.media.tool_paths import ffmpeg_path as _resolve_ffmpeg

_FFMPEG = _resolve_ffmpeg() or shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


@pytest.fixture(autouse=True)
def _clear_probe_cache():
    """The filter set is memoised per process; tests must not inherit it."""
    tonemap._filters.cache_clear()
    yield
    tonemap._filters.cache_clear()


# --- the build probe ----------------------------------------------------------
def _fake_ffmpeg(tmp_path: Path, listing: str) -> Path:
    """A stand-in ffmpeg that prints ``listing`` for ``-filters``."""
    exe = tmp_path / "ffmpeg"
    exe.write_text(f"#!/bin/sh\ncat <<'EOF'\n{listing}\nEOF\n")
    exe.chmod(0o755)
    return exe


FFMPEG_8_LISTING = """Filters:
  T.. = Timeline support
  .S. = Slice threading
  ------
 .S. scale             V->V       Scale the input video size.
 .S. zscale            V->V       Apply resizing, colorspace and bit depth conversion.
 ... tonemap           V->V       Conversion to/from different dynamic ranges.
"""

FFMPEG_7_LISTING = """Filters:
  T.. = Timeline support
  ------
 ..C scale             V->V       Scale the input video size.
 ..C zscale            V->V       Apply resizing, colorspace and bit depth conversion.
"""


def test_it_reads_a_modern_two_flag_listing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )

    assert tonemap._filters() == frozenset({"scale", "zscale", "tonemap"})
    assert tonemap.available() is True


def test_it_reads_a_legacy_three_flag_listing(tmp_path: Path, monkeypatch) -> None:
    """ffmpeg 7 and earlier pad the flags column to three characters."""
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_7_LISTING))
    )

    assert tonemap._filters() == frozenset({"scale", "zscale"})
    assert tonemap.available() is True


def test_a_build_without_zscale_cannot_tone_map(tmp_path: Path, monkeypatch) -> None:
    """Homebrew's ffmpeg is this case: `tonemap` present, `zscale` absent.

    `tonemap` alone is useless — it needs zscale to linearize either side of it —
    so advertising availability on its presence would emit a broken command line.
    """
    listing = (
        "Filters:\n ... tonemap           V->V       Conversion to/from different dynamic ranges.\n"
    )
    monkeypatch.setattr(tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, listing)))

    assert "tonemap" in tonemap._filters()
    assert tonemap.available() is False


def test_no_ffmpeg_at_all_degrades_rather_than_raising(monkeypatch) -> None:
    monkeypatch.setattr(tonemap, "ffmpeg_path", lambda: None)

    assert tonemap._filters() == frozenset()
    assert tonemap.available() is False


def test_an_ffmpeg_that_will_not_run_degrades_too(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(tonemap, "ffmpeg_path", lambda: str(tmp_path / "does-not-exist"))

    assert tonemap.available() is False


def test_the_probe_is_paid_for_once(tmp_path: Path, monkeypatch) -> None:
    """It shells out to ffmpeg, so it must not run per session or per segment."""
    calls: list[int] = []
    real = subprocess.run

    def counting_run(*args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )
    monkeypatch.setattr(subprocess, "run", counting_run)

    for _ in range(5):
        tonemap.available()

    assert len(calls) == 1


# --- the switch ---------------------------------------------------------------
def test_off_disables_tone_mapping_even_where_it_would_work(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )
    monkeypatch.setenv("CAIRNDEX_FFMPEG_TONEMAP", "off")
    from cairndex.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert tonemap.available() is True
        assert tonemap.enabled() is False
    finally:
        get_settings.cache_clear()


# --- what the owner is told ---------------------------------------------------
def test_an_sdr_source_says_nothing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )

    assert tonemap.reason(None) is None
    assert tonemap.reason("") is None


def test_dolby_vision_is_told_it_is_not_converted(tmp_path: Path, monkeypatch) -> None:
    """Excluded on purpose: profile 5 is IPT and this chain would wreck it."""
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )

    assert tonemap.reason("dv") == (
        "Dolby Vision colour is not converted yet, so the picture may look flat"
    )


def test_a_build_that_cannot_tone_map_says_which_filter_is_missing(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(tonemap, "ffmpeg_path", lambda: None)

    assert (
        tonemap.reason("hdr10") == "this ffmpeg has no zscale filter, so HDR cannot be tone mapped"
    )


def test_a_working_build_says_it_is_tone_mapping(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        tonemap, "ffmpeg_path", lambda: str(_fake_ffmpeg(tmp_path, FFMPEG_8_LISTING))
    )

    assert tonemap.reason("hdr10") == "HDR is tone mapped to SDR"
    assert tonemap.reason("HLG") == "HDR is tone mapped to SDR"


# --- and the chain actually converts ------------------------------------------
@requires_ffmpeg
def test_the_chain_lands_on_bt709(tmp_path: Path) -> None:
    """The claim, measured: PQ/BT.2020 in, BT.709 out.

    Skipped rather than faked where the build has no zscale — a green test on a
    build that cannot do the work would be the opposite of evidence.
    """
    assert _FFMPEG is not None
    listing = subprocess.run(
        [_FFMPEG, "-hide_banner", "-filters"], capture_output=True, check=False
    ).stdout.decode(errors="replace")
    if " zscale " not in listing:
        pytest.skip("this ffmpeg has no zscale; the chain cannot be exercised")

    source = tmp_path / "hdr10.mp4"
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=2",
            "-c:v", "libx265", "-x265-params",
            "log-level=none:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
            "-pix_fmt", "yuv420p10le", "-color_trc", "smpte2084", str(source),
        ],
        check=True, capture_output=True,
    )  # fmt: skip

    out = tmp_path / "sdr.mp4"
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error", "-i", str(source),
            "-vf", ",".join(tonemap.chain()),
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(out),
        ],
        check=True, capture_output=True,
    )  # fmt: skip

    from cairndex.media.ffprobe import normalize_metadata, run_ffprobe

    meta = normalize_metadata(run_ffprobe(out))
    assert meta["hdr"] is None, "the output must no longer signal HDR"


# --- and the decision carries it, which is where it gets read ------------------
@requires_ffmpeg
def test_a_transcoded_hdr_source_says_what_happens_to_its_colour(
    client, library_id: str, library_root: Path, monkeypatch
) -> None:
    """Flat colour with no explanation is the thing being fixed here."""
    assert _FFMPEG is not None
    (library_root / "Set11").mkdir(exist_ok=True)
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=2",
            "-c:v", "libx265", "-x265-params",
            "log-level=none:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
            "-pix_fmt", "yuv420p10le", "-color_trc", "smpte2084",
            str(library_root / "Set11" / "hdr.mp4"),
        ],
        check=True, capture_output=True,
    )  # fmt: skip
    monkeypatch.setattr(tonemap, "available", lambda: True)

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            # No HEVC at all, so this transcodes rather than remuxing.
            "path": "Set11/hdr.mp4",
            "caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]},
        },
    ).json()

    assert decision["method"] == "transcode"
    assert decision["reason"].endswith("HDR is tone mapped to SDR")


@requires_ffmpeg
def test_a_directly_played_sdr_source_gains_no_colour_note(
    client, library_id: str, library_root: Path
) -> None:
    """Only a transcode re-encodes, so only a transcode can get colour wrong."""
    assert _FFMPEG is not None
    (library_root / "Set12").mkdir(exist_ok=True)
    subprocess.run(
        [
            _FFMPEG, "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(library_root / "Set12" / "sdr.mp4"),
        ],
        check=True, capture_output=True,
    )  # fmt: skip

    decision = client.post(
        f"/api/v1/libraries/{library_id}/file-browser/playback-decision",
        json={
            "path": "Set12/sdr.mp4",
            "caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]},
        },
    ).json()

    assert decision["method"] == "direct"
    assert "tone map" not in decision["reason"]
