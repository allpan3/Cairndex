"""ffprobe adapter + media-metadata extraction.

The probe tests generate tiny real media with ffmpeg and are skipped where
ffmpeg/ffprobe are not installed; the normalization test always runs.
"""

import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import execute_job
from cairndex.media.ffprobe import ffprobe_available, normalize_metadata
from cairndex.media.probe_service import probe_library
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetFile
from cairndex.registry import jobs as job_service
from cairndex.registry import library_package as pkg
from cairndex.scanning.scanner import scan_library

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(
    _FFMPEG is None or not ffprobe_available(),
    reason="ffmpeg/ffprobe not installed",
)


def _make_video(path: Path, *, w: int = 320, h: int = 240) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=duration=1:size={w}x{h}:rate=10",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _make_image(path: Path, *, w: int = 64, h: int = 48) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=red:size={w}x{h}",
            "-frames:v",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_normalize_metadata_reduces_ffprobe_json() -> None:
    raw = {
        "format": {"format_name": "mov,mp4,m4a", "duration": "12.5", "bit_rate": "800000"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "24000/1001",
                "index": 0,
            },
            {"codec_type": "audio", "codec_name": "aac", "index": 1},
            {
                "codec_type": "subtitle",
                "codec_name": "subrip",
                "index": 2,
                "tags": {"language": "eng"},
            },
        ],
    }
    meta = normalize_metadata(raw)
    assert meta["width"] == 1920 and meta["height"] == 1080
    assert meta["video_codec"] == "h264" and meta["audio_codec"] == "aac"
    assert meta["duration"] == 12.5 and meta["bitrate"] == 800000
    assert meta["fps"] == 23.976
    assert meta["embedded_subtitles"] == [{"index": 2, "codec": "subrip", "language": "eng"}]


@requires_ffmpeg
def test_probe_library_extracts_dimensions(session: Session, library_root: Path) -> None:
    _make_video(library_root / "clip.mp4")
    _make_image(library_root / "poster.png")
    (library_root / "subs.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nhi")
    scan_library(session, library_root)

    summary = probe_library(session)
    assert summary.probed == 2  # video + image; subtitle not probe-eligible
    assert summary.failed == 0

    video = session.scalar(select(AssetFile).where(AssetFile.relative_path == "clip.mp4"))
    assert video is not None and video.tech_metadata is not None
    assert video.tech_metadata["width"] == 320
    assert video.tech_metadata["height"] == 240
    assert video.tech_metadata["video_codec"] == "h264"
    assert video.tech_metadata["duration"] and video.tech_metadata["duration"] > 0

    image = session.scalar(select(AssetFile).where(AssetFile.relative_path == "poster.png"))
    assert image is not None and image.tech_metadata is not None
    assert image.tech_metadata["width"] == 64 and image.tech_metadata["height"] == 48


@requires_ffmpeg
def test_probe_job_populates_metadata(
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    _make_video(library_root / "movie.mp4")
    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        maker = sessionmaker(bind=eng, expire_on_commit=False, future=True)
        with maker() as session:
            scan_library(session, library_root)
            session.commit()
            file_id = session.scalar(select(AssetFile.id))
    finally:
        eng.dispose()

    with registry_session_factory() as reg:
        job = job_service.create_job(reg, library_id=library_id, job_type=JobType.PROBE)
        reg.commit()
        job_id = job.id

    assert execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED

    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        maker = sessionmaker(bind=eng, expire_on_commit=False, future=True)
        with maker() as session:
            probed = session.get(AssetFile, file_id)
            assert probed is not None and probed.tech_metadata is not None
            assert probed.tech_metadata["width"] == 320
    finally:
        eng.dispose()
