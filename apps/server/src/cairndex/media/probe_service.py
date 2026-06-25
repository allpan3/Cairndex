"""Populate AssetFile.tech_metadata via ffprobe.

Only video/image/audio files are probed; subtitles/attachments are skipped.
Paths are resolved through ``core.paths`` so probing can never read outside a
storage root. Probe failures (missing file, unreadable, ffprobe absent) are
counted and skipped, never fatal.
"""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.core.paths import PathSafetyError, resolve_within_root
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.ffprobe import ProbeError, normalize_metadata, run_ffprobe
from cairndex.persistence.models import AssetFile
from cairndex.services.storage_roots import get_storage_root

ProgressFn = Callable[[int, int | None], None]
_PROBEABLE = (MediaKind.VIDEO, MediaKind.IMAGE, MediaKind.AUDIO)


@dataclass(frozen=True)
class ProbeSummary:
    root_id: str
    probed: int
    skipped: int
    failed: int


def probe_asset_file(session: Session, file_id: str) -> AssetFile:
    """Probe a single file and store its normalized technical metadata."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    abs_path = resolve_within_root(asset_file.storage_root.canonical_path, asset_file.relative_path)
    asset_file.tech_metadata = normalize_metadata(run_ffprobe(abs_path))
    asset_file.updated_at = utcnow()
    session.flush()
    return asset_file


def probe_storage_root(
    session: Session,
    root_id: str,
    *,
    reprobe: bool = False,
    on_progress: ProgressFn | None = None,
    batch_size: int = 50,
) -> ProbeSummary:
    root = get_storage_root(session, root_id)
    stmt = select(AssetFile).where(
        AssetFile.storage_root_id == root_id,
        AssetFile.availability == FileAvailability.AVAILABLE,
        AssetFile.media_kind.in_(_PROBEABLE),
    )
    files = list(session.scalars(stmt))
    total = len(files)
    probed = skipped = failed = 0

    for index, asset_file in enumerate(files, start=1):
        if asset_file.tech_metadata is not None and not reprobe:
            skipped += 1
        else:
            try:
                abs_path = resolve_within_root(root.canonical_path, asset_file.relative_path)
                asset_file.tech_metadata = normalize_metadata(run_ffprobe(Path(abs_path)))
                asset_file.updated_at = utcnow()
                probed += 1
            except (ProbeError, PathSafetyError, OSError):
                failed += 1
        if index % batch_size == 0:
            session.commit()
            if on_progress is not None:
                on_progress(index, total)

    session.commit()
    if on_progress is not None:
        on_progress(total, total)
    return ProbeSummary(root_id, probed, skipped, failed)
