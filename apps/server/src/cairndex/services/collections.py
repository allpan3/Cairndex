"""Collection domain service: hierarchical virtual groupings (AGENTS.md §4.7).

A Collection (formerly "folder") groups bundles logically. Membership is
many-to-many and never moves files on disk — it is independent of the physical
File View, which browses storage roots directly.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.models import Collection
from cairndex.services.hierarchy import descendant_ids, is_descendant
from cairndex.services.pagination import keyset_page


def get_collection(session: Session, collection_id: str) -> Collection:
    collection = session.get(Collection, collection_id)
    if collection is None:
        raise NotFoundError(f"collection {collection_id!r} not found")
    return collection


def _require_parent(session: Session, parent_id: str | None) -> None:
    if parent_id is not None and session.get(Collection, parent_id) is None:
        raise ValidationError(f"parent collection {parent_id!r} does not exist")


def create_collection(session: Session, *, name: str, parent_id: str | None = None) -> Collection:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _require_parent(session, parent_id)

    collection = Collection(name=name, parent_id=parent_id)
    session.add(collection)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"a sibling collection named {name!r} already exists under this parent"
        ) from exc
    return collection


def list_collections(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[Collection], str | None]:
    return keyset_page(session, select(Collection), Collection.id, limit, cursor)


def update_collection(
    session: Session,
    collection_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    set_parent: bool = False,
    expected_version: int | None = None,
) -> Collection:
    collection = get_collection(session, collection_id)
    guard_and_bump_version(collection, expected_version)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        collection.name = cleaned

    if set_parent:
        if parent_id == collection_id:
            raise ValidationError("a collection cannot be its own parent")
        if parent_id is not None:
            _require_parent(session, parent_id)
            if is_descendant(session, Collection, candidate_id=parent_id, of_id=collection_id):
                raise ValidationError("cannot move a collection under its own descendant")
        collection.parent_id = parent_id

    collection.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a sibling collection with that name already exists") from exc
    return collection


def delete_collection(session: Session, collection_id: str) -> None:
    """Delete a collection (metadata only). Children float to root (DB SET NULL);
    bundle memberships cascade — no bundle or file is deleted."""
    session.delete(get_collection(session, collection_id))
    session.flush()


def collection_descendant_ids(
    session: Session, collection_id: str, *, include_self: bool = True
) -> list[str]:
    get_collection(session, collection_id)
    return descendant_ids(session, Collection, collection_id, include_self=include_self)
