"""Thumbnails: generation, cache location, dedup, cover fallback, serving."""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.config import get_settings
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import thumbnails
from cairndex.persistence.models import AssetFile
from cairndex.scanning.scanner import scan_library
from cairndex.services import bundles as bundle_service

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


def _make_video(path: Path) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=320x240:rate=10",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _make_image(path: Path) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:size=200x200",
            "-frames:v",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_cache_path_is_under_data_dir_not_source() -> None:
    path = thumbnails.thumbnail_cache_path("01ABCDEF01ABCDEF01ABCDEF01")
    assert path.is_relative_to(get_settings().cache_dir)


@requires_ffmpeg
def test_generates_thumbnail_outside_source_and_leaves_original(
    session: Session, library_root: Path
) -> None:
    _make_video(library_root / "clip.mp4")
    original_bytes = (library_root / "clip.mp4").read_bytes()
    scan_library(session, library_root)
    file_id = session.scalar(select(AssetFile.id))
    assert file_id is not None

    thumb = thumbnails.generate_for_file(session, file_id)
    assert thumb.exists() and thumb.stat().st_size > 0
    assert thumb.suffix == ".jpg"
    assert thumb.is_relative_to(get_settings().cache_dir)
    assert not thumb.is_relative_to(library_root)
    assert (library_root / "clip.mp4").read_bytes() == original_bytes


@requires_ffmpeg
def test_thumbnail_is_deduplicated(session: Session, library_root: Path) -> None:
    _make_image(library_root / "poster.png")
    scan_library(session, library_root)
    file_id = session.scalar(select(AssetFile.id))
    assert file_id is not None

    first = thumbnails.generate_for_file(session, file_id)
    mtime = first.stat().st_mtime_ns
    second = thumbnails.generate_for_file(session, file_id)  # cache hit
    assert second == first
    assert second.stat().st_mtime_ns == mtime  # not regenerated


@requires_ffmpeg
def test_cover_fallback_prefers_selected_then_image_then_video(
    session: Session, library_root: Path
) -> None:
    _make_video(library_root / "movie.mp4")
    _make_image(library_root / "art.png")

    bundle = bundle_service.create_bundle(session, title="b")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    image = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="art.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    assert thumbnails.effective_cover_file(session, bundle.id).id == image.id
    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": video.id})
    session.commit()
    assert thumbnails.effective_cover_file(session, bundle.id).id == video.id


@requires_ffmpeg
def test_serve_bundle_thumbnail_endpoint(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _make_image(library_root / "poster.png")
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={"title": "b"}).json()["id"]
    client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": "poster.png", "role": "cover", "media_kind": "image"},
    )

    resp = client.get(f"{base}/bundles/{bundle_id}/thumbnail")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert len(resp.content) > 0


def test_serve_thumbnail_404_when_no_thumbnailable_file(
    client: TestClient, library_id: str
) -> None:
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={"title": "empty"}).json()["id"]
    resp = client.get(f"{base}/bundles/{bundle_id}/thumbnail")
    assert resp.status_code == 404


def test_non_thumbnailable_file_rejected(session: Session, library_root: Path) -> None:
    (library_root / "subs.srt").write_text("x")
    bundle = bundle_service.create_bundle(session, title="b")
    sub = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="subs.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    session.commit()
    from cairndex.core.errors import ValidationError

    with pytest.raises(ValidationError):
        thumbnails.generate_for_file(session, sub.id)
