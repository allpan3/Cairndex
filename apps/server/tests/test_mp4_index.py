"""Reading an MP4's keyframe index directly instead of demuxing the file.

The parser only earns its place if it agrees with ffprobe exactly — a playlist
built on drifted timestamps advertises cut points ffmpeg will not honour — so
the substantive tests compare the two on real generated media. The rest pin the
decline paths, since returning ``None`` (and letting ffprobe answer) is the
designed behaviour for anything this does not fully understand.
"""

import shutil
import struct
import subprocess
from pathlib import Path

import pytest

from cairndex.media.ffprobe import ffprobe_available, keyframe_times
from cairndex.media.mp4_index import keyframe_times_from_mp4

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(
    _FFMPEG is None or not ffprobe_available(),
    reason="ffmpeg/ffprobe not installed",
)


def _encode(path: Path, *, extra: list[str] | None = None, seconds: int = 4) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=duration={seconds}:size=160x120:rate=25",
            "-c:v",
            "libx264",
            "-g",
            "25",
            "-pix_fmt",
            "yuv420p",
            *(extra or []),
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@requires_ffmpeg
def test_matches_ffprobe_on_a_plain_mp4(tmp_path: Path) -> None:
    video = tmp_path / "plain.mp4"
    _encode(video)
    mine = keyframe_times_from_mp4(video)
    assert mine is not None
    assert mine == pytest.approx(keyframe_times(video), abs=1e-6)


@requires_ffmpeg
def test_matches_ffprobe_with_b_frames_and_an_edit_list(tmp_path: Path) -> None:
    # B-frames put presentation order out of step with decode order (a `ctts`
    # table), and ffmpeg writes an edit list to compensate for the reorder
    # delay. Ignoring either shifts every timestamp by a constant — which is
    # exactly the bug this test was written after.
    video = tmp_path / "bframes.mp4"
    _encode(video, extra=["-bf", "3", "-profile:v", "high"], seconds=6)
    mine = keyframe_times_from_mp4(video)
    assert mine is not None
    assert mine == pytest.approx(keyframe_times(video), abs=1e-6)


@requires_ffmpeg
def test_reads_the_index_when_moov_is_at_the_end(tmp_path: Path) -> None:
    # Without `+faststart` the index trails the media, so the parser has to seek
    # past a large `mdat` rather than assume a header-first layout.
    trailing = tmp_path / "trailing.mp4"
    leading = tmp_path / "leading.mp4"
    _encode(trailing)
    _encode(leading, extra=["-movflags", "+faststart"])
    assert keyframe_times_from_mp4(trailing) is not None
    assert keyframe_times_from_mp4(leading) is not None
    assert keyframe_times_from_mp4(trailing) == pytest.approx(
        keyframe_times_from_mp4(leading), abs=1e-6
    )


@requires_ffmpeg
def test_declines_a_matroska_file_so_ffprobe_answers(tmp_path: Path) -> None:
    video = tmp_path / "clip.mkv"
    _encode(video)
    assert keyframe_times_from_mp4(video) is None


@requires_ffmpeg
def test_declines_a_fragmented_mp4(tmp_path: Path) -> None:
    # Fragmented MP4 keeps its timing in per-fragment boxes, with no `stss` in
    # `moov` — the parser must not read that as "no keyframes".
    video = tmp_path / "fragmented.mp4"
    _encode(video, extra=["-movflags", "+frag_keyframe+empty_moov"])
    assert keyframe_times_from_mp4(video) is None


def test_declines_files_that_are_not_mp4_at_all(tmp_path: Path) -> None:
    missing = tmp_path / "nope.mp4"
    assert keyframe_times_from_mp4(missing) is None

    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    assert keyframe_times_from_mp4(empty) is None

    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"this is not a container at all, not even close")
    assert keyframe_times_from_mp4(junk) is None


def test_declines_a_truncated_or_lying_box_header(tmp_path: Path) -> None:
    # A box claiming to be larger than the file must not send the parser past
    # the end, and a size smaller than its own header must not loop forever.
    oversize = tmp_path / "oversize.mp4"
    oversize.write_bytes(struct.pack(">I", 8) + b"ftyp" + struct.pack(">I", 1 << 30) + b"moov")
    assert keyframe_times_from_mp4(oversize) is None

    undersize = tmp_path / "undersize.mp4"
    undersize.write_bytes(struct.pack(">I", 8) + b"ftyp" + struct.pack(">I", 2) + b"moov")
    assert keyframe_times_from_mp4(undersize) is None
