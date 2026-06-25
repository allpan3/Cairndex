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
from cairndex.media.probe_service import probe_storage_root
from cairndex.persistence.models import AssetFile
from cairndex.scanning.scanner import scan_storage_root
from cairndex.services import jobs as job_service
from cairndex.services import storage_roots as root_service

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
def test_probe_storage_root_extracts_dimensions(session: Session, tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    _make_video(media / "clip.mp4")
    _make_image(media / "poster.png")
    (media / "subs.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nhi")

    root = root_service.create_storage_root(session, name="m", canonical_path=str(media))
    session.commit()
    scan_storage_root(session, root.id)

    summary = probe_storage_root(session, root.id)
    # Video + image probed; the subtitle is not probe-eligible.
    assert summary.probed == 2
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
def test_probe_job_populates_metadata_visible_via_api(
    session_factory: sessionmaker[Session], tmp_path: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    _make_video(media / "movie.mp4")

    with session_factory() as session:
        root = root_service.create_storage_root(session, name="m", canonical_path=str(media))
        session.commit()
        root_id = root.id
        scan_storage_root(session, root_id)
        job = job_service.create_job(
            session, type=JobType.PROBE, payload={"storage_root_id": root_id}
        )
        session.commit()
        job_id = job.id
        file_id = session.scalar(select(AssetFile.id))

    assert execute_job(session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED

    with session_factory() as session:
        probed = session.get(AssetFile, file_id)
        assert probed is not None and probed.tech_metadata is not None
        assert probed.tech_metadata["width"] == 320
