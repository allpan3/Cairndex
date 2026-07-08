"""Lazy image preview derivatives cached in the library package."""

from __future__ import annotations

import fcntl
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import quote

from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import MediaKind
from cairndex.media import image_support
from cairndex.media.playback import resolve_file_path
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package

PREVIEW_CACHE_CONTROL = "public, max-age=31536000, immutable"
PREVIEW_SIZES = (640, 1600, 2560)
PreviewSize = Literal[640, 1600, 2560]


# Preview generation failures that callers can treat as unsupported media
class PreviewError(ValidationError):
    """Pillow was unavailable or failed to produce an image preview."""


# Return a URL-safe version token from the quick fingerprint
def version_param(quick_fingerprint: str | None) -> str:
    return quote(quick_fingerprint or "no-fingerprint", safe="")


# Return the deterministic preview cache location for one size
def preview_cache_path(library_root: Path, file_id: str, size: int) -> Path:
    return (
        library_package.cache_dir(library_root)
        / "previews"
        / file_id[:2]
        / f"{file_id}_{size}.webp"
    )


# Return the sibling sidecar that records the source quick fingerprint
def _fingerprint_path(preview_path: Path) -> Path:
    return preview_path.with_suffix(".fingerprint")


# Return the filesystem lock used to serialize generation for one derivative
def _lock_path(preview_path: Path) -> Path:
    return preview_path.with_suffix(".lock")


# Hold an exclusive OS file lock while a preview is generated
@contextmanager
def _locked(lock_path: Path) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# Read the generation fingerprint without opening the WebP
def _cached_fingerprint(preview_path: Path) -> str | None:
    try:
        return _fingerprint_path(preview_path).read_text(encoding="utf-8").strip()
    except OSError:
        return None


# True when the cached preview matches the current source quick fingerprint
def is_current_preview(
    library_root: Path, file_id: str, size: int, quick_fingerprint: str | None
) -> bool:
    path = preview_cache_path(library_root, file_id, size)
    return path.exists() and _cached_fingerprint(path) == (quick_fingerprint or "")


# Import and configure Pillow only when a preview actually needs generation
def _image_module() -> tuple[Any, Any, type[Exception]]:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
        from pillow_heif import register_heif_opener  # type: ignore[import-untyped]
    except ImportError as exc:
        raise PreviewError("Pillow and pillow-heif are required for image previews") from exc
    register_heif_opener()
    return Image, ImageOps, UnidentifiedImageError


# Write a WebP derivative without mutating or moving the source image
def _generate(source: Path, dest: Path, size: PreviewSize) -> None:
    Image, ImageOps, UnidentifiedImageError = _image_module()
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f"{dest.stem}.tmp-", suffix=".webp", dir=dest.parent)
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        try:
            with Image.open(source) as image:
                frame = ImageOps.exif_transpose(image)
                frame.thumbnail((size, size), Image.Resampling.LANCZOS)
                if frame.mode not in ("RGB", "RGBA"):
                    frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
                frame.save(tmp_path, format="WEBP", method=6, quality=88)
        except (UnidentifiedImageError, OSError) as exc:
            raise PreviewError(f"could not decode image {source.name}") from exc
        if not tmp_path.exists() or tmp_path.stat().st_size == 0:
            raise PreviewError(f"Pillow produced no preview for {source.name}")
        tmp_path.replace(dest)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


# Resolve and validate the AssetFile as a preview-capable image
def _preview_source(session: Session, file_id: str) -> tuple[Path, AssetFile]:
    source, asset_file = resolve_file_path(session, file_id)
    if asset_file.media_kind is not MediaKind.IMAGE:
        raise ValidationError("only image files have previews")
    if not image_support.is_preview_capable_image(asset_file.relative_path):
        raise ValidationError("this image format is not preview-capable")
    return source, asset_file


# Generate or reuse a WebP preview for a linked image file
def preview_for_file(session: Session, file_id: str, size: int) -> Path:
    if size not in PREVIEW_SIZES:
        raise ValidationError("unsupported preview size")
    preview_size = cast(PreviewSize, size)
    source, asset_file = _preview_source(session, file_id)
    library_root = library_root_for_session(session)
    dest = preview_cache_path(library_root, file_id, preview_size)
    if is_current_preview(library_root, file_id, preview_size, asset_file.quick_fingerprint):
        return dest
    with _locked(_lock_path(dest)):
        source, asset_file = _preview_source(session, file_id)  # re-check after waiting
        if is_current_preview(library_root, file_id, preview_size, asset_file.quick_fingerprint):
            return dest
        _generate(source, dest, preview_size)
        _fingerprint_path(dest).write_text(asset_file.quick_fingerprint or "", encoding="utf-8")
        return dest


# Build the canonical versioned preview URL for clients
def preview_url_for_file(library_id: str, asset_file: AssetFile, size: int) -> str | None:
    if asset_file.media_kind is not MediaKind.IMAGE:
        return None
    if not image_support.is_preview_capable_image(asset_file.relative_path):
        return None
    version = version_param(asset_file.quick_fingerprint)
    return f"/api/v1/libraries/{library_id}/files/{asset_file.id}/preview?size={size}&v={version}"
