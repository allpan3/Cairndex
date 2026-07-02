"""Tag-group service: navigational categories, many-to-many with tags.

Groups are independent of the tag hierarchy (ADR-0002 / AGENTS.md §4.6) — a
tag may belong to several groups, and group membership never changes
parent/descendant semantics.
"""

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.models import Tag, TagGroup, tag_group_memberships
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
    """Replace the group's tag membership with exactly ``tag_ids``, preserving the
    given order as the initial membership ``sort_order``."""
    group = get_tag_group(session, group_id)
    unique_ids = list(dict.fromkeys(tag_ids))
    tags = list(session.scalars(select(Tag).where(Tag.id.in_(unique_ids)))) if unique_ids else []
    if len(tags) != len(unique_ids):
        missing = set(unique_ids) - {t.id for t in tags}
        raise ValidationError(f"unknown tag ids: {sorted(missing)}")
    group.tags = tags
    group.updated_at = utcnow()
    session.flush()
    # Stamp membership order from the request order (relationship assignment
    # doesn't set the association's sort_order column).
    for index, tag_id in enumerate(unique_ids):
        session.execute(
            update(tag_group_memberships)
            .where(
                (tag_group_memberships.c.group_id == group_id)
                & (tag_group_memberships.c.tag_id == tag_id)
            )
            .values(sort_order=index)
        )
    session.flush()
    return group


def list_group_tag_ids(session: Session, group_id: str) -> list[str]:
    """Member tag ids for a group, ordered by membership ``sort_order`` then id —
    the order the All Tags page and tag pickers display within a group."""
    get_tag_group(session, group_id)  # 404 guard
    rows = session.execute(
        select(tag_group_memberships.c.tag_id)
        .where(tag_group_memberships.c.group_id == group_id)
        .order_by(tag_group_memberships.c.sort_order, tag_group_memberships.c.tag_id)
    ).all()
    return [row[0] for row in rows]


def reorder_group_tags(session: Session, group_id: str, ordered_tag_ids: list[str]) -> TagGroup:
    """Reorder tags *within* a group by rewriting membership ``sort_order``. This
    is group-display order only — it never touches tag hierarchy ``parent_id``."""
    group = get_tag_group(session, group_id)
    member_ids = {t.id for t in group.tags}
    unknown = [tid for tid in ordered_tag_ids if tid not in member_ids]
    if unknown:
        raise ValidationError(f"tags not in this group: {sorted(unknown)}")
    for index, tag_id in enumerate(ordered_tag_ids):
        session.execute(
            update(tag_group_memberships)
            .where(
                (tag_group_memberships.c.group_id == group_id)
                & (tag_group_memberships.c.tag_id == tag_id)
            )
            .values(sort_order=index)
        )
    group.updated_at = utcnow()
    session.flush()
    return group
