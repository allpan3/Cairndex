"""Storyboards: generation math, cache invalidation, endpoints, and jobs."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.abort import OperationAborted
from cairndex.core.config import get_settings
from cairndex.domain.enums import FileRole, JobStatus, JobType, MediaKind
from cairndex.jobs.worker import execute_job
from cairndex.media import derived_cache, storyboards
from cairndex.media.ffmpeg_exec import FfmpegError, run_ffmpeg
from cairndex.media.storyboard_handler import storyboard_job_handler
from cairndex.persistence.models import AssetFile
from cairndex.registry import jobs as job_service
from cairndex.registry import library_package as pkg
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.services import bundles as bundle_service

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


# Encode a fixture with a chosen keyframe spacing
def _encode(path: Path, source: str, *, gop: int) -> None:
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
            source,
            "-c:v",
            "libx264",
            # Keyframe sampling can only sample where keyframes are, so every
            # fixture states its GOP: `scenecut=0` keeps x264 from inserting
            # extra keyframes and making the sampled timestamps encoder-dependent.
            "-g",
            str(gop),
            "-x264-params",
            "scenecut=0",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


# Generate a tiny but long-enough browser video fixture, keyframed every 2s
def _make_video(path: Path, *, duration: int = 65) -> None:
    _encode(path, f"testsrc=duration={duration}:size=160x90:rate=1", gop=2)


# Generate motion-distinct frames for storyboard sampling verification
def _make_sampling_video(path: Path, *, gop: int = 60) -> None:
    _encode(path, "testsrc2=duration=4:size=160x90:rate=30", gop=gop)


# Decode one RGB frame with an optional exact seek and crop/scale filter
def _rgb_frame(path: Path, vf: str, *, at: float | None = None) -> bytes:
    assert _FFMPEG is not None
    args = [_FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(path)]
    if at is not None:
        args.extend(["-ss", str(at)])
    args.extend(["-vf", vf, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
    return subprocess.run(args, check=True, capture_output=True).stdout


# Return mean absolute RGB-channel error between equal-sized decoded frames
def _mean_absolute_error(left: bytes, right: bytes) -> float:
    assert len(left) == len(right)
    return sum(abs(a - b) for a, b in zip(left, right, strict=True)) / len(left)


# Add a video AssetFile with enough probe metadata for storyboard generation
def _video_file(
    session: Session,
    library_root: Path,
    *,
    name: str = "movie.mp4",
    duration: float = 65.0,
    size: bytes = b"video",
) -> AssetFile:
    target = library_root / name
    target.write_bytes(size)
    stat = target.stat()
    bundle = bundle_service.create_bundle(session, title=name)
    asset_file = bundle_service.add_file(
        session,
        bundle.id,
        relative_path=name,
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    asset_file.tech_metadata = {
        "duration": duration,
        "width": 160,
        "height": 90,
        "video_codec": "h264",
        "chapters": [{"start": 0.0, "end": duration, "title": "Intro"}],
    }
    asset_file.quick_fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    session.commit()
    return asset_file


# Build a tiny JPEG header with SOF dimensions for geometry tests
def _jpeg_bytes(width: int = 1600, height: int = 900) -> bytes:
    return (
        b"\xff\xd8"
        b"\xff\xc0\x00\x11\x08"
        + height.to_bytes(2, "big")
        + width.to_bytes(2, "big")
        + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
        b"\xff\xd9"
    )


# Write one fake storyboard sheet so tests can avoid invoking ffmpeg
def _fake_generate_sheets(
    _source: Path, output_dir: Path, interval: float, _duration: float, **_kwargs: object
) -> list[float]:
    (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())
    return [index * interval for index in range(25)]


@requires_ffmpeg
def test_generates_vtt_with_exact_interval_tiles_and_coords(
    session: Session, library_root: Path
) -> None:
    _make_video(library_root / "movie.mp4", duration=65)
    asset_file = _video_file(
        session,
        library_root,
        duration=65.0,
        size=(library_root / "movie.mp4").read_bytes(),
    )

    result = storyboards.generate_for_file(session, asset_file.id)
    assert result.path is not None
    index_path = result.path
    text = index_path.read_text(encoding="utf-8")
    payloads = [line for line in text.splitlines() if "#xywh=" in line]
    version = storyboards.storyboard_version_param(asset_file.quick_fingerprint)

    assert index_path.is_relative_to(pkg.cache_dir(library_root) / "storyboards")
    assert len(payloads) == 33
    assert f"NOTE cairndex-quick-fingerprint: {asset_file.quick_fingerprint}" in text
    assert "00:00:00.000 --> 00:00:02.000" in text
    assert "00:01:04.000 --> 00:01:05.000" in text
    assert payloads[0] == f"storyboard/sb_001.jpg?v={version}#xywh=0,0,320,180"
    assert payloads[4] == f"storyboard/sb_001.jpg?v={version}#xywh=1280,0,320,180"
    assert payloads[5] == f"storyboard/sb_001.jpg?v={version}#xywh=0,180,320,180"
    assert payloads[24] == f"storyboard/sb_001.jpg?v={version}#xywh=1280,720,320,180"
    assert payloads[25] == f"storyboard/sb_002.jpg?v={version}#xywh=0,0,320,180"
    assert payloads[32] == f"storyboard/sb_002.jpg?v={version}#xywh=640,180,320,180"
    assert (index_path.parent / "sb_001.jpg").exists()
    assert (index_path.parent / "sb_002.jpg").exists()
    assert derived_cache.read_fingerprint(index_path) == storyboards.storyboard_cache_key(
        asset_file.quick_fingerprint
    )


@requires_ffmpeg
def test_storyboard_tiles_match_frames_at_their_own_vtt_cue_starts(tmp_path: Path) -> None:
    source = tmp_path / "sampling.mp4"
    _make_sampling_video(source)  # keyframes at 0s and 2s

    assert storyboards._generate_sheets(source, tmp_path, 2, 4) == [0.0, 2.0]
    sheet = tmp_path / "sb_001.jpg"
    tile_zero = _rgb_frame(sheet, "crop=320:180:0:0")
    tile_two = _rgb_frame(sheet, "crop=320:180:320:0")
    source_zero = _rgb_frame(source, "scale=320:-2", at=0)
    source_one = _rgb_frame(source, "scale=320:-2", at=1)
    source_two = _rgb_frame(source, "scale=320:-2", at=2)
    source_three = _rgb_frame(source, "scale=320:-2", at=3)

    zero_error = _mean_absolute_error(tile_zero, source_zero)
    two_error = _mean_absolute_error(tile_two, source_two)
    assert zero_error < 12
    assert two_error < 12
    assert zero_error < _mean_absolute_error(tile_zero, source_one) / 2
    assert two_error < _mean_absolute_error(tile_two, source_three) / 2


@requires_ffmpeg
def test_keyframe_sampling_cues_the_keyframes_a_video_actually_has(
    session: Session, library_root: Path
) -> None:
    # Sampling wants a tile every 2s; this source only offers a keyframe every
    # 5s, so the cues must describe the frames that exist rather than claim
    # tiles at 2s boundaries that were never sampled.
    _encode(library_root / "movie.mp4", "testsrc=duration=40:size=160x90:rate=1", gop=5)
    asset_file = _video_file(
        session,
        library_root,
        duration=40.0,
        size=(library_root / "movie.mp4").read_bytes(),
    )

    result = storyboards.generate_for_file(session, asset_file.id)
    assert result.path is not None
    lines = result.path.read_text(encoding="utf-8").splitlines()
    payloads = [line for line in lines if "#xywh=" in line]
    timings = [line for line in lines if "-->" in line]

    assert storyboards.storyboard_interval(40.0) == 2.0
    assert len(payloads) == 8
    assert len(timings) == len(payloads)  # one cue per sampled tile, never per slot
    assert timings[0] == "00:00:00.000 --> 00:00:05.000"
    assert timings[1] == "00:00:05.000 --> 00:00:10.000"
    assert timings[-1] == "00:00:35.000 --> 00:00:40.000"
    assert payloads[7] == payloads[7].replace("sb_002", "sb_001")  # still the first sheet
    # Sheets are addressed by index, so the pass must write exactly the sheets
    # the tiles fill: rate-syncing irregular sampling into a constant frame rate
    # duplicates sheets and points every later cue at a copy.
    assert sorted(path.name for path in result.path.parent.glob("sb_*.jpg")) == ["sb_001.jpg"]


@requires_ffmpeg
def test_video_without_usable_keyframes_falls_back_to_full_decode(
    caplog: pytest.LogCaptureFixture, session: Session, library_root: Path
) -> None:
    _encode(library_root / "movie.mp4", "testsrc=duration=40:size=160x90:rate=1", gop=10_000)
    asset_file = _video_file(
        session,
        library_root,
        duration=40.0,
        size=(library_root / "movie.mp4").read_bytes(),
    )

    with caplog.at_level("INFO"):
        result = storyboards.generate_for_file(session, asset_file.id)

    assert result.path is not None
    payloads = [
        line for line in result.path.read_text(encoding="utf-8").splitlines() if "#xywh=" in line
    ]
    assert len(payloads) == 20  # the full 40s / 2s grid, not the source's one keyframe
    assert "decoding in full" in caplog.text


def test_exact_sampling_setting_skips_keyframe_sampling(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)
    modes: list[object] = []

    def capture(
        source: Path,
        output_dir: Path,
        interval: float,
        duration: float,
        *,
        sampling: str = "keyframe",
    ) -> list[float]:
        modes.append(sampling)
        return _fake_generate_sheets(source, output_dir, interval, duration)

    monkeypatch.setattr(storyboards, "_generate_sheets", capture)
    monkeypatch.setenv("CAIRNDEX_STORYBOARD_SAMPLING", "exact")
    get_settings.cache_clear()
    try:
        storyboards.generate_for_file(session, asset_file.id)
    finally:
        get_settings.cache_clear()

    assert modes == ["exact"]


def test_switching_sampling_mode_retires_cached_sheets(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)
    monkeypatch.setattr(storyboards, "_generate_sheets", _fake_generate_sheets)
    storyboards.generate_for_file(session, asset_file.id)

    assert storyboards.is_current_index(library_root, asset_file.id, asset_file.quick_fingerprint)

    monkeypatch.setenv("CAIRNDEX_STORYBOARD_SAMPLING", "exact")
    get_settings.cache_clear()
    try:
        # Sheets sampled the other way are a different artifact, not a stale one
        assert not storyboards.is_current_index(
            library_root, asset_file.id, asset_file.quick_fingerprint
        )
        assert storyboards.generate_for_file(session, asset_file.id).status == "generated"
    finally:
        get_settings.cache_clear()


def test_cues_stop_at_the_first_unusable_sample_time() -> None:
    # Tile position is list position, so a sample past the probed duration ends
    # the cue list; skipping it would put every later cue on the wrong tile.
    cues = storyboards._build_cues(
        duration=10.0,
        interval=2.0,
        times=[0.0, 2.0, 11.0, 4.0],
        sheets=[Path("sb_001.jpg")],
        sheet_width=1600,
        sheet_height=900,
    )

    assert [(cue.start, cue.end) for cue in cues] == [(0.0, 2.0), (2.0, 10.0)]


def test_job_idempotence_and_fingerprint_invalidation(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=120.0)
    calls = {"count": 0}

    def fake(
        source: Path, output_dir: Path, interval: float, duration: float, **_kwargs: object
    ) -> list[float]:
        calls["count"] += 1
        return _fake_generate_sheets(source, output_dir, interval, duration)

    monkeypatch.setattr(storyboards, "_generate_sheets", fake)

    first = storyboards.generate_for_library(session)
    second = storyboards.generate_for_library(session)
    asset_file.quick_fingerprint = "changed"
    session.commit()
    third = storyboards.generate_for_library(session)

    assert first.generated == 1
    assert second.skipped == 1
    assert third.generated == 1
    assert calls["count"] == 2


def test_generate_for_file_truncates_cues_to_emitted_sheets(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=5_000.0)
    monkeypatch.setattr(storyboards, "_generate_sheets", _fake_generate_sheets)

    result = storyboards.generate_for_file(session, asset_file.id)
    assert result.path is not None
    payloads = [
        line for line in result.path.read_text(encoding="utf-8").splitlines() if "#xywh=" in line
    ]

    assert len(payloads) == 25
    assert payloads[-1].endswith("#xywh=1280,720,320,180")


def test_generate_for_file_trims_padding_tiles_mid_sheet(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)

    def short_stream(
        _source: Path, output_dir: Path, interval: float, _duration: float, **_kwargs: object
    ) -> list[float]:
        (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())
        return [index * interval for index in range(17)]

    monkeypatch.setattr(storyboards, "_generate_sheets", short_stream)
    result = storyboards.generate_for_file(session, asset_file.id)

    assert result.path is not None
    payloads = [line for line in result.path.read_text().splitlines() if "#xywh=" in line]
    assert len(payloads) == 17
    assert payloads[-1].endswith("#xywh=320,540,320,180")


def test_generate_sheets_reads_sample_times_from_showinfo_in_same_pass(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured: list[str] = []

    def fake_run(args: list[str], **_kwargs: object) -> str:
        captured.extend(args)
        Path(args[-1].replace("%03d", "001")).write_bytes(_jpeg_bytes())
        return (
            "[Parsed_showinfo_2] n:   0 pts:0 pts_time:0\n"
            "[Parsed_showinfo_2] n:   1 pts:76800 pts_time:5.12"
        )

    monkeypatch.setattr(storyboards, "run_ffmpeg", fake_run)
    assert storyboards._generate_sheets(tmp_path / "in.mp4", tmp_path, 2, 60) == [0.0, 5.12]
    assert "-skip_frame" in captured
    assert "prev_selected_t" in next(arg for arg in captured if "select=" in arg)


def test_generate_sheets_exact_mode_decodes_every_frame_on_the_interval_grid(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured: list[str] = []

    def fake_run(args: list[str], **_kwargs: object) -> str:
        captured.extend(args)
        return "[Parsed_showinfo_2] n: 0 pts:0 pts_time:0"

    monkeypatch.setattr(storyboards, "run_ffmpeg", fake_run)
    storyboards._generate_sheets(tmp_path / "in.mp4", tmp_path, 2, 60, sampling="exact")

    assert "-skip_frame" not in captured
    assert "fps=1/2:start_time=0:round=up" in next(arg for arg in captured if "fps=" in arg)


def test_generate_sheets_strips_ansi_before_reading_showinfo(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_run(_args: list[str], **_kwargs: object) -> str:
        return (
            "\x1b[32m[Parsed_showinfo_2]\x1b[0m n: 0 pts_time:0\n"
            "\x1b[31mshowinfo\x1b[0m n: 8 pts_time:16.5"
        )

    monkeypatch.setattr(storyboards, "run_ffmpeg", fake_run)
    assert storyboards._generate_sheets(tmp_path / "in.mp4", tmp_path, 2, 60) == [0.0, 16.5]


def test_generate_for_file_falls_back_to_sheet_capacity_without_showinfo(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    session: Session,
    library_root: Path,
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)

    def no_count(
        _source: Path, output_dir: Path, _interval: float, _duration: float, **_kwargs: object
    ) -> None:
        (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())

    monkeypatch.setattr(storyboards, "_generate_sheets", no_count)
    with caplog.at_level("WARNING"):
        result = storyboards.generate_for_file(session, asset_file.id)

    assert result.path is not None
    payloads = [line for line in result.path.read_text().splitlines() if "#xywh=" in line]
    assert len(payloads) == 25
    assert "showinfo frame count unavailable" in caplog.text


def test_ffmpeg_runner_times_out_fake_hanging_executable() -> None:
    with pytest.raises(FfmpegError, match="timed out"):
        run_ffmpeg(
            [sys.executable, "-c", "import time; time.sleep(2)"],
            timeout=0.01,
        )


def test_min_duration_and_disabled_config_skip(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    _video_file(session, library_root, name="below-threshold.mp4", duration=9.0)
    _video_file(session, library_root, name="at-threshold.mp4", duration=10.0)
    monkeypatch.setattr(storyboards, "_generate_sheets", _fake_generate_sheets)

    threshold = storyboards.generate_for_library(session)
    assert threshold.generated == 1
    assert threshold.skipped == 1

    monkeypatch.setenv("CAIRNDEX_STORYBOARDS", "off")
    get_settings.cache_clear()
    try:
        disabled = storyboards.generate_for_library(session)
    finally:
        get_settings.cache_clear()
    assert disabled.generated == 0
    assert disabled.skipped == 2


def test_cached_endpoints_404_until_artifacts_exist_and_validate_sheet_names(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=90.0)
    base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}"

    assert client.get(f"{base}/storyboard.vtt").status_code == 404

    cache_dir = storyboards.storyboard_cache_dir(library_root, asset_file.id)
    cache_dir.mkdir(parents=True)
    cue = storyboards.StoryboardCue(0, 2, 1, 0, 0, 320, 180)
    index = cache_dir / "index.vtt"
    index.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nold.jpg#xywh=0,0,320,180\n")
    derived_cache.write_fingerprint(index, asset_file.quick_fingerprint)
    (cache_dir / "sb_001.jpg").write_bytes(b"jpg")
    assert client.get(f"{base}/storyboard.vtt").status_code == 404

    index.write_text(
        storyboards.render_vtt([cue], asset_file.quick_fingerprint),
        encoding="utf-8",
    )
    derived_cache.write_fingerprint(
        index, storyboards.storyboard_cache_key(asset_file.quick_fingerprint)
    )

    vtt = client.get(f"{base}/storyboard.vtt")
    assert vtt.status_code == 200
    assert vtt.headers["content-type"].startswith("text/vtt")
    assert vtt.headers["cache-control"] == storyboards.STORYBOARD_INDEX_CACHE_CONTROL

    sheet = client.get(f"{base}/storyboard/sb_001.jpg")
    assert sheet.status_code == 200
    assert sheet.headers["content-type"] == "image/jpeg"
    assert sheet.headers["cache-control"] == storyboards.STORYBOARD_CACHE_CONTROL

    assert client.get(f"{base}/storyboard/sb_002.jpg").status_code == 404
    assert client.get(f"{base}/storyboard/not-a-sheet.jpg").status_code == 404


def test_playback_manifest_includes_current_storyboard_and_chapters(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=90.0)
    cache_dir = storyboards.storyboard_cache_dir(library_root, asset_file.id)
    cache_dir.mkdir(parents=True)
    cue = storyboards.StoryboardCue(0, 2, 1, 0, 0, 320, 180)
    (cache_dir / "index.vtt").write_text(
        storyboards.render_vtt([cue], asset_file.quick_fingerprint),
        encoding="utf-8",
    )
    derived_cache.write_fingerprint(
        cache_dir / "index.vtt", storyboards.storyboard_cache_key(asset_file.quick_fingerprint)
    )
    (cache_dir / "sb_001.jpg").write_bytes(b"jpg")

    body = client.get(
        f"/api/v1/libraries/{library_id}/bundles/{asset_file.bundle_id}/playback"
    ).json()
    video = body["videos"][0]
    version = storyboards.storyboard_version_param(asset_file.quick_fingerprint)
    assert video["storyboard_url"] == (
        f"/api/v1/libraries/{library_id}/files/{asset_file.id}/storyboard.vtt?v={version}"
    )
    assert video["chapters"] == [{"start": 0.0, "end": 90.0, "title": "Intro"}]


# Current-index checks read only the small sidecar on manifest hot paths
def test_current_index_does_not_read_vtt(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=90.0)
    index = storyboards.storyboard_index_path(library_root, asset_file.id)
    index.parent.mkdir(parents=True)
    index.write_text("WEBVTT\n", encoding="utf-8")
    derived_cache.write_fingerprint(
        index, storyboards.storyboard_cache_key(asset_file.quick_fingerprint)
    )
    original_read_text = Path.read_text

    def guarded_read_text(
        path: Path, encoding: str | None = None, errors: str | None = None
    ) -> str:
        if path.suffix == ".vtt":
            raise AssertionError("current-index validation opened the VTT")
        return original_read_text(path, encoding=encoding, errors=errors)

    monkeypatch.setattr(Path, "read_text", guarded_read_text)

    assert storyboards.is_current_index(library_root, asset_file.id, asset_file.quick_fingerprint)


def test_storyboard_job_honors_cancellation(
    registry_session_factory: sessionmaker[Session], registry_session: Session, library_id: str
) -> None:
    job = job_service.create_job(
        registry_session, library_id=library_id, job_type=JobType.STORYBOARD
    )
    job_service.request_cancel(registry_session, job.id)
    registry_session.commit()

    status = execute_job(
        registry_session_factory,
        job.id,
        {JobType.STORYBOARD: storyboard_job_handler},
    )

    assert status == JobStatus.CANCELLED


def test_a_stopped_generation_leaves_no_half_built_directory(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)

    def stopped_pass(
        _source: Path, output_dir: Path, _interval: float, _duration: float, **_kwargs: object
    ) -> list[float]:
        (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())
        raise OperationAborted("ffmpeg stopped")

    monkeypatch.setattr(storyboards, "_generate_sheets", stopped_pass)
    with pytest.raises(OperationAborted):
        storyboards.generate_for_file(session, asset_file.id)

    # A stop is not a failure, so it does not unwind through the failure path —
    # which is exactly how interrupted runs used to leave temp dirs behind.
    cache_dir = storyboards.storyboard_cache_dir(library_root, asset_file.id)
    assert list(cache_dir.parent.glob("*.tmp-*")) == []


def test_library_pass_sweeps_what_an_interrupted_run_left_behind(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)
    monkeypatch.setattr(storyboards, "_generate_sheets", _fake_generate_sheets)
    cache_dir = storyboards.storyboard_cache_dir(library_root, asset_file.id)
    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    stray = cache_dir.parent / f"{cache_dir.name}.tmp-9f3c1a"
    stray.mkdir()
    (stray / "sb_001.jpg").write_bytes(_jpeg_bytes())
    interrupted_swap = cache_dir.parent / f"{cache_dir.name}.old"
    interrupted_swap.mkdir()

    summary = storyboards.generate_for_library(session)

    assert not stray.exists()
    assert not interrupted_swap.exists()
    assert summary.generated == 1
    assert (cache_dir / "index.vtt").exists()
