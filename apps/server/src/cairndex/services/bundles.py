"""Asset-bundle domain service.

The bundle is the primary user-facing object. Everything here is metadata-only
and non-destructive (AGENTS.md §3): linking or unlinking files mutates rows,
never the files on disk. File locations are stored as a normalized
library-relative path (ADR-0008) and validated through ``core.paths`` so no
client input can escape the library root.
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
from cairndex.domain.enums import FileRole, GroupingSource, GroupingState, MediaKind
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    Tag,
)
from cairndex.services.pagination import keyset_page

_RATING_MIN, _RATING_MAX = 0, 5
_BUNDLE_SCALAR_FIELDS = {"title"}
# Guardrail against an abusive/accidental payload; the inspector never nears it.
_MAX_NOTES = 50


def get_bundle(session: Session, bundle_id: str) -> AssetBundle:
    bundle = session.get(AssetBundle, bundle_id)
    if bundle is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")
    return bundle


def bundle_notes(bundle: AssetBundle) -> list[str]:
    """The bundle's ordered notes (empty list when unset / a pre-``notes`` row)."""
    return list(bundle.notes) if bundle.notes is not None else []


def _normalize_notes(raw: Any) -> list[str]:
    """Validate/clean a client-supplied notes list.

    Drops blank/whitespace-only blocks (an untouched draft box in the inspector
    must not persist) while preserving order and non-blank content verbatim."""
    if not isinstance(raw, list) or not all(isinstance(n, str) for n in raw):
        raise ValidationError("notes must be a list of strings")
    cleaned = [n for n in raw if n.strip()]
    if len(cleaned) > _MAX_NOTES:
        raise ValidationError(f"a bundle can have at most {_MAX_NOTES} notes")
    return cleaned


def create_bundle(
    session: Session,
    *,
    title: str | None = None,
    notes: list[str] | None = None,
    rating: int | None = None,
) -> AssetBundle:
    _validate_rating(rating)
    # A manually created bundle is a direct user grouping decision, so it is
    # confirmed on creation (ADR-0009); model defaults give it confirmed/manual.
    bundle = AssetBundle(title=title, rating=rating, confirmed_at=utcnow())
    if notes is not None:
        bundle.notes = _normalize_notes(notes)
    session.add(bundle)
    session.flush()
    return bundle


def list_bundles(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[AssetBundle], str | None]:
    return keyset_page(session, select(AssetBundle), AssetBundle.id, limit, cursor)


def update_bundle(
    session: Session,
    bundle_id: str,
    changes: dict[str, Any],
    *,
    expected_version: int | None = None,
) -> AssetBundle:
    """Apply shared-metadata changes. ``changes`` contains only the fields the
    client explicitly provided (so passing ``None`` clears a field).

    When ``expected_version`` is given it must match the stored version or a
    ``VersionConflictError`` (409) is raised before anything is mutated (ADR-0008
    phase 9). The version is bumped on success."""
    bundle = get_bundle(session, bundle_id)
    guard_and_bump_version(bundle, expected_version)

    for field in _BUNDLE_SCALAR_FIELDS:
        if field in changes:
            setattr(bundle, field, changes[field])

    if "notes" in changes:
        bundle.notes = _normalize_notes(changes["notes"])

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


def _restage_file(session: Session, asset_file: AssetFile) -> AssetBundle:
    """Move ``asset_file`` into a fresh provisional/``scan_suggestion`` one-file
    bundle so it falls back into the **Unbundled** view — exactly as a scan would
    stage it. ``AssetFile.id`` is preserved (its thumbnail cache and any
    file-level notes survive). Returns the new staging bundle.

    The file is moved by FK reassignment (as grouping apply does): reassigning to
    a pending parent via the ``bundle`` relationship would trip delete-orphan on
    the old collection.
    """
    staged = AssetBundle(
        title=Path(asset_file.original_filename).stem or asset_file.original_filename,
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(staged)
    session.flush()
    asset_file.bundle_id = staged.id
    asset_file.sequence = 0
    return staged


def delete_bundle(session: Session, bundle_id: str) -> None:
    """Delete a bundle (metadata only; the files on disk are never touched,
    AGENTS.md §3).

    Deleting a *confirmed* bundle only dissolves the grouping: each still-linked
    file is re-staged into its own provisional/``scan_suggestion`` one-file bundle
    so it falls back into the **Unbundled** view (see ``_restage_file``). The
    emptied original bundle (and its bundle-level tags, collections, cover/primary,
    and subtitle links) is then removed.

    Deleting an already-unbundled (provisional) bundle, or an empty bundle, just
    removes its rows — that is how a loose file is dropped from the library.
    """
    bundle = get_bundle(session, bundle_id)
    files = list(bundle.files)
    if bundle.grouping_state is GroupingState.CONFIRMED and files:
        for f in files:
            _restage_file(session, f)
        session.flush()
        # The files' FK now points at the staged bundles, so drop the stale
        # ``bundle.files`` collection: the delete-orphan cascade must see it empty
        # (and not re-claim the re-staged files) when the bundle is deleted.
        session.expire(bundle, ["files"])
    session.delete(bundle)
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
    relative_path: str,
    role: FileRole,
    media_kind: MediaKind,
    display_title: str | None = None,
    sequence: int = 0,
    note: str | None = None,
    source: str | None = None,
    mime_type: str | None = None,
) -> AssetFile:
    """Link an existing on-disk file (library-relative) into the bundle without
    copying it (ADR-0008: the library DB is the storage scope)."""
    get_bundle(session, bundle_id)
    root_path = library_root_for_session(session)

    try:
        normalized = normalize_relative_path(relative_path)
        # If the library root is currently mounted, also reject symlink escapes.
        if Path(root_path).exists():
            resolve_within_root(root_path, normalized)
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc

    filename = normalized.rsplit("/", 1)[-1]
    asset_file = AssetFile(
        bundle_id=bundle_id,
        relative_path=normalized,
        original_filename=filename,
        display_title=display_title or filename,
        note=note,
        source=source,
        role=role,
        media_kind=media_kind,
        mime_type=mime_type,
        sequence=sequence,
    )
    session.add(asset_file)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"{normalized!r} is already linked in this library") from exc
    return asset_file


