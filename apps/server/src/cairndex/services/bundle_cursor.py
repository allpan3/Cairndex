"""Ordered openable-media selection and one persisted cursor per bundle."""

from collections import defaultdict
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.image_support import is_openable_media
from cairndex.persistence.models import AssetBundle, AssetFile, BundleCursor, PlaybackProgress


# True when a file type has a stage in the current web viewer
def is_supported(asset_file: AssetFile) -> bool:
    return asset_file.media_kind in (MediaKind.IMAGE, MediaKind.VIDEO) and is_openable_media(
        asset_file.media_kind, asset_file.relative_path
    )


# True when a supported file is currently linked at its recorded path
def is_openable(asset_file: AssetFile) -> bool:
    return asset_file.availability is FileAvailability.AVAILABLE and is_supported(asset_file)


# Choose the explicit cursor, latest legacy resume, or first ordered openable file
def select_current_file(
    files: list[AssetFile],
    cursor_file_id: str | None,
    progress_by_file: Mapping[str, PlaybackProgress],
) -> AssetFile | None:
    supported = [asset_file for asset_file in files if is_supported(asset_file)]
    openable = [asset_file for asset_file in supported if is_openable(asset_file)]
    explicit = next(
        (asset_file for asset_file in supported if asset_file.id == cursor_file_id), None
    )
    if explicit is not None:
        return explicit
    resumable = [
        asset_file
        for asset_file in openable
        if (progress := progress_by_file.get(asset_file.id)) is not None
        and not progress.completed
        and progress.position_s > 0
    ]
    if resumable:
        return max(
            resumable,
            key=lambda asset_file: (
                progress_by_file[asset_file.id].updated_at,
                asset_file.id,
            ),
        )
    if openable:
        return openable[0]
    return supported[0] if supported else None


# Resolve a bundle's current file using its persisted cursor and compatibility fallback
def current_file(session: Session, bundle_id: str) -> AssetFile | None:
    if session.get(AssetBundle, bundle_id) is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")
    rows = list(
        session.execute(
            select(AssetFile, PlaybackProgress)
            .outerjoin(PlaybackProgress, PlaybackProgress.file_id == AssetFile.id)
            .where(AssetFile.bundle_id == bundle_id)
            .order_by(AssetFile.sequence, AssetFile.id)
        )
    )
    files = [asset_file for asset_file, _progress in rows]
    progress_by_file = {
        asset_file.id: progress for asset_file, progress in rows if progress is not None
    }
    cursor = session.get(BundleCursor, bundle_id)
    return select_current_file(files, cursor.file_id if cursor else None, progress_by_file)


# Resolve a known page of bundles in two bounded queries
def current_files(session: Session, bundle_ids: list[str]) -> dict[str, AssetFile | None]:
    if not bundle_ids:
        return {}
    rows = list(
        session.execute(
            select(AssetFile, PlaybackProgress)
            .outerjoin(PlaybackProgress, PlaybackProgress.file_id == AssetFile.id)
            .where(AssetFile.bundle_id.in_(bundle_ids))
            .order_by(AssetFile.bundle_id, AssetFile.sequence, AssetFile.id)
        )
    )
    files_by_bundle: dict[str, list[AssetFile]] = defaultdict(list)
    progress_by_bundle: dict[str, dict[str, PlaybackProgress]] = defaultdict(dict)
    for asset_file, progress in rows:
        files_by_bundle[asset_file.bundle_id].append(asset_file)
        if progress is not None:
            progress_by_bundle[asset_file.bundle_id][asset_file.id] = progress
    cursor_by_bundle = {
        cursor.bundle_id: cursor.file_id
        for cursor in session.scalars(
            select(BundleCursor).where(BundleCursor.bundle_id.in_(bundle_ids))
        )
    }
    return {
        bundle_id: select_current_file(
            files_by_bundle[bundle_id],
            cursor_by_bundle.get(bundle_id),
            progress_by_bundle[bundle_id],
        )
        for bundle_id in bundle_ids
    }


# Persist the current openable file without changing bundle metadata/version
def set_cursor(session: Session, bundle_id: str, file_id: str) -> BundleCursor:
    if session.get(AssetBundle, bundle_id) is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise ValidationError("cursor file must belong to the bundle")
    if not is_openable(asset_file):
        raise ValidationError("cursor file must be available and openable")
    cursor = session.get(BundleCursor, bundle_id)
    if cursor is None:
        cursor = BundleCursor(bundle_id=bundle_id, file_id=file_id, updated_at=utcnow())
        session.add(cursor)
    elif cursor.file_id != file_id:
        cursor.file_id = file_id
        cursor.updated_at = utcnow()
    session.flush()
    return cursor
