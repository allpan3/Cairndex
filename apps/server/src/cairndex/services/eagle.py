"""Eagle import executor (ADR-0004, AGENTS.md §7).

Applies a parsed library idempotently: the library's ``images/`` directory
becomes a (reused) storage root, collections/tags/groups are created-or-reused
by name (Eagle folders import into collections), and each not-yet-imported,
non-deleted item becomes one bundle + one
linked file. Every item is recorded in ``import_records`` so re-running is
safe. The Eagle library itself is never modified.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.eagle.reader import EagleLibrary, read_library
from cairndex.persistence.models import Collection, ImportRecord, StorageRoot, Tag, TagGroup
from cairndex.scanning.media_types import classify
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services import storage_roots as root_service
from cairndex.services import tag_groups as group_service
from cairndex.services import tags as tag_service
from cairndex.services.storage_roots import _normalize_canonical_path

_PROVIDER = "eagle"


@dataclass
class ImportResult:
    bundles_created: int = 0
    collections_created: int = 0
    tags_created: int = 0
    tag_groups_created: int = 0
    skipped: int = 0


def existing_external_ids(session: Session, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    rows = session.scalars(
        select(ImportRecord.external_id).where(
            ImportRecord.provider == _PROVIDER, ImportRecord.external_id.in_(ids)
        )
    )
    return set(rows)


def _ensure_storage_root(session: Session, library: EagleLibrary) -> StorageRoot:
    canonical = _normalize_canonical_path(str(library.images_dir))
    existing = session.scalar(select(StorageRoot).where(StorageRoot.canonical_path == canonical))
    if existing is not None:
        return existing
    name = f"Eagle: {library.path.name}"
    return root_service.create_storage_root(
        session, name=name, canonical_path=str(library.images_dir), read_only=True
    )


def _ensure_collections(
    session: Session, library: EagleLibrary, result: ImportResult
) -> dict[str, str]:
    """Create/reuse collections, returning Eagle folder id → Cairndex
    collection id (Eagle folders import into Cairndex collections)."""
    mapping: dict[str, str] = {}
    for ef in library.folders:  # parents precede children (reader flattens depth-first)
        parent_id = mapping.get(ef.parent_id) if ef.parent_id else None
        existing = session.scalar(
            select(Collection).where(Collection.parent_id == parent_id, Collection.name == ef.name)
        )
        if existing is not None:
            mapping[ef.id] = existing.id
            continue
        collection = collection_service.create_collection(
            session, name=ef.name, parent_id=parent_id
        )
        result.collections_created += 1
        mapping[ef.id] = collection.id
    return mapping


def _ensure_tag(session: Session, name: str, result: ImportResult, cache: dict[str, str]) -> str:
    if name in cache:
        return cache[name]
    existing = session.scalar(select(Tag).where(Tag.parent_id.is_(None), Tag.name == name))
    if existing is not None:
        cache[name] = existing.id
        return existing.id
    try:
        tag_id = tag_service.create_tag(session, name=name).id
        result.tags_created += 1
    except ConflictError:  # normalized-name collision — reuse the existing tag
        existing = session.scalar(
            select(Tag).where(Tag.parent_id.is_(None), Tag.name == name.strip())
        )
        assert existing is not None
        tag_id = existing.id
    cache[name] = tag_id
    return tag_id


def _ensure_tag_groups(
    session: Session, library: EagleLibrary, result: ImportResult, tag_cache: dict[str, str]
) -> None:
    for group in library.tag_groups:
        existing = session.scalar(select(TagGroup).where(TagGroup.name == group.name))
        if existing is None:
            existing = group_service.create_tag_group(session, name=group.name)
            result.tag_groups_created += 1
        tag_ids = [_ensure_tag(session, t, result, tag_cache) for t in group.tags]
        if tag_ids:
            group_service.set_group_tags(session, existing.id, tag_ids)


def import_library(session: Session, library_path: str) -> ImportResult:
    library = read_library(Path(library_path))
    result = ImportResult()

    root = _ensure_storage_root(session, library)
    collection_map = _ensure_collections(session, library, result)
    tag_cache: dict[str, str] = {}
    _ensure_tag_groups(session, library, result, tag_cache)

    already = existing_external_ids(session, [i.id for i in library.items])

    for item in library.items:
        if item.is_deleted or item.id in already:
            result.skipped += 1
            continue
        bundle = bundle_service.create_bundle(
            session, title=item.name, note=item.annotation, rating=item.star
        )
        kind_role = classify(f"{item.name}.{item.ext}")
        media_kind, role = kind_role or (MediaKind.OTHER, FileRole.OTHER)
        bundle_service.add_file(
            session,
            bundle.id,
            storage_root_id=root.id,
            relative_path=item.file_relpath,
            role=role,
            media_kind=media_kind,
            source=item.url,
        )
        if item.tags:
            tag_ids = [_ensure_tag(session, t, result, tag_cache) for t in item.tags]
            bundle_service.set_bundle_tags(session, bundle.id, tag_ids)
        collection_ids = [collection_map[f] for f in item.folder_ids if f in collection_map]
        if collection_ids:
            bundle_service.set_bundle_collections(session, bundle.id, collection_ids)

        session.add(ImportRecord(provider=_PROVIDER, external_id=item.id, bundle_id=bundle.id))
        session.flush()
        result.bundles_created += 1

    return result