_FILE_SCALAR_FIELDS = ("display_title", "note", "source")


def update_file(
    session: Session,
    bundle_id: str,
    file_id: str,
    changes: dict[str, Any],
    *,
    expected_version: int | None = None,
) -> AssetFile:
    """Update file-level metadata (display title/note/link/role/order).

    Only the on-bundle membership and metadata change — the physical file is
    never touched. ``expected_version`` enables optimistic concurrency (phase 9)."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise NotFoundError(f"file {file_id!r} is not part of bundle {bundle_id!r}")
    guard_and_bump_version(asset_file, expected_version)
    for field in _FILE_SCALAR_FIELDS:
        if field in changes:
            setattr(asset_file, field, changes[field])
    if "role" in changes:
        asset_file.role = changes["role"]
    if "sequence" in changes:
        asset_file.sequence = changes["sequence"]
    asset_file.updated_at = utcnow()
    session.flush()
    return asset_file


def reorder_files(session: Session, bundle_id: str, ordered_ids: list[str]) -> list[AssetFile]:
    """Set each file's ``sequence`` from its position in ``ordered_ids``.

    ``ordered_ids`` must be exactly the bundle's current files."""
    files = list_files(session, bundle_id)
    by_id = {f.id: f for f in files}
    if set(ordered_ids) != set(by_id):
        raise ValidationError("ordered ids must be exactly the bundle's current files")
    for sequence, file_id in enumerate(ordered_ids):
        by_id[file_id].sequence = sequence
    session.flush()
    return [by_id[file_id] for file_id in ordered_ids]


def remove_file(session: Session, bundle_id: str, file_id: str) -> None:
    """Remove a file from its bundle (metadata only; the file stays on disk).

    The file is not unlinked from the library — it is re-staged into its own
    provisional/``scan_suggestion`` one-file bundle (see ``_restage_file``) so it
    falls back into the **Unbundled** view rather than being dropped, mirroring
    what deleting its bundle does. ``AssetFile.id`` is preserved. If the file was
    the source bundle's cover/primary, those references are cleared (DB SET NULL
    once the FK moves away)."""
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise NotFoundError(f"file {file_id!r} is not part of bundle {bundle_id!r}")
    source = get_bundle(session, bundle_id)
    # Clear cover/primary pointers on the source bundle before the FK moves, so a
    # stale reference to the departed file can't linger.
    if source.cover_file_id == file_id:
        source.cover_file_id = None
    if source.primary_file_id == file_id:
        source.primary_file_id = None
    session.flush()
    _restage_file(session, asset_file)
    session.flush()


# --- Tag / collection assignment ---------------------------------------------
def set_bundle_tags(session: Session, bundle_id: str, tag_ids: list[str]) -> AssetBundle:
    bundle = get_bundle(session, bundle_id)
    bundle.tags = _resolve_all(session, Tag, tag_ids, label="tag")
    bundle.updated_at = utcnow()
    session.flush()
    return bundle


def set_bundle_collections(
    session: Session, bundle_id: str, collection_ids: list[str]
) -> AssetBundle:
    bundle = get_bundle(session, bundle_id)
    bundle.collections = _resolve_all(session, Collection, collection_ids, label="collection")
    bundle.updated_at = utcnow()
    session.flush()
    return bundle


def batch_update_bundles(
    session: Session,
    *,
    bundle_ids: list[str],
    add_tag_ids: list[str] | None = None,
    remove_tag_ids: list[str] | None = None,
    add_collection_ids: list[str] | None = None,
    remove_collection_ids: list[str] | None = None,
) -> int:
    """Add/remove tags and collections across many bundles. Returns the count.

    Adds and removes are applied as set operations per bundle, so the call is
    idempotent (re-adding an existing tag is a no-op)."""
    bundles = [get_bundle(session, bundle_id) for bundle_id in bundle_ids]
    add_tags = _resolve_all(session, Tag, add_tag_ids or [], label="tag")
    add_collections = _resolve_all(
        session, Collection, add_collection_ids or [], label="collection"
    )
    remove_tag_set = set(remove_tag_ids or [])
    remove_collection_set = set(remove_collection_ids or [])

    for bundle in bundles:
        tags = {t.id: t for t in bundle.tags if t.id not in remove_tag_set}
        tags.update({t.id: t for t in add_tags})
        bundle.tags = list(tags.values())

        collections = {c.id: c for c in bundle.collections if c.id not in remove_collection_set}
        collections.update({c.id: c for c in add_collections})
        bundle.collections = list(collections.values())

        bundle.updated_at = utcnow()

    session.flush()
    return len(bundles)


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


def _resolve_all[M: (Tag, Collection)](
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
