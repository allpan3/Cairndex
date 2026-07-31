"""ffprobe adapter + media-metadata extraction.

The probe tests generate tiny real media with ffmpeg and are skipped where
ffmpeg/ffprobe are not installed; the normalization test always runs.
"""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.domain.enums import JobStatus, JobType
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import execute_job
from cairndex.media.ffprobe import PROBE_VERSION, ffprobe_available, normalize_metadata
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


# Build a tiny Matroska sample with multi-audio, embedded subtitles, and chapters
def _make_multitrack_video(path: Path) -> None:
    assert _FFMPEG is not None
    subs = path.with_suffix(".srt")
    chapters = path.with_suffix(".ffmetadata")
    subs.write_text("1\n00:00:00,000 --> 00:00:00,800\nhello\n", encoding="utf-8")
    chapters.write_text(
        ";FFMETADATA1\n"
        "\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Intro\n"
        "\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=Outro\n",
        encoding="utf-8",
    )
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=160x120:rate=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=1",
            "-i",
            str(subs),
            "-f",
            "ffmetadata",
            "-i",
            str(chapters),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-map",
            "3:s:0",
            "-map_chapters",
            "4",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            "title=Main",
            "-metadata:s:a:1",
            "language=jpn",
            "-metadata:s:a:1",
            "title=Commentary",
            "-metadata:s:s:0",
            "language=eng",
            "-metadata:s:s:0",
            "title=Captions",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-c:s",
            "srt",
            "-t",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_normalize_metadata_records_the_video_codec_tag() -> None:
    # `hvc1` and `hev1` are both HEVC, but only the former plays on Apple
    # engines, so the codec name alone cannot drive the playback decision.
    def tag_of(video: dict) -> str | None:
        meta = normalize_metadata({"format": {}, "streams": [video]})
        return meta["video_codec_tag"]

    assert tag_of({"codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hev1"}) == (
        "hev1"
    )
    assert tag_of({"codec_type": "video", "codec_name": "hevc", "codec_tag_string": "HVC1"}) == (
        "hvc1"
    )
    # Containers with no codec tag (MKV, WebM) report a placeholder, not a label.
    assert (
        tag_of({"codec_type": "video", "codec_name": "h264", "codec_tag_string": "[0][0][0][0]"})
        is None
    )
    assert tag_of({"codec_type": "video", "codec_name": "h264"}) is None
    assert normalize_metadata({"format": {}, "streams": []})["video_codec_tag"] is None


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
                "bit_rate": "650000",
                "bits_per_raw_sample": "10",
                "color_transfer": "smpte2084",
                "index": 0,
            },
            {
                "codec_type": "audio",
                "codec_name": "aac",
                "channels": 6,
                "bit_rate": "150000",
                "sample_rate": "48000",
                "index": 1,
                "disposition": {"default": 1},
                "tags": {"language": "eng", "title": "Surround"},
            },
            {
                "codec_type": "subtitle",
                "codec_name": "subrip",
                "index": 2,
                "disposition": {"default": 1, "forced": 0},
                "tags": {"language": "eng", "title": "English"},
            },
        ],
        "chapters": [
            {"start_time": "0.000000", "end_time": "12.500000", "tags": {"title": "Intro"}}
        ],
    }
    meta = normalize_metadata(raw)
    assert meta["probe_version"] == PROBE_VERSION
    assert meta["width"] == 1920 and meta["height"] == 1080
    assert meta["video_codec"] == "h264" and meta["audio_codec"] == "aac"
    assert meta["duration"] == 12.5 and meta["bitrate"] == 800000
    assert meta["video_bitrate"] == 650000 and meta["audio_bitrate"] == 150000
    assert meta["audio_sample_rate"] == 48000
    assert meta["fps"] == 23.976
    assert meta["embedded_subtitles"] == [{"index": 2, "codec": "subrip", "language": "eng"}]
    assert meta["audio_streams"] == [
        {
            "index": 1,
            "codec": "aac",
            "channels": 6,
            "language": "eng",
            "title": "Surround",
            "default": True,
        }
    ]
    assert meta["subtitle_streams"] == [
        {
            "index": 2,
            "codec": "subrip",
            "language": "eng",
            "title": "English",
            "default": True,
            "forced": False,
        }
    ]
    assert meta["chapters"] == [{"start": 0.0, "end": 12.5, "title": "Intro"}]
    assert meta["hdr"] == "hdr10"
    assert meta["bit_depth"] == 10


# Verify HDR classification against canned ffprobe stream JSON
@pytest.mark.parametrize(
    ("video", "expected"),
    [
        ({"codec_type": "video", "codec_tag_string": "dvh1", "pix_fmt": "yuv420p"}, "dv"),
        (
            {
                "codec_type": "video",
                "side_data_list": [{"side_data_type": "DOVI configuration record"}],
            },
            "dv",
        ),
        ({"codec_type": "video", "color_transfer": "smpte2084"}, "hdr10"),
        ({"codec_type": "video", "color_transfer": "arib-std-b67"}, "hlg"),
        ({"codec_type": "video", "color_transfer": "bt709"}, None),
    ],
)
def test_normalize_metadata_classifies_hdr(video: dict, expected: str | None) -> None:
    meta = normalize_metadata({"format": {}, "streams": [video]})
    assert meta["hdr"] == expected


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


