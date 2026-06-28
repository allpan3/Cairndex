"""Thumbnail generation + cache + cover fallback.

Thumbnails are derived media: generated with ffmpeg (read-only on the source)
and cached inside the library's own portable ``.cairndex/cache/thumbnails/``
directory (ADR-0008 phase 8), never beside the originals (AGENTS.md §4.4/§6).
Keeping the cache inside the library means it travels with the folder; cache
paths are deterministic from the file id, so generation is reproducible and
de-duplicated (an existing thumbnail is reused).
"""

import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, resolve_within_root
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package
from cairndex.services.bundles import get_bundle, list_files

THUMBNAIL_WIDTH = 480
_THUMBNAILABLE = (MediaKind.VIDEO, MediaKind.IMAGE)

ProgressFn = Callable[[int, int | None], None]


class ThumbnailError(RuntimeError):
    """ffmpeg was unavailable or failed to produce a thumbnail."""


def thumbnail_cache_path(library_root: Path, file_id: str) -> Path:
    """Deterministic cache location for a file's thumbnail (sharded by prefix).

    Lives under the library's portable ``.cairndex/cache/thumbnails/`` so it
    travels with the library folder (ADR-0008 phase 8).
    """
    return library_package.cache_dir(library_root) / "thumbnails" / file_id[:2] / f"{file_id}.jpg"


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise ThumbnailError("ffmpeg not found on PATH")
    return exe


def _run(args: list[str]) -> None:
    try:
        proc = subprocess.run(args, capture_output=True, timeout=60, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ThumbnailError("ffmpeg timed out") from exc
    if proc.returncode != 0:
        raise ThumbnailError(proc.stderr.decode(errors="replace")[:200])


def _generate(source: Path, dest: Path, kind: MediaKind) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    scale = f"scale={THUMBNAIL_WIDTH}:-2"
    # The "thumbnail" filter picks a representative video frame without needing
    # the duration (no -ss seek, so very short clips still work).
    vf = f"thumbnail,{scale}" if kind is MediaKind.VIDEO else scale
    _run([_ffmpeg(), "-y", "-i", str(source), "-vf", vf, "-frames:v", "1", str(dest)])
    if not dest.exists() or dest.stat().st_size == 0:
        raise ThumbnailError(f"ffmpeg produced no thumbnail for {source}")


def generate_for_file(session: Session, file_id: str, *, force: bool = False) -> Path:
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.media_kind not in _THUMBNAILABLE:
        raise ValidationError(f"{asset_file.media_kind} files are not thumbnailable")

    library_root = library_root_for_session(session)
    dest = thumbnail_cache_path(library_root, file_id)
    if dest.exists() and not force:
        return dest  # cache hit — reused, not regenerated

    source = resolve_within_root(library_root, asset_file.relative_path)
    _generate(Path(source), dest, asset_file.media_kind)
    return dest


def effective_cover_file(session: Session, bundle_id: str) -> AssetFile | None:
    """Resolve the file a bundle's cover should be derived from (AGENTS.md §4.4).

    Precedence: selected cover → selected primary → first image → first video.
    """
    bundle = get_bundle(session, bundle_id)
    if bundle.cover_file_id is not None:
        cover = session.get(AssetFile, bundle.cover_file_id)
        if cover is not None:
            return cover
    if bundle.primary_file_id is not None:
        primary = session.get(AssetFile, bundle.primary_file_id)
        if primary is not None and primary.media_kind in _THUMBNAILABLE:
            return primary
    files = list_files(session, bundle_id)
    for kind in (MediaKind.IMAGE, MediaKind.VIDEO):
        match = next((f for f in files if f.media_kind is kind), None)
        if match is not None:
            return match
    return None


def generate_for_bundle(session: Session, bundle_id: str, *, force: bool = False) -> Path | None:
    """Generate (or reuse) the bundle's cover thumbnail, or None if it has no
    thumbnailable file."""
    source_file = effective_cover_file(session, bundle_id)
    if source_file is None:
        return None
    return generate_for_file(session, source_file.id, force=force)


@dataclass(frozen=True)
class ThumbnailSummary:
    generated: int
    failed: int


def generate_for_library(
    session: Session,
    *,
    force: bool = False,
    on_progress: ProgressFn | None = None,
    batch_size: int = 20,
) -> ThumbnailSummary:
    """Generate thumbnails for every thumbnailable, available file in the library."""
    stmt = select(AssetFile).where(
        AssetFile.availability == FileAvailability.AVAILABLE,
        AssetFile.media_kind.in_(_THUMBNAILABLE),
    )
    files = list(session.scalars(stmt))
    total = len(files)
    generated = failed = 0

    for index, asset_file in enumerate(files, start=1):
        try:
            generate_for_file(session, asset_file.id, force=force)
            generated += 1
        except (ThumbnailError, PathSafetyError, OSError):
            failed += 1
        if on_progress is not None and index % batch_size == 0:
            on_progress(index, total)

    if on_progress is not None:
        on_progress(total, total)
    return ThumbnailSummary(generated, failed)
