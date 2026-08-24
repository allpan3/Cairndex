"""Drop staging rows for unregistered files that are gone from disk.

Unbundled is the pending zone. A scan stages every file it finds as a provisional
one-file bundle, and nothing in there is registered in the library yet — bundling
is what registers a file (owner, 2026-08-24). A pending file that no longer
exists is not pending anything, so its row is bookkeeping about nothing, and
leaving it behind put it in Missing Files: a repair surface, reporting a loss the
owner caused deliberately and cannot act on.

What is never swept:

* a **registered** (confirmed) bundle's files — a missing member there is real
  news about a grouping the owner made, and ``services.bundles`` offers repair
  or an explicit forget;
* anything the owner **authored**, even on a staging row: a tag, a rating, a
  note, a source, a collection, a watch position, a chosen cover frame, a cover
  or subtitle reference. Each of those is a decision, and a decision outlives the
  bytes it was about.

Deletion needs positive proof the file is *gone* rather than *unreachable*,
because guessing wrong costs a re-probe and a re-thumbnail of everything that
comes back. Two things must hold:

* **the walk read every directory it tried.** A listing that failed is a mount
  that dropped, not a folder that emptied.
* **the file's recorded filesystem is the one still mounted** at its nearest
  surviving ancestor. A dropped SMB mount takes its mountpoint directory with it,
  so a vanished folder alone proves nothing (owner, 2026-08-24) — but the
  ancestor that survives is then on the *outer* filesystem, whose device id is
  not the one the file was last seen on. A mountpoint left behind as an empty
  directory fails the same check, since an unmounted one reverts to its parent's
  device.

Both are read off the current scan; nothing here waits, counts scans, or keeps a
timestamp. Where the answer is unclear the row simply stays, and the manual
forget clears it.
"""

import os
from pathlib import Path

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, aliased

from cairndex.domain.enums import FileAvailability, GroupingSource, GroupingState
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    BundleCursor,
    PlaybackProgress,
    SubtitleTrack,
    asset_bundle_collections,
    asset_bundle_tags,
)
from cairndex.scanning.fingerprint import sqlite_filesystem_identity


def forget_vanished_staging(session: Session, root_path: Path, *, walk_complete: bool) -> int:
    """Drop rows for staged files this scan proved are gone. Returns the count.

    Metadata-only, like every other unlink in the library: there is nothing on
    disk left to touch. Called at the end of a scan, after moved-file repair, so
    a file that merely moved has already been rescued with its id intact.
    """
    if not walk_complete:
        return 0
    candidates = _vanished_staging_rows(session)
    if not candidates:
        return 0
    devices: dict[Path, int | None] = {}
    forgotten = 0
    for row in candidates:
        if not _on_the_recorded_filesystem(root_path, row, devices):
            continue
        bundle_id = row.bundle_id
        session.delete(row)
        # Its whole bundle: the query only matches one-file staging bundles, so
        # nothing else is left in it to keep.
        bundle = session.get(AssetBundle, bundle_id)
        if bundle is not None:
            session.delete(bundle)
        forgotten += 1
    if forgotten:
        session.commit()
    return forgotten


def _vanished_staging_rows(session: Session) -> list[AssetFile]:
    """Missing files in one-file staging bundles that carry nothing owner-made.

    One statement rather than a row-by-row walk: a folder deleted wholesale can
    put thousands of rows in here at once.
    """
    # Aliased, and correlated explicitly to the bundle: the outer query already
    # selects from AssetFile, so an uncorrelated `select_from(AssetFile)` here
    # auto-correlates both tables away and compiles to nothing.
    member = aliased(AssetFile)
    file_count = (
        select(func.count())
        .select_from(member)
        .where(member.bundle_id == AssetBundle.id)
        .correlate(AssetBundle)
        .scalar_subquery()
    )
    stmt = (
        select(AssetFile)
        .join(AssetBundle, AssetBundle.id == AssetFile.bundle_id)
        .where(
            AssetFile.availability == FileAvailability.MISSING,
            # Nothing owner-authored on the file itself.
            AssetFile.note.is_(None),
            AssetFile.source.is_(None),
            AssetFile.cover_time.is_(None),
            # A device to compare against; without one there is no proof to have.
            AssetFile.filesystem_device.is_not(None),
            AssetFile.filesystem_device != 0,
            # Unregistered: still exactly as the scan staged it.
            AssetBundle.grouping_state == GroupingState.PROVISIONAL,
            AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION,
            AssetBundle.rating.is_(None),
            AssetBundle.notes.is_(None),
            AssetBundle.cover_file_id.is_(None),
            AssetBundle.primary_file_id.is_(None),
            file_count == 1,
            ~exists().where(asset_bundle_tags.c.bundle_id == AssetBundle.id),
            ~exists().where(asset_bundle_collections.c.bundle_id == AssetBundle.id),
            ~exists().where(PlaybackProgress.file_id == AssetFile.id),
            ~exists().where(BundleCursor.bundle_id == AssetBundle.id),
            ~exists().where(SubtitleTrack.video_file_id == AssetFile.id),
            ~exists().where(SubtitleTrack.source_file_id == AssetFile.id),
        )
        .order_by(AssetFile.relative_path)
    )
    return list(session.scalars(stmt))


def _on_the_recorded_filesystem(
    root_path: Path, row: AssetFile, devices: dict[Path, int | None]
) -> bool:
    """True when the file's own filesystem is the one still mounted where it was.

    Climbs to the nearest ancestor that exists, because the file's directory may
    have been deleted along with it — legitimately, or because it *was* a mount.
    Only the device id can tell those apart.
    """
    directory = (root_path / row.relative_path).parent
    while True:
        device = _device_of(directory, devices)
        if device is not None:
            return device == row.filesystem_device
        if directory == root_path or directory.parent == directory:
            return False  # not even the root answers; nothing here is provable
        directory = directory.parent


def _device_of(directory: Path, cache: dict[Path, int | None]) -> int | None:
    """The device id of a directory that exists, else None. Cached per scan: a
    deleted folder's files all climb to the same surviving ancestor."""
    if directory in cache:
        return cache[directory]
    try:
        device: int | None = sqlite_filesystem_identity(os.stat(directory).st_dev)
    except (OSError, ValueError):
        device = None
    cache[directory] = device
    return device
