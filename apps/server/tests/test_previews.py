"""Image previews: lazy WebP cache, endpoint headers, and openability hints."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.media import previews
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package as pkg
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.services import bundles as bundle_service


# Return Pillow's Image module or skip when the optional decoder stack is absent
def _image_module():
    return pytest.importorskip("PIL.Image", reason="Pillow not installed")


# Create a small Pillow-backed image fixture
def _make_image(path: Path, fmt: str) -> None:
    Image = _image_module()
    image = Image.new("RGBA", (32, 24), (30, 120, 200, 180))
    if fmt == "HEIF":
        pillow_heif = pytest.importorskip("pillow_heif", reason="pillow-heif not installed")
        pillow_heif.register_heif_opener()
    try:
        image.save(path, format=fmt)
    except Exception as exc:
        if fmt == "HEIF":
            pytest.skip(f"HEIF encoder unavailable: {exc}")
        raise


# Add a linked image file with a current quick fingerprint
def _image_file(
    session: Session,
    library_root: Path,
    *,
    name: str = "photo.png",
    fmt: str = "PNG",
) -> AssetFile:
    target = library_root / name
    _make_image(target, fmt)
    stat = target.stat()
    bundle = bundle_service.create_bundle(session, title=name)
    asset_file = bundle_service.add_file(
        session,
        bundle.id,
        relative_path=name,
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    asset_file.quick_fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    session.commit()
    return asset_file


def test_preview_size_ladder_rejects_off_ladder(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    resp = client.get(f"{base}/files/does-not-matter/preview?size=999")
    assert resp.status_code == 422


def test_preview_cache_path_is_deterministic(library_root: Path) -> None:
    path = previews.preview_cache_path(library_root, "01ABCDEF01ABCDEF01ABCDEF01", 1600)
    assert path == (
        pkg.cache_dir(library_root) / "previews" / "01" / "01ABCDEF01ABCDEF01ABCDEF01_1600.webp"
    )


def test_lazy_generate_reuses_cache_and_invalidates_fingerprint(
    monkeypatch: pytest.MonkeyPatch, session: Session, library_root: Path
) -> None:
    asset_file = _image_file(session, library_root)
    calls = {"count": 0}
    real_generate = previews._generate

    def counting_generate(source: Path, dest: Path, size: previews.PreviewSize) -> None:
        calls["count"] += 1
        real_generate(source, dest, size)

    monkeypatch.setattr(previews, "_generate", counting_generate)

    first = previews.preview_for_file(session, asset_file.id, 640)
    second = previews.preview_for_file(session, asset_file.id, 640)
    asset_file.quick_fingerprint = "changed"
    session.commit()
    third = previews.preview_for_file(session, asset_file.id, 640)

    assert first == second == third
    assert first.exists() and first.stat().st_size > 0
    assert calls["count"] == 2
    assert previews.is_current_preview(library_root, asset_file.id, 640, "changed")


def test_preview_endpoint_serves_versioned_immutable_webp(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    asset_file = _image_file(session, library_root)
    version = previews.version_param(asset_file.quick_fingerprint)
    base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}"

    resp = client.get(f"{base}/preview?size=1600&v={version}")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/webp"
    assert resp.headers["cache-control"] == previews.PREVIEW_CACHE_CONTROL
    assert resp.content.startswith(b"RIFF") and b"WEBP" in resp.content[:16]


def test_preview_missing_source_marks_file_missing(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle = bundle_service.create_bundle(session, title="missing")
    asset_file = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="missing.tiff",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    resp = client.get(f"/api/v1/libraries/{library_id}/files/{asset_file.id}/preview?size=640")
    session.refresh(asset_file)

    assert resp.status_code == 404
    assert asset_file.availability is FileAvailability.MISSING


@pytest.mark.parametrize(("name", "fmt"), [("tiny.tiff", "TIFF"), ("tiny.heic", "HEIF")])
def test_tiff_and_heic_decode_to_webp(
    client: TestClient,
    library_id: str,
    session: Session,
    library_root: Path,
    name: str,
    fmt: str,
) -> None:
    asset_file = _image_file(session, library_root, name=name, fmt=fmt)
    resp = client.get(f"/api/v1/libraries/{library_id}/files/{asset_file.id}/preview?size=640")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/webp"
    assert resp.content.startswith(b"RIFF") and b"WEBP" in resp.content[:16]


def test_non_image_preview_is_rejected(session: Session, library_root: Path) -> None:
    (library_root / "movie.mp4").write_bytes(b"not an image")
    bundle = bundle_service.create_bundle(session, title="movie")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    with pytest.raises(ValidationError):
        previews.preview_for_file(session, video.id, 640)


def test_file_read_openability_hint_includes_heic_and_tiff(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    heic = _image_file(session, library_root, name="still.heic", fmt="HEIF")
    tiff = _image_file(session, library_root, name="scan.tiff", fmt="TIFF")
    body = client.get(f"/api/v1/libraries/{library_id}/bundles/{heic.bundle_id}/files").json()
    second = client.get(f"/api/v1/libraries/{library_id}/bundles/{tiff.bundle_id}/files").json()

    assert body[0]["supported"] is True
    assert body[0]["quick_fingerprint"] == heic.quick_fingerprint
    assert second[0]["supported"] is True
