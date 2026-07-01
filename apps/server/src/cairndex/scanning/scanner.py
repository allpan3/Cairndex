"""Library scanner: incremental, idempotent, non-destructive discovery.

Walks a library root and links discovered media files in place (default
grouping: one bundle per file — explicit multi-file bundling is a separate
action). Re-scanning updates existing rows in place (no duplicates), and files
that have disappeared are marked ``missing`` rather than deleted (AGENTS.md
§5.2/§5.3).

Moved-file repair (AGENTS.md §5.3): before creating new bundles for paths that
appeared this scan, each is matched against rows that *disappeared* this scan.
On exactly one high-confidence match the existing ``AssetFile`` is updated in
place — its id, bundle, collections, tags, rating, note, cover/primary, and
subtitle links all survive — instead of spawning a fresh bundle. Ambiguous or
contested matches are left alone (no auto-repair, no auto-merge).

Only a quick fingerprint (size + mtime) and the cheap filesystem identity
(st_dev/st_ino) are read — never a full hash on the scan path (§5.1, §11).
Nothing on disk is ever modified.
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
from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.scanning.media_types import classify, is_hidden_relative_path

# Version of the scan-time provisional-bundling rule recorded on bundles staged
# by scan. This remains intentionally simple: one provisional bundle per new file.
# The richer ADR-0009 grouping suggester has its own rule version and persists a
# separate reviewable plan after scan completes.
SCAN_GROUPING_RULE_VERSION = 1

# Called after each committed batch with (processed, total). May raise to abort
# the scan (the job handler passes a checkpoint that raises on cancellation);
# work already committed is preserved.
ProgressFn = Callable[[int, int | None], None]

# Called when the scan enters a new coarse phase (the value is a
# ``domain.enums.JobPhase``). Optional so the scanner stays usable outside a job.
PhaseFn = Callable[[str], None]


@dataclass(frozen=True)
class ScanSummary:
    discovered: int
    created: int
    updated: int
    missing: int
    repaired: int = 0


@dataclass(frozen=True)
class _Observed:
    """A cheap, bounded record of one file seen this scan (no file contents)."""

    rel: str
    name: str
    size: int
    mtime: datetime
    fingerprint: str
    device: int
    inode: int
    identity_available: bool
    kind: MediaKind
    role: FileRole


def _iter_media_files(root_path: Path) -> Iterator[Path]:
    # followlinks=False avoids symlink cycles and escapes out of the root.
    for dirpath, dirnames, filenames in os.walk(root_path, followlinks=False):
        dirnames[:] = [name for name in dirnames if not is_hidden_relative_path(name)]
        for name in filenames:
            rel = (Path(dirpath) / name).relative_to(root_path).as_posix()
            if not is_hidden_relative_path(rel) and classify(name) is not None:
                yield Path(dirpath) / name


def _count_media_files(root_path: Path) -> int:
    return sum(1 for _ in _iter_media_files(root_path))


def _observe(path: Path, root_path: Path) -> _Observed | None:
    classification = classify(path.name)
    assert classification is not None  # _iter filters to classifiable files
    kind, role = classification
    try:
        stat = path.stat()
    except OSError:
        return None  # vanished between walk and stat; missing pass handles it
    rel = normalize_relative_path(path.relative_to(root_path).as_posix())
    # A zero device/inode is treated as untrustworthy identity (some network
    # filesystems do this), so it never drives a repair on its own.
    identity_available = stat.st_dev != 0 and stat.st_ino != 0
    return _Observed(
        rel=rel,
        name=path.name,
        size=stat.st_size,
        mtime=datetime.fromtimestamp(stat.st_mtime, UTC),
        fingerprint=quick_fingerprint(stat.st_size, stat.st_mtime_ns),
        device=stat.st_dev,
        inode=stat.st_ino,
        identity_available=identity_available,
        kind=kind,
        role=role,
    )


def _apply_identity(row: AssetFile, obs: _Observed) -> None:
    row.size_bytes = obs.size
    row.mtime = obs.mtime
    row.quick_fingerprint = obs.fingerprint
    row.filesystem_device = obs.device
    row.filesystem_inode = obs.inode
    row.identity_available = obs.identity_available
    row.availability = FileAvailability.AVAILABLE


def _is_high_confidence_match(obs: _Observed, row: AssetFile) -> bool:
    """True if ``obs`` is very likely the same physical file as a disappeared
    ``row``. Same filesystem identity is strongest (survives content edits);
    otherwise same quick fingerprint *and* same basename (AGENTS.md §5.3). Full
    hashing is never used on this path."""
    if (
        obs.identity_available
        and row.identity_available
        and row.filesystem_device == obs.device
        and row.filesystem_inode == obs.inode
    ):
        return True
    old_name = row.relative_path.rsplit("/", 1)[-1]
    return row.quick_fingerprint == obs.fingerprint and old_name == obs.name


def _plan_repairs(
    new_obs: list[_Observed], missing_rows: list[AssetFile]
) -> list[tuple[_Observed, AssetFile]]:
    """Match appeared paths to disappeared rows, 1:1 and unambiguous only.

    A repair is applied only when an appeared path has exactly one candidate
    row *and* that row is the candidate of exactly one appeared path. This
    rejects ambiguous moves and never merges a copy into an existing bundle (a
    copy's original is still present, so it is not a disappeared row)."""
    candidates: dict[str, list[AssetFile]] = {}
    claimers: dict[str, int] = {}
    for obs in new_obs:
        cands = [row for row in missing_rows if _is_high_confidence_match(obs, row)]
        candidates[obs.rel] = cands
        for row in cands:
            claimers[row.id] = claimers.get(row.id, 0) + 1

    repairs: list[tuple[_Observed, AssetFile]] = []
    for obs in new_obs:
        cands = candidates[obs.rel]
        if len(cands) == 1 and claimers[cands[0].id] == 1:
            repairs.append((obs, cands[0]))
    return repairs


# Remove hidden paths previously created by scan staging
def _drop_ignored_scan_rows(session: Session, files: Iterable[AssetFile]) -> int:
    """Delete scan-created provisional rows whose paths are now ignored."""
    ignored = [
        f
        for f in files
        if is_hidden_relative_path(f.relative_path)
        and f.bundle.grouping_state is GroupingState.PROVISIONAL
        and f.bundle.grouping_source is GroupingSource.SCAN_SUGGESTION
    ]
    deleted_bundle_ids: set[str] = set()
    deleted = 0
    for row in ignored:
        bundle = row.bundle
        if bundle.id in deleted_bundle_ids:
            continue
        if all(is_hidden_relative_path(f.relative_path) for f in bundle.files):
            session.delete(bundle)
            deleted_bundle_ids.add(bundle.id)
            deleted += len(bundle.files)
            continue
        if bundle.cover_file_id == row.id:
            bundle.cover_file_id = None
        if bundle.primary_file_id == row.id:
            bundle.primary_file_id = None
        session.delete(row)
        deleted += 1
    if deleted:
        session.flush()
    return deleted


def scan_library(
    session: Session,
    root_path: Path,
    *,
    on_progress: ProgressFn | None = None,
    on_phase: PhaseFn | None = None,
    batch_size: int = 200,
) -> ScanSummary:
    """Scan a library's root directory. ``root_path`` comes from the registry
    (ADR-0008); all ``AssetFile`` rows in ``session`` belong to this library."""
    existing_rows = list(session.scalars(select(AssetFile)))
    _drop_ignored_scan_rows(session, existing_rows)
    existing: dict[str, AssetFile] = {
        f.relative_path: f
        for f in session.scalars(select(AssetFile))
        if not is_hidden_relative_path(f.relative_path)
    }

    # Unreachable root: mark all files missing (availability is tracked in the
    # registry, so there is no per-library status to flip here).
    if not root_path.is_dir():
        missing = _mark_missing(existing.values(), keep=frozenset())
        session.commit()
        return ScanSummary(0, 0, 0, missing)

    if on_phase is not None:
        on_phase("discovering")
    total = _count_media_files(root_path)
    seen: set[str] = set()
    new_obs: list[_Observed] = []  # bounded: one lightweight record per new path
    processed = updated = 0

    # Pass 1: update same-path rows in place; collect appeared paths for repair.
    for path in _iter_media_files(root_path):
        obs = _observe(path, root_path)
        if obs is None:
            continue
        seen.add(obs.rel)
        current = existing.get(obs.rel)
        if current is None:
            new_obs.append(obs)
        else:
            _apply_identity(current, obs)  # same-path edit = update, not a move
            updated += 1

        processed += 1
        if processed % batch_size == 0:
            session.commit()
            if on_progress is not None:
                on_progress(processed, total)

    # Pass 2: repair moves before creating anything new.
    if on_phase is not None:
        on_phase("reconciling")
    missing_rows = [row for rel, row in existing.items() if rel not in seen]
    repairs = _plan_repairs(new_obs, missing_rows)
    repaired_rel = {obs.rel for obs, _ in repairs}
    repaired_row_ids = {row.id for _, row in repairs}

    for obs, row in repairs:
        row.relative_path = obs.rel
        row.original_filename = obs.name
        _apply_identity(row, obs)
        row.updated_at = utcnow()
    session.flush()

    # Pass 3: create bundles for genuinely new paths (not repaired moves).
    created = 0
    for obs in new_obs:
        if obs.rel in repaired_rel:
            continue
        bundle = AssetBundle(
            title=Path(obs.name).stem,
            grouping_state=GroupingState.PROVISIONAL,
            grouping_source=GroupingSource.SCAN_SUGGESTION,
            grouping_rule_version=SCAN_GROUPING_RULE_VERSION,
        )
        session.add(bundle)
        session.flush()
        new_file = AssetFile(
            bundle_id=bundle.id,
            relative_path=obs.rel,
            original_filename=obs.name,
            display_title=obs.name,
            role=obs.role,
            media_kind=obs.kind,
            size_bytes=obs.size,
            mtime=obs.mtime,
            quick_fingerprint=obs.fingerprint,
            filesystem_device=obs.device,
            filesystem_inode=obs.inode,
            identity_available=obs.identity_available,
            availability=FileAvailability.AVAILABLE,
        )
        session.add(new_file)
        created += 1

    # Disappeared rows that were not repaired into a new path are missing.
    still_missing = [row for row in missing_rows if row.id not in repaired_row_ids]
    missing = _mark_missing(still_missing, keep=frozenset())

    session.commit()
    if on_progress is not None:
        on_progress(processed, total)

    return ScanSummary(processed, created, updated, missing, len(repairs))


def _mark_missing(files: Iterable[AssetFile], keep: frozenset[str] | set[str]) -> int:
    """Mark files whose path was not seen this scan as missing (not deleted)."""
    count = 0
    for f in files:
        if f.relative_path not in keep and f.availability != FileAvailability.MISSING:
            f.availability = FileAvailability.MISSING
            count += 1
    return count
