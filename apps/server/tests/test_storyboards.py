"""Storyboards: generation math, cache invalidation, endpoints, and jobs."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

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


# Generate a tiny but long-enough browser video fixture
def _make_video(path: Path, *, duration: int = 65) -> None:
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
            f"testsrc=duration={duration}:size=160x90:rate=1",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


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
    _source: Path, output_dir: Path, _interval: float, _duration: float
) -> int:
    (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())
    return 25


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
    version = asset_file.quick_fingerprint.replace(":", "%3A")

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
    assert derived_cache.read_fingerprint(index_path) == asset_file.quick_fingerprint


def test_job_idempotence_and_fingerprint_invalidation(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=120.0)
    calls = {"count": 0}

    def fake(source: Path, output_dir: Path, interval: float, duration: float) -> int:
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

    def short_stream(_source: Path, output_dir: Path, _interval: float, _duration: float) -> int:
        (output_dir / "sb_001.jpg").write_bytes(_jpeg_bytes())
        return 17

    monkeypatch.setattr(storyboards, "_generate_sheets", short_stream)
    result = storyboards.generate_for_file(session, asset_file.id)

    assert result.path is not None
    payloads = [line for line in result.path.read_text().splitlines() if "#xywh=" in line]
    assert len(payloads) == 17
    assert payloads[-1].endswith("#xywh=320,540,320,180")


def test_generate_sheets_counts_showinfo_frames_in_same_pass(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_run(args: list[str], **_kwargs: object) -> str:
        Path(args[-1].replace("%03d", "001")).write_bytes(_jpeg_bytes())
        return "[Parsed_showinfo_2] n:   0 pts:0\n[Parsed_showinfo_2] n:  16 pts:16"

    monkeypatch.setattr(storyboards, "run_ffmpeg", fake_run)
    assert storyboards._generate_sheets(tmp_path / "in.mp4", tmp_path, 2, 60) == 17


def test_generate_sheets_strips_ansi_before_counting_showinfo(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_run(_args: list[str], **_kwargs: object) -> str:
        return "\x1b[32m[Parsed_showinfo_2]\x1b[0m n: 0\n\x1b[31mshowinfo\x1b[0m n: 8"

    monkeypatch.setattr(storyboards, "run_ffmpeg", fake_run)
    assert storyboards._generate_sheets(tmp_path / "in.mp4", tmp_path, 2, 60) == 9


def test_generate_for_file_falls_back_to_sheet_capacity_without_showinfo(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    session: Session,
    library_root: Path,
) -> None:
    asset_file = _video_file(session, library_root, duration=60.0)

    def no_count(_source: Path, output_dir: Path, _interval: float, _duration: float) -> None:
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
    _video_file(session, library_root, name="short.mp4", duration=20.0)
    monkeypatch.setattr(storyboards, "_generate_sheets", _fake_generate_sheets)

    short = storyboards.generate_for_library(session)
    assert short.generated == 0
    assert short.skipped == 1

    monkeypatch.setenv("CAIRNDEX_STORYBOARDS", "off")
    get_settings.cache_clear()
    try:
        disabled = storyboards.generate_for_library(session)
    finally:
        get_settings.cache_clear()
    assert disabled.generated == 0
    assert disabled.skipped == 1


def test_cached_endpoints_404_until_artifacts_exist_and_validate_sheet_names(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    asset_file = _video_file(session, library_root, duration=90.0)
    base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}"

    assert client.get(f"{base}/storyboard.vtt").status_code == 404

    cache_dir = storyboards.storyboard_cache_dir(library_root, asset_file.id)
    cache_dir.mkdir(parents=True)
    cue = storyboards.StoryboardCue(0, 2, 1, 0, 0, 320, 180)
    (cache_dir / "index.vtt").write_text(
        storyboards.render_vtt([cue], asset_file.quick_fingerprint),
        encoding="utf-8",
    )
    derived_cache.write_fingerprint(cache_dir / "index.vtt", asset_file.quick_fingerprint)
    (cache_dir / "sb_001.jpg").write_bytes(b"jpg")

    vtt = client.get(f"{base}/storyboard.vtt")
    assert vtt.status_code == 200
    assert vtt.headers["content-type"].startswith("text/vtt")
    assert vtt.headers["cache-control"] == storyboards.STORYBOARD_CACHE_CONTROL

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
    derived_cache.write_fingerprint(cache_dir / "index.vtt", asset_file.quick_fingerprint)
    (cache_dir / "sb_001.jpg").write_bytes(b"jpg")

    body = client.get(
        f"/api/v1/libraries/{library_id}/bundles/{asset_file.bundle_id}/playback"
    ).json()
    video = body["videos"][0]
    version = asset_file.quick_fingerprint.replace(":", "%3A")
    assert video["storyboard_url"] == (
        f"/api/v1/libraries/{library_id}/files/{asset_file.id}/storyboard.vtt?v={version}"
    )
    assert video["chapters"] == [{"start": 0.0, "end": 90.0, "title": "Intro"}]


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
