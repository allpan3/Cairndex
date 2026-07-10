"""Lazy image preview derivatives cached in the library package."""

from __future__ import annotations

import hashlib
import os
import tempfile
import warnings
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any, Literal, cast

from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.domain.enums import MediaKind
from cairndex.media import derived_cache, image_support
from cairndex.media.playback import resolve_file_path
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package
from cairndex.scanning.fingerprint import quick_fingerprint

PREVIEW_CACHE_CONTROL = derived_cache.IMMUTABLE_CACHE_CONTROL
PREVIEW_SIZES = (640, 1600, 2560)
PreviewSize = Literal[640, 1600, 2560]
PREVIEW_MAX_DIMENSION = 24_000
_DECODE_SEMAPHORE = BoundedSemaphore(2)


# Preview generation failures that callers can treat as unsupported media
class PreviewError(ValidationError):
    """Pillow was unavailable or failed to produce an image preview."""


version_param = derived_cache.version_param


# Return the deterministic preview cache location for one size
def preview_cache_path(library_root: Path, file_id: str, size: int) -> Path:
    return (
        library_package.cache_dir(library_root)
        / "previews"
        / file_id[:2]
        / f"{file_id}_{size}.webp"
    )


# Return a deterministic cache location for an unlinked File View image
def file_view_preview_cache_path(library_root: Path, relative_path: str, size: int) -> Path:
    digest = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()
    key = f"path_{digest[:32]}"
    return library_package.cache_dir(library_root) / "previews" / key[:2] / f"{key}_{size}.webp"


# True when the cached preview matches the current source quick fingerprint
def is_current_preview(
    library_root: Path, file_id: str, size: int, quick_fingerprint: str | None
) -> bool:
    path = preview_cache_path(library_root, file_id, size)
    return derived_cache.is_current(path, quick_fingerprint)


# Import and configure Pillow only when a preview actually needs generation
def _image_module() -> tuple[Any, Any, type[Exception], type[Exception], type[Warning]]:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
        from pillow_heif import register_heif_opener  # type: ignore[import-untyped]
    except ImportError as exc:
        raise PreviewError("Pillow and pillow-heif are required for image previews") from exc
    register_heif_opener()
    return (
        Image,
        ImageOps,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    )


# Write a WebP derivative without mutating or moving the source image
def _generate(source: Path, dest: Path, size: PreviewSize) -> None:
    Image, ImageOps, UnidentifiedImageError, DecompressionBombError, DecompressionBombWarning = (
        _image_module()
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f"{dest.stem}.tmp-", suffix=".webp", dir=dest.parent)
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        with _DECODE_SEMAPHORE:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", DecompressionBombWarning)
                    with Image.open(source) as image:
                        width, height = image.size
                        if width > PREVIEW_MAX_DIMENSION or height > PREVIEW_MAX_DIMENSION:
                            raise PreviewError("image dimensions exceed preview limits")
                        if image.format == "JPEG":
                            image.draft("RGB", (size, size))
                        frame = ImageOps.exif_transpose(image)
                        frame.thumbnail((size, size), Image.Resampling.LANCZOS)
                        if frame.mode not in ("RGB", "RGBA"):
                            frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
                        frame.save(tmp_path, format="WEBP", method=6, quality=88)
            except DecompressionBombError as exc:
                raise PreviewError("image dimensions exceed preview limits") from exc
            except (DecompressionBombWarning, UnidentifiedImageError, OSError) as exc:
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


# Validate the public preview size ladder
def _preview_size(size: int) -> PreviewSize:
    if size not in PREVIEW_SIZES:
        raise ValidationError("unsupported preview size")
    return cast(PreviewSize, size)


# Generate or reuse one WebP derivative with atomic replacement
def _preview_for_source(
    source: Path, dest: Path, size: PreviewSize, quick_fingerprint_value: str | None
) -> Path:
    if derived_cache.is_current(dest, quick_fingerprint_value):
        return dest
    with derived_cache.locked(dest):
        if derived_cache.is_current(dest, quick_fingerprint_value):
            return dest
        _generate(source, dest, size)
        derived_cache.write_fingerprint(dest, quick_fingerprint_value)
        return dest


# Generate or reuse a WebP preview for a linked image file
def preview_for_file(session: Session, file_id: str, size: int) -> Path:
    preview_size = _preview_size(size)
    source, asset_file = _preview_source(session, file_id)
    library_root = library_root_for_session(session)
    dest = preview_cache_path(library_root, file_id, preview_size)
    return _preview_for_source(source, dest, preview_size, asset_file.quick_fingerprint)


# Generate or reuse a path-scoped WebP preview for an unlinked File View image
def preview_for_path(session: Session, relative_path: str, size: int) -> Path:
    preview_size = _preview_size(size)
    library_root = library_root_for_session(session)
    try:
        rel_norm = normalize_relative_path(relative_path)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc
    if not image_support.is_preview_capable_image(rel_norm):
        raise ValidationError("this image format is not preview-capable")
    try:
        source = resolve_within_root(library_root, rel_norm)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc
    if not source.exists():
        raise NotFoundError(f"path {rel_norm!r} does not exist in this library")
    if not source.is_file():
        raise ValidationError(f"path {rel_norm!r} is not a file")
    stat = source.stat()
    fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
    dest = file_view_preview_cache_path(library_root, rel_norm, preview_size)
    return _preview_for_source(Path(source), dest, preview_size, fingerprint)
