"""Thumbnails: generation, cache location, dedup, cover fallback, serving."""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import thumbnails
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package as pkg
from cairndex.scanning.scanner import scan_library
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service

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


# Create a small Pillow image for preview-only cover formats
def _make_pillow_image(path: Path, fmt: str) -> None:
    Image = pytest.importorskip("PIL.Image", reason="Pillow not installed")
    Image.new("RGB", (24, 24), (20, 60, 100)).save(path, format=fmt)


def test_cache_path_is_inside_library_package(library_root: Path) -> None:
    path = thumbnails.thumbnail_cache_path(library_root, "01ABCDEF01ABCDEF01ABCDEF01")
    # Lives under the library's portable .cairndex/cache/thumbnails (phase 8).
    assert path.is_relative_to(pkg.cache_dir(library_root) / "thumbnails")
    assert path.is_relative_to(pkg.marker_dir(library_root))


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
    # Cached inside the library's .cairndex/cache, never beside the source.
    assert thumb.is_relative_to(pkg.cache_dir(library_root))
    assert not thumb.is_relative_to(library_root / "clip.mp4")
    assert thumb.parent != (library_root / "clip.mp4").parent
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


# Video-only bundles use their first ordered video for cover thumbnails
def test_cover_fallback_uses_first_video_when_no_image(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="b")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    assert thumbnails.effective_cover_file(session, bundle.id).id == video.id


def test_preview_only_cover_uses_pillow_preview_not_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
    library_id: str,
    library_root: Path,
) -> None:
    _make_pillow_image(library_root / "cover.tiff", "TIFF")
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={"title": "b"}).json()["id"]
    file_id = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": "cover.tiff", "role": "cover", "media_kind": "image"},
    ).json()["id"]
    client.patch(f"{base}/bundles/{bundle_id}", json={"cover_file_id": file_id})

    def fail_ffmpeg(_source: Path, _dest: Path, _kind: MediaKind) -> None:
        raise AssertionError("preview-only image cover should not use ffmpeg")

    monkeypatch.setattr(thumbnails, "_generate", fail_ffmpeg)

    resp = client.get(f"{base}/bundles/{bundle_id}/thumbnail")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/webp"
    assert resp.content.startswith(b"RIFF") and b"WEBP" in resp.content[:16]


def test_psd_cover_falls_back_to_decodable_image(session: Session, library_root: Path) -> None:
    _make_pillow_image(library_root / "scan.tiff", "TIFF")
    (library_root / "layered.psd").write_bytes(b"psd")
    bundle = bundle_service.create_bundle(session, title="b")
    psd = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="layered.psd",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    tiff = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="scan.tiff",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": psd.id})
    session.commit()

    assert thumbnails.effective_cover_file(session, bundle.id).id == tiff.id


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


def test_cover_frame_endpoints_validate_persist_regenerate_and_clear(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
    library_id: str,
    library_root: Path,
    session: Session,
) -> None:
    (library_root / "movie.mp4").write_bytes(b"video")
    bundle = bundle_service.create_bundle(session, title="b")
    collection = collection_service.create_collection(session, name="only")
    bundle_service.set_bundle_collections(session, bundle.id, [collection.id])
    collection_updated_at = collection.updated_at
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
        relative_path="poster.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": image.id})
    video.tech_metadata = {"duration": 20.0}
    session.commit()
    seen: list[float | None] = []

    def fake_generate(
        _source: Path, dest: Path, _kind: MediaKind, cover_time: float | None
    ) -> None:
        seen.append(cover_time)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"jpg")

    monkeypatch.setattr(thumbnails, "_generate", fake_generate)
    base = f"/api/v1/libraries/{library_id}/files/{video.id}/cover-frame"

    assert client.post(base, json={"time": -1}).status_code == 422
    at_end = client.post(base, json={"time": 20})
    assert at_end.status_code == 200
    assert at_end.json()["cover_time"] == pytest.approx(19.9)
    just_past_end = client.post(base, json={"time": 20.05})
    assert just_past_end.status_code == 200
    assert just_past_end.json()["cover_time"] == pytest.approx(19.9)
    session.expire_all()
    assert session.get(AssetFile, video.id).cover_time == pytest.approx(19.9)
    # A frame is chosen for *this video*, and stops there. Which member
    # represents the bundle stays the owner's separate, explicit choice — the
    # image is still the cover (owner, 2026-07-30).
    assert bundle_service.get_bundle(session, bundle.id).cover_file_id == image.id
    # And because the bundle's picture did not change, nothing above it was
    # invalidated: bumping the collection's ``updated_at`` would re-fetch every
    # tile resolving through this bundle to show the same image.
    session.refresh(collection)
    assert collection.updated_at == collection_updated_at
    assert seen == [pytest.approx(19.9), pytest.approx(19.9)]

    # Future forced regeneration continues to honor the persisted timestamp
    thumbnails.generate_for_file(session, video.id, force=True)
    assert seen[-1] == pytest.approx(19.9)

    cleared = client.delete(base)
    assert cleared.status_code == 200
    assert cleared.json()["cover_time"] is None
    session.expire_all()
    assert bundle_service.get_bundle(session, bundle.id).cover_file_id == image.id
    assert seen[-1] is None


def test_cover_frame_on_the_bundle_cover_refreshes_the_tiles_above_it(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
    library_id: str,
    library_root: Path,
    session: Session,
) -> None:
    """The one case where a file's cover frame *is* the bundle's picture.

    Setting a frame does not reassign the cover, but when the file already is
    the cover the bundle's image really does change — so its cache key, and
    those of the collections whose cover resolves through it, must move.
    """
    (library_root / "movie.mp4").write_bytes(b"video")
    bundle = bundle_service.create_bundle(session, title="b")
    collection = collection_service.create_collection(session, name="only")
    bundle_service.set_bundle_collections(session, bundle.id, [collection.id])
    collection_updated_at = collection.updated_at
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": video.id})
    video.tech_metadata = {"duration": 20.0}
    session.commit()

    def fake_generate(
        _source: Path, dest: Path, _kind: MediaKind, _cover_time: float | None
    ) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"jpg")

    monkeypatch.setattr(thumbnails, "_generate", fake_generate)
    base = f"/api/v1/libraries/{library_id}/files/{video.id}/cover-frame"

    assert client.post(base, json={"time": 5}).status_code == 200
    session.expire_all()
    session.refresh(collection)
    assert collection.updated_at > collection_updated_at
    # Still the cover it already was; the frame changed, not the choice.
    assert bundle_service.get_bundle(session, bundle.id).cover_file_id == video.id


def test_cover_frame_endpoint_rejects_symlink_escape(
    client: TestClient, library_id: str, session: Session, library_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"video")
    target = library_root / "escape.mp4"
    target.write_bytes(b"original")
    bundle = bundle_service.create_bundle(session, title="b")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="escape.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    video.tech_metadata = {"duration": 20.0}
    session.commit()
    target.unlink()
    target.symlink_to(outside)

    response = client.post(
        f"/api/v1/libraries/{library_id}/files/{video.id}/cover-frame", json={"time": 1}
    )
    assert response.status_code == 422
