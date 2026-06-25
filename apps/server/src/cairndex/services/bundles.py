"""Asset-bundle domain service.

The bundle is the primary user-facing object. Everything here is metadata-only
and non-destructive (AGENTS.md §3): linking or unlinking files mutates rows,
never the files on disk. File locations are stored as
``storage_root_id + normalized relative_path`` and validated through
``core.paths`` so no client input can escape a storage root.
"""

from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import (
    PathSafetyError,
    normalize_relative_path,
    resolve_within_root,
)
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Folder,
    StorageRoot,
    Tag,
)
from cairndex.services.pagination import keyset_page

_RATING_MIN, _RATING_MAX = 0, 5
_BUNDLE_SCALAR_FIELDS = {"title", "note", "source_url"}


def get_bundle(session: Session, bundle_id: str) -> AssetBundle:
    bundle = session.get(AssetBundle, bundle_id)
    if bundle is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")
    return bundle


def create_bundle(
    session: Session,
    *,
    title: str | None = None,
    note: str | None = None,
    source_url: str | None = None,
    rating: int | None = None,
) -> AssetBundle:
    _validate_rating(rating)
    bundle = AssetBundle(title=title, note=note, source_url=source_url, rating=rating)
    session.add(bundle)
    session.flush()
    return bundle


def list_bundles(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[AssetBundle], str | None]:
    return keyset_page(session, select(AssetBundle), AssetBundle.id, limit, cursor)


def update_bundle(session: Session, bundle_id: str, changes: dict[str, Any]) -> AssetBundle:
    """Apply shared-metadata changes. ``changes`` contains only the fields the
    client explicitly provided (so passing ``None`` clears a field)."""
    bundle = get_bundle(session, bundle_id)

    for field in _BUNDLE_SCALAR_FIELDS:
        if field in changes:
            setattr(bundle, field, changes[field])

    if "rating" in changes:
        _validate_rating(changes["rating"])
        bundle.rating = changes["rating"]

    if "cover_file_id" in changes:
        bundle.cover_file_id = _validate_member_file(session, bundle, changes["cover_file_id"])
    if "primary_file_id" in changes:
        bundle.primary_file_id = _validate_member_file(session, bundle, changes["primary_file_id"])

    bundle.updated_at = utcnow()
    session.flush()
    return bundle


def delete_bundle(session: Session, bundle_id: str) -> None:
    """Delete a bundle and its file *rows* (metadata only). The physical files
    on disk are never touched (AGENTS.md §3)."""
    session.delete(get_bundle(session, bundle_id))
    session.flush()


# --- Files within a bundle ---------------------------------------------------
def list_files(session: Session, bundle_id: str) -> list[AssetFile]:
    get_bundle(session, bundle_id)
    stmt = (
        select(AssetFile)
        .where(AssetFile.bundle_id == bundle_id)
        .order_by(AssetFile.sequence, AssetFile.id)
    )
    return list(session.scalars(stmt))


def add_file(
    session: Session,
    bundle_id: str,
    *,
    storage_root_id: str,
    relative_path: str,
    role: FileRole,
    media_kind: MediaKind,
    display_title: str | None = None,
    sequence: int = 0,
    note: str | None = None,
    source_url: str | None = None,
    mime_type: str | None = None,
) -> AssetFile:
    """Link an existing on-disk file into the bundle without copying it."""
    get_bundle(session, bundle_id)
    root = session.get(StorageRoot, storage_root_id)
    if root is None:
        raise ValidationError(f"storage root {storage_root_id!r} does not exist")

    try:
        normalized = normalize_relative_path(relative_path)
        # If the root is currently mounted, additionally reject symlink escapes.
        if Path(root.canonical_path).exists():
            resolve_within_root(root.canonical_path, normalized)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc

    filename = normalized.rsplit("/", 1)[-1]
    asset_file = AssetFile(
        bundle_id=bundle_id,
        storage_root_id=storage_root_id,
        relative_path=normalized,
        original_filename=filename,
        display_title=display_title or filename,
        note=note,
        source_url=source_url,
        role=role,
        media_kind=media_kind,
        mime_type=mime_type,
        sequence=sequence,
    )
    session.add(asset_file)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"{normalized!r} is already linked under this storage root") from exc
    return asset_file


def remove_file(session: Session, bundle_id: str, file_id: str) -> None:
    """Unlink a file from its bundle (metadata only; the file stays on disk).

    If the file was the bundle's cover/primary, those references are cleared
    (DB SET NULL)."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise NotFoundError(f"file {file_id!r} is not part of bundle {bundle_id!r}")
    session.delete(asset_file)
    session.flush()


# --- Tag / folder assignment -------------------------------------------------
def set_bundle_tags(session: Session, bundle_id: str, tag_ids: list[str]) -> AssetBundle:
    bundle = get_bundle(session, bundle_id)
    bundle.tags = _resolve_all(session, Tag, tag_ids, label="tag")
    bundle.updated_at = utcnow()
    session.flush()
    return bundle


def set_bundle_folders(session: Session, bundle_id: str, folder_ids: list[str]) -> AssetBundle:
    bundle = get_bundle(session, bundle_id)
    bundle.folders = _resolve_all(session, Folder, folder_ids, label="folder")
    bundle.updated_at = utcnow()
    session.flush()
    return bundle


# --- helpers -----------------------------------------------------------------
def _validate_rating(rating: int | None) -> None:
    if rating is not None and not (_RATING_MIN <= rating <= _RATING_MAX):
        raise ValidationError(f"rating must be between {_RATING_MIN} and {_RATING_MAX}")


def _validate_member_file(session: Session, bundle: AssetBundle, file_id: str | None) -> str | None:
    if file_id is None:
        return None
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle.id:
        raise ValidationError("selected file is not part of this bundle")
    return file_id


def _resolve_all[M: (Tag, Folder)](
    session: Session, model: type[M], ids: list[str], *, label: str
) -> list[M]:
    unique_ids = list(dict.fromkeys(ids))
    if not unique_ids:
        return []
    found = list(session.scalars(select(model).where(model.id.in_(unique_ids))))
    if len(found) != len(unique_ids):
        missing = set(unique_ids) - {obj.id for obj in found}
        raise ValidationError(f"unknown {label} ids: {sorted(missing)}")
    # Preserve the caller's ordering.
    by_id = {obj.id: obj for obj in found}
    return [by_id[i] for i in unique_ids]
