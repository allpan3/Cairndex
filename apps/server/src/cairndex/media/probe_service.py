"""Populate AssetFile.tech_metadata via ffprobe.

Only video/image/audio files are probed; subtitles/attachments are skipped.
Paths are resolved through ``core.paths`` so probing can never read outside a
storage root. Probe failures (missing file, unreadable, ffprobe absent) are
counted and skipped, never fatal.
"""

from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError
from cairndex.core.paths import PathSafetyError, resolve_within_root
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.ffprobe import PROBE_VERSION, ProbeError, normalize_metadata, run_ffprobe
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.services.subtitles import sync_embedded_tracks

ProgressFn = Callable[[int, int | None], None]
_PROBEABLE = (MediaKind.VIDEO, MediaKind.IMAGE, MediaKind.AUDIO)


# Current-version metadata can be skipped during routine incremental probes
def _is_current_probe_metadata(metadata: dict[str, Any] | None) -> bool:
    return metadata is not None and metadata.get("probe_version") == PROBE_VERSION


@dataclass(frozen=True)
class ProbeSummary:
    probed: int
    skipped: int
    failed: int


# Bound for a probe run from a request handler rather than the job worker. The
# web player abandons a playback decision after 15 s (useHlsSession's
# DECISION_TIMEOUT_MS), and a decision that lands after that is worse than one
# made without the metadata — so give up in time to still answer.
ON_ACCESS_PROBE_TIMEOUT_S = 10.0


def ensure_probed(session: Session, asset_file: AssetFile) -> bool:
    """Top up one file's technical metadata if it is absent or from an old probe.

    Returns whether a probe actually ran.

    The playback decision reads container, codec, codec tag, colour depth and
    duration off this row. With none of them present it has to be optimistic and
    answers "play it directly", so a freshly scanned library handed every file
    straight to the browser and anything the browser could not decode failed
    with a format error — recoverable only by finding the Collect metadata menu
    item, which is not something playback should depend on (owner-reported,
    2026-08-15). The library-wide job still exists and is still what fills a
    library in bulk; this is the single file the caller is about to play.

    One ffprobe of one file's header, bounded by a timeout and written back so
    it happens once. It never raises: a file that cannot be probed keeps the
    optimistic path it had before, which is the existing behaviour rather than a
    new failure.
    """
    if _is_current_probe_metadata(asset_file.tech_metadata):
        return False
    try:
        abs_path = resolve_within_root(library_root_for_session(session), asset_file.relative_path)
        metadata = normalize_metadata(
            run_ffprobe(Path(abs_path), timeout=ON_ACCESS_PROBE_TIMEOUT_S)
        )
    except (ProbeError, PathSafetyError, OSError):
        return False
    asset_file.tech_metadata = metadata
    asset_file.updated_at = utcnow()
    session.flush()
    if asset_file.media_kind == MediaKind.VIDEO:
        sync_embedded_tracks(session, asset_file)
    return True


# Probes for paths with no row to write them to (File Browser playback in a
# library that was never scanned). Keyed by identity-on-disk rather than path
# alone, so a replaced file is re-probed rather than served stale metadata.
# Bounded and in-process: it exists to keep a quality switch or a re-attach from
# paying for the same ffprobe again, not to be a durable store.
_PATH_PROBE_CACHE_LIMIT = 256
_path_probe_cache: OrderedDict[tuple[str, int, int], dict[str, Any]] = OrderedDict()


def probe_path(abs_path: Path) -> dict[str, Any] | None:
    """Normalized metadata for a file identified only by its path, or ``None``.

    The unindexed half of :func:`ensure_probed`: a File Browser path need not be
    in the library database at all, and without probed metadata the playback
    decision cannot tell a directly playable source from one the browser will
    refuse. Callers must have resolved ``abs_path`` inside the library root
    already — this function does no path safety of its own.
    """
    try:
        stat = abs_path.stat()
        key = (str(abs_path), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None
    cached = _path_probe_cache.get(key)
    if cached is not None:
        _path_probe_cache.move_to_end(key)
        return cached
    try:
        metadata = normalize_metadata(run_ffprobe(abs_path, timeout=ON_ACCESS_PROBE_TIMEOUT_S))
    except (ProbeError, OSError):
        return None
    _path_probe_cache[key] = metadata
    while len(_path_probe_cache) > _PATH_PROBE_CACHE_LIMIT:
        _path_probe_cache.popitem(last=False)
    return metadata


def probe_asset_file(session: Session, file_id: str) -> AssetFile:
    """Probe a single file and store its normalized technical metadata."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    abs_path = resolve_within_root(library_root_for_session(session), asset_file.relative_path)
    asset_file.tech_metadata = normalize_metadata(run_ffprobe(abs_path))
    asset_file.updated_at = utcnow()
    session.flush()
    if asset_file.media_kind == MediaKind.VIDEO:
        sync_embedded_tracks(session, asset_file)
    return asset_file


def probe_library(
    session: Session,
    *,
    reprobe: bool = False,
    on_progress: ProgressFn | None = None,
    batch_size: int = 50,
) -> ProbeSummary:
    """Probe every eligible available file in the library."""
    root_path = library_root_for_session(session)
    stmt = select(AssetFile).where(
        AssetFile.availability == FileAvailability.AVAILABLE,
        AssetFile.media_kind.in_(_PROBEABLE),
    )
    files = list(session.scalars(stmt))
    total = len(files)
    probed = skipped = failed = 0

    for index, asset_file in enumerate(files, start=1):
        if not reprobe and _is_current_probe_metadata(asset_file.tech_metadata):
            skipped += 1
        else:
            try:
                abs_path = resolve_within_root(root_path, asset_file.relative_path)
                asset_file.tech_metadata = normalize_metadata(run_ffprobe(Path(abs_path)))
                asset_file.updated_at = utcnow()
                if asset_file.media_kind == MediaKind.VIDEO:
                    sync_embedded_tracks(session, asset_file)
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
    return ProbeSummary(probed, skipped, failed)
