"""Tag-group service: navigational categories, many-to-many with tags.

Groups are independent of the tag hierarchy (ADR-0002 / AGENTS.md §4.6) — a
tag may belong to several groups, and group membership never changes
parent/descendant semantics.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.models import Tag, TagGroup
from cairndex.services.pagination import keyset_page


def get_tag_group(session: Session, group_id: str) -> TagGroup:
    group = session.get(TagGroup, group_id)
    if group is None:
        raise NotFoundError(f"tag group {group_id!r} not found")
    return group


def create_tag_group(session: Session, *, name: str) -> TagGroup:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    group = TagGroup(name=name)
    session.add(group)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a tag group named {name!r} already exists") from exc
    return group


def list_tag_groups(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[TagGroup], str | None]:
    return keyset_page(session, select(TagGroup), TagGroup.id, limit, cursor)


def update_tag_group(session: Session, group_id: str, *, name: str | None = None) -> TagGroup:
    group = get_tag_group(session, group_id)
    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        group.name = cleaned
    group.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a tag group with that name already exists") from exc
    return group


def delete_tag_group(session: Session, group_id: str) -> None:
    """Delete a group (metadata only). Memberships cascade; the tags
    themselves are untouched."""
    session.delete(get_tag_group(session, group_id))
    session.flush()


def set_group_tags(session: Session, group_id: str, tag_ids: list[str]) -> TagGroup:
    """Replace the group's tag membership with exactly ``tag_ids``."""
    group = get_tag_group(session, group_id)
    unique_ids = list(dict.fromkeys(tag_ids))
    tags = list(session.scalars(select(Tag).where(Tag.id.in_(unique_ids)))) if unique_ids else []
    if len(tags) != len(unique_ids):
        missing = set(unique_ids) - {t.id for t in tags}
        raise ValidationError(f"unknown tag ids: {sorted(missing)}")
    group.tags = tags
    group.updated_at = utcnow()
    session.flush()
    return group
