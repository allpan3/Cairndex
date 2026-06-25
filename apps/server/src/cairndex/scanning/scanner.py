"""Storage-root scanner: incremental, idempotent, non-destructive discovery.

Walks a storage root and links discovered media files in place (default
grouping: one bundle per file — explicit multi-file bundling is a separate
action). Re-scanning updates existing rows in place (no duplicates), and files
that have disappeared are marked ``missing`` rather than deleted (AGENTS.md
§5.2/§5.3). Only a quick fingerprint (size + mtime) is computed — never a full
hash (§5.1, §11). Nothing on disk is ever modified.
"""

import os
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.paths import normalize_relative_path
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, StorageRootStatus
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.scanning.media_types import classify
from cairndex.services.storage_roots import get_storage_root

# Called after each committed batch with (processed, total). May raise to abort
# the scan (the job handler passes a checkpoint that raises on cancellation);
# work already committed is preserved.
ProgressFn = Callable[[int, int | None], None]


@dataclass(frozen=True)
class ScanSummary:
    root_id: str
    discovered: int
    created: int
    updated: int
    missing: int


def _iter_media_files(root_path: Path) -> Iterator[Path]:
    # followlinks=False avoids symlink cycles and escapes out of the root.
    for dirpath, _dirnames, filenames in os.walk(root_path, followlinks=False):
        for name in filenames:
            if classify(name) is not None:
                yield Path(dirpath) / name


def _count_media_files(root_path: Path) -> int:
    return sum(1 for _ in _iter_media_files(root_path))


def scan_storage_root(
    session: Session,
    root_id: str,
    *,
    on_progress: ProgressFn | None = None,
    batch_size: int = 200,
) -> ScanSummary:
    root = get_storage_root(session, root_id)
    root_path = Path(root.canonical_path)

    existing: dict[str, AssetFile] = {
        f.relative_path: f
        for f in session.scalars(select(AssetFile).where(AssetFile.storage_root_id == root_id))
    }

    # Unreachable root: mark it unavailable and all its files missing.
    if not root_path.is_dir():
        root.status = StorageRootStatus.UNAVAILABLE
        missing = _mark_missing(existing.values(), keep=frozenset())
        root.last_scanned_at = utcnow()
        session.commit()
        return ScanSummary(root_id, 0, 0, 0, missing)

    root.status = StorageRootStatus.AVAILABLE
    total = _count_media_files(root_path)
    seen: set[str] = set()
    processed = created = updated = 0

    for path in _iter_media_files(root_path):
        classification = classify(path.name)
        assert classification is not None  # _iter filters to classifiable files
        kind, role = classification
        try:
            stat = path.stat()
        except OSError:
            continue  # vanished between walk and stat; missing pass handles it

        rel = normalize_relative_path(path.relative_to(root_path).as_posix())
        seen.add(rel)
        fingerprint = quick_fingerprint(stat.st_size, stat.st_mtime_ns)
        mtime = datetime.fromtimestamp(stat.st_mtime, UTC)

        current = existing.get(rel)
        if current is None:
            bundle = AssetBundle(title=path.stem)
            session.add(bundle)
            session.flush()
            session.add(
                AssetFile(
                    bundle_id=bundle.id,
                    storage_root_id=root_id,
                    relative_path=rel,
                    original_filename=path.name,
                    display_title=path.name,
                    role=role,
                    media_kind=kind,
                    size_bytes=stat.st_size,
                    mtime=mtime,
                    quick_fingerprint=fingerprint,
                    availability=FileAvailability.AVAILABLE,
                )
            )
            created += 1
        else:
            current.size_bytes = stat.st_size
            current.mtime = mtime
            current.quick_fingerprint = fingerprint
            current.availability = FileAvailability.AVAILABLE
            updated += 1

        processed += 1
        if processed % batch_size == 0:
            session.commit()
            if on_progress is not None:
                on_progress(processed, total)

    missing = _mark_missing(existing.values(), keep=seen)
    root.last_scanned_at = utcnow()
    session.commit()
    if on_progress is not None:
        on_progress(processed, total)

    return ScanSummary(root_id, processed, created, updated, missing)


def _mark_missing(files: Iterable[AssetFile], keep: frozenset[str] | set[str]) -> int:
    """Mark files whose path was not seen this scan as missing (not deleted)."""
    count = 0
    for f in files:
        if f.relative_path not in keep and f.availability != FileAvailability.MISSING:
            f.availability = FileAvailability.MISSING
            count += 1
    return count
