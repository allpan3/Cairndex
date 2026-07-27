"""Contact sheets: grid generation, caching, and the endpoint (plan 1 §10)."""

import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import contact_sheets, derived_cache
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package as pkg
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.services import bundles as bundle_service

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


def _make_video(path: Path, *, duration: int = 20) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=duration={duration}:size=320x180:rate=8",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _video_file(
    session: Session, library_root: Path, *, name: str = "movie.mp4", duration: float = 20.0
) -> AssetFile:
    bundle = bundle_service.create_bundle(session, title=name)
    asset_file = bundle_service.add_file(
        session,
        bundle.id,
        relative_path=name,
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    asset_file.tech_metadata = {"duration": duration, "width": 320, "height": 180}
    stat = (library_root / name).stat()
    asset_file.quick_fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    session.flush()
    return asset_file


def _jpeg_size(path: Path) -> tuple[int, int]:
    """Width/height straight from the JPEG's SOF marker — no image library."""
    data = path.read_bytes()
    i = 2
    while i < len(data) - 9:
        assert data[i] == 0xFF
        marker = data[i + 1]
        length = int.from_bytes(data[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC2):
            height = int.from_bytes(data[i + 5 : i + 7], "big")
            width = int.from_bytes(data[i + 7 : i + 9], "big")
            return width, height
        i += 2 + length
    raise AssertionError("no SOF marker found")


@requires_ffmpeg
def test_generates_a_grid_of_the_requested_shape(session: Session, library_root: Path) -> None:
    _make_video(library_root / "movie.mp4")
    asset_file = _video_file(session, library_root)

    path, times = contact_sheets.sheet_for_file(session, asset_file.id, cols=4, rows=4, width=1280)

    assert path.is_relative_to(pkg.cache_dir(library_root) / "contact-sheets")
    # One timestamp per cell, in reading order, inside the trimmed span.
    assert len(times) == 16
    assert times == sorted(times)
    assert 0 < times[0] < times[-1] < 20.0
    width, height = _jpeg_size(path)
    # 4 columns of 320px cells plus the tile padding; height follows 16:9 cells.
    assert 1280 <= width <= 1280 + 3 * 2 + 4
    assert height >= 4 * (180 - 4)
    assert derived_cache.read_fingerprint(path) == asset_file.quick_fingerprint


@requires_ffmpeg
def test_reuses_the_cache_until_the_source_changes(session: Session, library_root: Path) -> None:
    _make_video(library_root / "movie.mp4")
    asset_file = _video_file(session, library_root)

    first, first_times = contact_sheets.sheet_for_file(session, asset_file.id)
    stamp = first.stat().st_mtime_ns
    again, again_times = contact_sheets.sheet_for_file(session, asset_file.id)
    assert again.stat().st_mtime_ns == stamp  # cache hit, not a regeneration
    assert again_times == first_times  # …and the labels survive the cache hit

    # New bytes at the path → new fingerprint → regenerate.
    _make_video(library_root / "movie.mp4", duration=21)
    stat = (library_root / "movie.mp4").stat()
    asset_file.quick_fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    session.flush()
    regenerated, _ = contact_sheets.sheet_for_file(session, asset_file.id)
    assert regenerated.stat().st_mtime_ns != stamp


def test_an_unprobed_video_is_refused_with_the_reason(session: Session, library_root: Path) -> None:
    (library_root / "movie.mp4").write_bytes(b"x")
    asset_file = _video_file(session, library_root)
    asset_file.tech_metadata = None
    session.flush()

    with pytest.raises(ValidationError, match="probed"):
        contact_sheets.sheet_for_file(session, asset_file.id)


def test_grid_bounds_are_enforced(session: Session, library_root: Path) -> None:
    (library_root / "movie.mp4").write_bytes(b"x")
    asset_file = _video_file(session, library_root)

    with pytest.raises(ValidationError):
        contact_sheets.sheet_for_file(session, asset_file.id, cols=1, rows=4)
    with pytest.raises(ValidationError):
        contact_sheets.sheet_for_file(session, asset_file.id, width=999)


@requires_ffmpeg
def test_endpoint_serves_the_sheet(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    _make_video(library_root / "movie.mp4")
    asset_file = _video_file(session, library_root)
    session.commit()

    response = client.get(
        f"/api/v1/libraries/{library_id}/files/{asset_file.id}/contact-sheet",
        params={"cols": 3, "rows": 2, "width": 1280},
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert len(response.content) > 1000


def test_every_slice_of_the_video_gets_a_frame() -> None:
    """The sampling rule the client labels cells from, pinned on its own.

    Each cell stands for one slice of the video and is taken from the middle of
    its slice. Sampling the leading edge instead left the last slice
    unrepresented — on a long video that was minutes of footage that never
    appeared on the sheet at all (owner, 2026-07-27).
    """
    duration = 3600.0
    times = contact_sheets.frame_times(duration, 4, 4)

    assert len(times) == 16
    gaps = [b - a for a, b in zip(times, times[1:], strict=False)]
    assert all(gap == pytest.approx(gaps[0]) for gap in gaps)  # evenly spaced

    # Symmetric: the head and the tail left over are the same half-slice, so no
    # part of the video is systematically missing from the sheet.
    interval = gaps[0]
    assert times[0] == pytest.approx(duration - times[-1], abs=0.01)
    assert times[0] < interval  # …and that leftover is less than one slice
    assert duration - times[-1] < interval


def test_the_edge_trim_does_not_scale_with_the_video() -> None:
    """Skipping a lead-in must not mean skipping minutes of a feature.

    The trim is a fraction with a ceiling: 4% of a short clip is a beat, 4% of a
    two-hour film is nearly five minutes off each end.
    """
    short_times = contact_sheets.frame_times(60.0, 4, 4)
    long_times = contact_sheets.frame_times(7200.0, 4, 4)

    short_interval = short_times[1] - short_times[0]
    long_interval = long_times[1] - long_times[0]
    # Both start half a slice in from their trim point, and the trim itself is
    # capped, so the long video's head is seconds rather than minutes of trim.
    assert short_times[0] - short_interval / 2 < 3.0
    assert long_times[0] - long_interval / 2 <= 5.0


@requires_ffmpeg
def test_a_grid_costs_the_same_however_long_the_video_is(
    session: Session, library_root: Path
) -> None:
    """Seeking per frame, not decoding to sample.

    The distinction is why long videos stopped failing: `fps=1/n` sampling
    decodes everything between the first frame and the last, so a long video
    costs proportionally more. Two videos, one four times the length of the
    other, must cost about the same here.
    """
    _make_video(library_root / "short.mp4", duration=8)
    _make_video(library_root / "long.mp4", duration=32)
    short_file = _video_file(session, library_root, name="short.mp4", duration=8.0)
    long_file = _video_file(session, library_root, name="long.mp4", duration=32.0)

    started = time.perf_counter()
    contact_sheets.sheet_for_file(session, short_file.id, cols=3, rows=3, width=1280)
    short_seconds = time.perf_counter() - started

    started = time.perf_counter()
    contact_sheets.sheet_for_file(session, long_file.id, cols=3, rows=3, width=1280)
    long_seconds = time.perf_counter() - started

    # Generous bound: this asserts the *shape* of the cost, not a benchmark.
    # Decode-and-sample made the long video ~4x the short one; seeking makes the
    # two comparable, and process startup dominates at these sizes.
    assert long_seconds < short_seconds * 2.5 + 1.0
