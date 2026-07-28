"""Tag domain service: hierarchy (adjacency list) independent of tag groups."""

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.models import Tag, asset_bundle_tags
from cairndex.services.hierarchy import descendant_ids, is_descendant
from cairndex.services.pagination import keyset_page


def get_tag(session: Session, tag_id: str) -> Tag:
    tag = session.get(Tag, tag_id)
    if tag is None:
        raise NotFoundError(f"tag {tag_id!r} not found")
    return tag


def _require_parent(session: Session, parent_id: str | None) -> None:
    if parent_id is not None and session.get(Tag, parent_id) is None:
        raise ValidationError(f"parent tag {parent_id!r} does not exist")


def create_tag(
    session: Session,
    *,
    name: str,
    parent_id: str | None = None,
    color: str | None = None,
) -> Tag:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _require_parent(session, parent_id)

    tag = Tag(name=name, parent_id=parent_id, color=color)
    session.add(tag)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"a sibling tag named {name!r} already exists under this parent"
        ) from exc
    return tag


def list_tags(session: Session, *, limit: int, cursor: str | None) -> tuple[list[Tag], str | None]:
    return keyset_page(session, select(Tag), Tag.id, limit, cursor)


def update_tag(
    session: Session,
    tag_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    set_parent: bool = False,
    color: str | None = None,
    set_color: bool = False,
    expected_version: int | None = None,
) -> Tag:
    """Update a tag. ``set_parent``/``set_color`` distinguish "set to null"
    from "leave unchanged" for the nullable fields. ``expected_version`` enables
    optimistic concurrency (phase 9)."""
    tag = get_tag(session, tag_id)
    guard_and_bump_version(tag, expected_version)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        tag.name = cleaned

    if set_parent:
        if parent_id == tag_id:
            raise ValidationError("a tag cannot be its own parent")
        if parent_id is not None:
            _require_parent(session, parent_id)
            if is_descendant(session, Tag, candidate_id=parent_id, of_id=tag_id):
                raise ValidationError("cannot move a tag under its own descendant")
        tag.parent_id = parent_id

    if set_color:
        tag.color = color

    tag.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a sibling tag with that name already exists") from exc
    return tag


def delete_tag(session: Session, tag_id: str, *, cascade: bool = False) -> None:
    """Delete a tag (metadata only). Bundle/tag assignments and tag-group
    memberships fall away via FK cascade; no file or bundle is touched.

    A tag with children needs ``cascade``, which deletes the whole subtree. It
    used to be refused outright so the owner would move the children first, but
    that made deleting a parent look broken rather than guarded (owner,
    2026-07-27) — the decision belongs to the caller, which asks first and says
    how many tags it is about to take.
    """
    tag = get_tag(session, tag_id)
    child_count = (
        session.scalar(select(func.count()).select_from(Tag).where(Tag.parent_id == tag_id)) or 0
    )
    if child_count and not cascade:
        raise ConflictError(
            "this tag has child tags — deleting it removes them too; confirm to continue"
        )
    if cascade:
        # Deepest first, so no row is orphaned mid-transaction whatever the
        # database's own FK behaviour is.
        ids = descendant_ids(session, Tag, tag_id, include_self=True)
        for descendant_id in reversed(ids):
            descendant = session.get(Tag, descendant_id)
            if descendant is not None:
                session.delete(descendant)
    else:
        session.delete(tag)
    session.flush()


def tag_delete_impact(session: Session, tag_id: str) -> tuple[int, int]:
    """How many tags a delete would remove, and how many bundles it would touch.

    Asked before the confirmation prompt so the prompt can say what it costs.
    """
    get_tag(session, tag_id)  # 404 for an unknown tag, like every other tag route
    ids = descendant_ids(session, Tag, tag_id, include_self=True)
    bundles = (
        session.scalar(
            select(func.count(func.distinct(asset_bundle_tags.c.bundle_id))).where(
                asset_bundle_tags.c.tag_id.in_(ids)
            )
        )
        or 0
    )
    return len(ids), bundles


def tag_descendant_ids(session: Session, tag_id: str, *, include_self: bool = True) -> list[str]:
    get_tag(session, tag_id)
    return descendant_ids(session, Tag, tag_id, include_self=include_self)
