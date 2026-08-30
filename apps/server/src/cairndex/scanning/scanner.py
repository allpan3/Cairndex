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

import contextlib
import os
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.ids import new_id
from cairndex.core.paths import normalize_relative_path
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.domain.file_names import display_title_after_move
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning import staging_cleanup
from cairndex.scanning.fingerprint import quick_fingerprint, sqlite_filesystem_identity
from cairndex.scanning.media_types import classify, is_hidden_relative_path
from cairndex.services import directory_members

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
    missing_total: int
    repaired: int = 0
    # Staging rows dropped because this scan proved their files are gone (see
    # ``staging_cleanup``). Counted separately from ``missing``: a file staged,
    # deleted, and forgotten in one pass is honestly both.
    forgotten: int = 0
    # New files that joined an existing bundle because they landed in one of its
    # folder members (plan 6), rather than being staged for review. Part of
    # ``created``, and broken out because it is the one kind of new file a scan
    # files without asking — worth being able to see in a log.
    joined_folders: int = 0


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


# How many directories to list at once. A library on a network share answers each
# listing in a round trip, and those round trips are latency, not work — so
# overlapping them is nearly free and collapses the walk. Listing the owner's
# library cold took 4.2 s in sequence and 1.3 s across sixteen threads (measured
# 2026-08-14). ``os.scandir`` and ``os.stat`` both release the GIL, so threads are
# the right tool despite the name.
_LISTING_THREADS = 16


def _list_directory(directory: Path) -> tuple[list[Path], list[os.DirEntry[str]], bool]:
    """One directory's visible subdirectories and its classifiable media entries.

    Returns ``DirEntry`` objects rather than paths so their ``stat`` can be reused:
    a fresh ``Path.stat()`` re-resolves every path component, which over SMB costs
    a round trip per file. Same walk, 2.5 s of ``Path.stat()`` against 76 ms of
    ``DirEntry.stat()`` on the owner's library (measured 2026-08-14).

    The third element is False when the directory could not be listed at all.
    That failure used to be swallowed here, which left an unreadable directory
    indistinguishable from an empty one downstream — and telling those apart is
    the whole basis on which ``staging_cleanup`` may drop a row (owner,
    2026-08-24).
    """
    subdirectories: list[Path] = []
    entries: list[os.DirEntry[str]] = []
    try:
        listing = list(os.scandir(directory))
    except OSError:
        return subdirectories, entries, False  # vanished or unreadable
    for entry in listing:
        if is_hidden_relative_path(entry.name):
            continue
        try:
            # follow_symlinks=False avoids symlink cycles and escapes out of the root.
            if entry.is_dir(follow_symlinks=False):
                subdirectories.append(Path(entry.path))
            elif classify(entry.name) is not None:
                # Read the stat here, in the worker, though nothing here needs it.
                # ``DirEntry`` caches it, so ``_observe`` gets it for free on the
                # main thread later. ``is_dir(follow_symlinks=False)`` above fills a
                # *different* slot — the lstat — so without this every file was
                # still stat'ed one at a time: 2.3 s of the owner's 3.6 s walk.
                with contextlib.suppress(OSError):
                    entry.stat()
                entries.append(entry)
        except OSError:
            continue
    return subdirectories, entries, True


@dataclass
class WalkStatus:
    """Whether one walk read every directory it tried.

    A directory that could not be listed means the tree the walk saw is not the
    whole tree, so "not seen" stops meaning "not there" — the distinction a
    dropped mount turns on. Mutated as the walk proceeds; read it once the
    iterator is exhausted.
    """

    complete: bool = True


def _iter_media_entries(
    root_path: Path, status: WalkStatus | None = None
) -> Iterator[os.DirEntry[str]]:
    """Walk the library once, listing directories a level at a time in parallel.

    Breadth-first rather than depth-first purely so each level is a batch wide
    enough to be worth handing to the pool. ``status``, when given, records
    whether every directory could be read. Per-entry failures are not counted: a
    file vanishing mid-walk is what the missing pass is for, while a directory
    that will not list is the signal that matters here.
    """
    pending = [root_path]
    with ThreadPoolExecutor(max_workers=_LISTING_THREADS) as pool:
        while pending:
            level = list(pool.map(_list_directory, pending))
            pending = []
            for subdirectories, entries, listed in level:
                if not listed and status is not None:
                    status.complete = False
                pending.extend(subdirectories)
                yield from entries