# Probe a real tiny file with the M1 player metadata shape
@requires_ffmpeg
def test_probe_library_extracts_enriched_media_metadata(
    session: Session, library_root: Path
) -> None:
    _make_multitrack_video(library_root / "feature.mkv")
    scan_library(session, library_root)

    summary = probe_library(session)
    assert summary.probed == 1
    assert summary.failed == 0

    video = session.scalar(select(AssetFile).where(AssetFile.relative_path == "feature.mkv"))
    assert video is not None and video.tech_metadata is not None
    meta = video.tech_metadata
    assert [stream["language"] for stream in meta["audio_streams"]] == ["eng", "jpn"]
    assert [stream["title"] for stream in meta["audio_streams"]] == ["Main", "Commentary"]
    assert meta["audio_streams"][0]["default"] is True
    assert meta["audio_streams"][1]["default"] is False
    assert meta["subtitle_streams"] == [
        {
            "index": meta["embedded_subtitles"][0]["index"],
            "codec": "subrip",
            "language": "eng",
            "title": "Captions",
            "default": False,
            "forced": False,
        }
    ]
    assert meta["chapters"] == [
        {"start": 0.0, "end": 0.5, "title": "Intro"},
        {"start": 0.5, "end": 1.0, "title": "Outro"},
    ]
    assert meta["hdr"] is None
    assert meta["bit_depth"] == 8


# Skip routine probes only for current-version metadata
@requires_ffmpeg
def test_probe_library_uses_probe_version_for_incremental_skip(
    session: Session, library_root: Path
) -> None:
    _make_video(library_root / "legacy.mp4", w=160, h=90)
    _make_video(library_root / "old.mp4", w=180, h=100)
    _make_video(library_root / "current.mp4", w=200, h=110)
    scan_library(session, library_root)
    rows = {
        row.relative_path: row
        for row in session.scalars(
            select(AssetFile).where(
                AssetFile.relative_path.in_(("legacy.mp4", "old.mp4", "current.mp4"))
            )
        )
    }
    rows["legacy.mp4"].tech_metadata = {"width": 1, "height": 1, "video_codec": "h264"}
    rows["old.mp4"].tech_metadata = {
        "probe_version": PROBE_VERSION - 1,
        "width": 2,
        "height": 2,
        "video_codec": "h264",
    }
    rows["current.mp4"].tech_metadata = {
        "probe_version": PROBE_VERSION,
        "width": 3,
        "height": 3,
        "video_codec": "h264",
    }
    session.commit()

    summary = probe_library(session)
    assert summary.probed == 2
    assert summary.skipped == 1
    assert summary.failed == 0

    refreshed = {
        row.relative_path: row.tech_metadata
        for row in session.scalars(
            select(AssetFile).where(
                AssetFile.relative_path.in_(("legacy.mp4", "old.mp4", "current.mp4"))
            )
        )
    }
    assert refreshed["legacy.mp4"]["probe_version"] == PROBE_VERSION
    assert refreshed["legacy.mp4"]["width"] == 160
    assert refreshed["old.mp4"]["probe_version"] == PROBE_VERSION
    assert refreshed["old.mp4"]["width"] == 180
    assert refreshed["current.mp4"]["width"] == 3


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


# Exercise the existing Collect metadata job as a version-aware refresh path
@requires_ffmpeg
def test_collect_metadata_job_refreshes_legacy_rows_once(
    client: TestClient,
    registry_session_factory: sessionmaker[Session],
    library_id: str,
    library_root: Path,
) -> None:
    _make_multitrack_video(library_root / "old.mkv")
    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        maker = sessionmaker(bind=eng, expire_on_commit=False, future=True)
        with maker() as session:
            scan_library(session, library_root)
            old = session.scalar(select(AssetFile).where(AssetFile.relative_path == "old.mkv"))
            assert old is not None
            old.tech_metadata = {"width": 1, "height": 1, "duration": 1.0, "video_codec": "h264"}
            session.commit()
            file_id = old.id
    finally:
        eng.dispose()

    response = client.post(f"/api/v1/libraries/{library_id}/jobs/probe")
    assert response.status_code == 202
    assert response.json()["payload"] == {}
    job_id = response.json()["id"]
    assert execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED

    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        maker = sessionmaker(bind=eng, expire_on_commit=False, future=True)
        with maker() as session:
            probed = session.get(AssetFile, file_id)
            assert probed is not None and probed.tech_metadata is not None
            assert probed.tech_metadata["width"] == 160
            assert probed.tech_metadata["probe_version"] == PROBE_VERSION
            assert len(probed.tech_metadata["audio_streams"]) == 2
            assert probed.tech_metadata["chapters"][0]["title"] == "Intro"
    finally:
        eng.dispose()

    response = client.post(f"/api/v1/libraries/{library_id}/jobs/probe")
    assert response.status_code == 202
    job_id = response.json()["id"]
    assert execute_job(registry_session_factory, job_id, build_registry()) == JobStatus.SUCCEEDED

    with registry_session_factory() as reg:
        result = job_service.get_job(reg, job_id).result
    assert result == {"probed": 0, "skipped": 1, "failed": 0}