def iter_media_files(root_path: Path) -> Iterator[Path]:
    """Every classifiable media file under ``root_path``, in one concurrent walk.

    Public because linking a dropped-in folder needs the same traversal without
    the scan's bookkeeping around it.
    """
    for entry in _iter_media_entries(root_path):
        yield Path(entry.path)


def _entry_stat(entry: os.DirEntry[str]) -> os.stat_result:
    """The one place the scan reads a file's metadata.

    A named seam, because ``os.DirEntry`` is a built-in that cannot be patched: a
    test that needs to say what a network filesystem reports — an unsigned 64-bit
    inode, or an inode that changes between scans — substitutes this instead.
    """
    return entry.stat()


def _observe(entry: os.DirEntry[str], root_path: Path) -> _Observed | None:
    classification = classify(entry.name)
    assert classification is not None  # the walk filters to classifiable files
    kind, role = classification
    try:
        stat = _entry_stat(entry)
    except OSError:
        return None  # vanished between walk and stat; missing pass handles it
    path = Path(entry.path)
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
        device=sqlite_filesystem_identity(stat.st_dev),
        inode=sqlite_filesystem_identity(stat.st_ino),
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
    # Re-read only if something was actually dropped. This used to read every file
    # row a second time unconditionally, and the common case drops nothing — a whole
    # extra pass over the table, which on a network-hosted library is a third of the
    # scan's remaining SQL cost for no new information.
    if _drop_ignored_scan_rows(session, existing_rows):
        existing_rows = list(session.scalars(select(AssetFile)))
    existing: dict[str, AssetFile] = {
        f.relative_path: f for f in existing_rows if not is_hidden_relative_path(f.relative_path)
    }

    # Unreachable root: mark all files missing (availability is tracked in the
    # registry, so there is no per-library status to flip here).
    if not root_path.is_dir():
        missing = _mark_missing(existing.values(), keep=frozenset())
        session.commit()
        return ScanSummary(
            discovered=0,
            created=0,
            updated=0,
            missing=missing,
            missing_total=_missing_total(session),
        )

    if on_phase is not None:
        on_phase("discovering")
    # An estimate, not a count. It used to be exact, from a second full walk of the
    # library done for no other purpose — which on a network share cost as much as
    # the scan itself. The rows already here are what an incremental scan is about
    # to find, so they are the honest guess, and finding more only ever raises it.
    # A first scan has nothing to guess from and says so: ``None`` means the bar is
    # indeterminate, which is truthful, where a total that equalled the count so far
    # would have sat at a permanent 100%.
    total = len(existing) or None
    # Read after the walk: whether every directory answered decides if this scan
    # may conclude anything from a file not being seen.
    walk = WalkStatus()
    seen: set[str] = set()
    new_obs: list[_Observed] = []  # bounded: one lightweight record per new path
    processed = updated = 0

    # Pass 1: update same-path rows in place; collect appeared paths for repair.
    for entry in _iter_media_entries(root_path, walk):
        obs = _observe(entry, root_path)
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
        # Two different cadences on purpose. The commit is a durability
        # boundary and stays batched, because committing per file is what makes
        # a large library slow. Progress is a display concern and reports every
        # file: the callback throttles its own writes by time, so the cost of a
        # call it decides to skip is a clock read. Reporting only at a commit
        # boundary meant any library smaller than one batch (200 files) showed
        # no movement whatsoever — the bar sat at zero and then the scan ended.
        if processed % batch_size == 0:
            session.commit()
        if on_progress is not None:
            on_progress(processed, max(total, processed) if total else None)

    # Pass 2: repair moves before creating anything new.
    if on_phase is not None:
        on_phase("reconciling")
    missing_rows = [row for rel, row in existing.items() if rel not in seen]
    repairs = _plan_repairs(new_obs, missing_rows)
    repaired_rel = {obs.rel for obs, _ in repairs}
    repaired_row_ids = {row.id for _, row in repairs}

    # Captured before the loop rewrites them: a folder member names a directory,
    # and only the moves themselves say where that directory went (plan 6 §4.4).
    moves = [(row.relative_path, obs.rel) for obs, row in repairs]

    for obs, row in repairs:
        # A rename Cairndex did not perform still has to carry the name a bundle
        # shows, or the file reads as its old self everywhere except the File
        # Browser (owner report, 2026-07-30). Same rule as a rename we did.
        row.display_title = display_title_after_move(
            display_title=row.display_title, old_path=row.relative_path, new_path=obs.rel
        )
        row.relative_path = obs.rel
        row.original_filename = obs.name
        _apply_identity(row, obs)
        row.updated_at = utcnow()
    session.flush()
    # A renamed folder's files repair themselves through the paths above; the row
    # naming the folder is the one thing left pointing at somewhere that is gone.
    directory_members.repair_after_moves(session, moves)

    # Pass 3: create bundles for genuinely new paths (not repaired moves).
    #
    # Ids are assigned here rather than left to a flush inside the loop, which is
    # all that flush was for — the file needs its bundle's id. `UlidPk` defaults to
    # a plain Python callable, so every primary key is known before the insert and
    # SQLAlchemy can batch them. Flushing per file made a scan of new files cost
    # two INSERT round trips each: on a library whose database sits on a network
    # share, where one statement costs ~36 ms, that is a minute per thousand files
    # (owner-reported, 2026-08-13). `persist_plan` had the same shape.
    created = 0
    joined_folders = 0
    pending: list[AssetBundle | AssetFile] = []
    # Folders the owner has collapsed into a single bundle row (plan 6). A file
    # that lands inside one joins that bundle instead of being staged as its own
    # provisional suggestion: the folder member *is* a durable user statement
    # that this directory belongs to that bundle, so honouring it is not
    # overriding a review (ADR-0009) but obeying one. It is also what keeps the
    # feature worth having — an album stays one row as photos are added to it,
    # rather than sprouting a provisional bundle per drop.
    folder_owners = directory_members.bundle_by_directory(session)
    for obs in new_obs:
        if obs.rel in repaired_rel:
            continue
        owner_bundle_id = directory_members.owning_bundle_for(obs.rel, folder_owners)
        if owner_bundle_id is not None:
            joined_folders += 1
        else:
            bundle = AssetBundle(
                id=new_id(),
                title=Path(obs.name).stem,
                grouping_state=GroupingState.PROVISIONAL,
                grouping_source=GroupingSource.SCAN_SUGGESTION,
                grouping_rule_version=SCAN_GROUPING_RULE_VERSION,
            )
            pending.append(bundle)
            owner_bundle_id = bundle.id
        new_file = AssetFile(
            id=new_id(),
            bundle_id=owner_bundle_id,
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
        pending.append(new_file)
        created += 1
    session.add_all(pending)

    # Disappeared rows that were not repaired into a new path are missing.
    still_missing = [row for row in missing_rows if row.id not in repaired_row_ids]
    missing = _mark_missing(still_missing, keep=frozenset())

    session.commit()
    if on_progress is not None:
        on_progress(processed, max(total, processed) if total else None)

    # After repair, so a file that moved was rescued rather than forgotten.
    forgotten = staging_cleanup.forget_vanished_staging(
        session, root_path, walk_complete=walk.complete
    )

    return ScanSummary(
        discovered=processed,
        created=created,
        updated=updated,
        missing=missing,
        missing_total=_missing_total(session),
        repaired=len(repairs),
        forgotten=forgotten,
        joined_folders=joined_folders,
    )


def _mark_missing(files: Iterable[AssetFile], keep: frozenset[str] | set[str]) -> int:
    """Mark files whose path was not seen this scan as missing (not deleted).

    Trashed files are skipped (ADR-0013 §3.2). Their bytes live under
    ``.cairndex/trash/``, which the scan ignores, so they are never "seen" — but
    they are not lost, they were deliberately put there, and flipping them to
    missing would empty the Trash view into Missing Files and make restore look
    like repair.
    """
    count = 0
    for f in files:
        if f.availability in (FileAvailability.MISSING, FileAvailability.TRASHED):
            continue
        if f.relative_path not in keep:
            f.availability = FileAvailability.MISSING
            count += 1
    return count


# Count every persisted linked file that remains missing after reconciliation
def _missing_total(session: Session) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(AssetFile)
            .where(AssetFile.availability == FileAvailability.MISSING)
        )
        or 0
    )
