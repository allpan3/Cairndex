"""Smart Collection domain service: saved filter expressions (AGENTS.md §4.8).

A Smart Collection (formerly "Smart Folder") is a named, persisted filter AST
plus presentation defaults. The stored ``filter_json`` is validated as a
``FilterExpression`` *and* compiled once on write, so a structurally-valid-but-
unsupported filter (unknown field, bad operator) is rejected at save time rather
than surfacing later at browse.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.models import SmartCollection


def _validate(session: Session, filter_expr: FilterExpression) -> None:
    # Raises ValidationError for unknown fields/operators/value types.
    compile_expression(session, filter_expr)


def get_smart_collection(session: Session, smart_collection_id: str) -> SmartCollection:
    sc = session.get(SmartCollection, smart_collection_id)
    if sc is None:
        raise NotFoundError(f"smart collection {smart_collection_id!r} not found")
    return sc


def list_smart_collections(session: Session) -> list[SmartCollection]:
    stmt = select(SmartCollection).order_by(SmartCollection.sort_order, SmartCollection.created_at)
    return list(session.scalars(stmt))


def create_smart_collection(
    session: Session,
    *,
    name: str,
    filter_expr: FilterExpression,
    default_sort: str | None = None,
    default_layout: str | None = None,
    sort_order: int = 0,
) -> SmartCollection:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _validate(session, filter_expr)

    sc = SmartCollection(
        name=name,
        filter_version=filter_expr.version,
        filter_json=filter_expr.model_dump(mode="json"),
        default_sort=default_sort,
        default_layout=default_layout,
        sort_order=sort_order,
    )
    session.add(sc)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a smart collection named {name!r} already exists") from exc
    return sc


def update_smart_collection(
    session: Session,
    smart_collection_id: str,
    *,
    name: str | None = None,
    filter_expr: FilterExpression | None = None,
    default_sort: str | None = None,
    set_default_sort: bool = False,
    default_layout: str | None = None,
    set_default_layout: bool = False,
    sort_order: int | None = None,
    expected_version: int | None = None,
) -> SmartCollection:
    sc = get_smart_collection(session, smart_collection_id)
    guard_and_bump_version(sc, expected_version)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        sc.name = cleaned
    if filter_expr is not None:
        _validate(session, filter_expr)
        sc.filter_version = filter_expr.version
        sc.filter_json = filter_expr.model_dump(mode="json")
    if set_default_sort:
        sc.default_sort = default_sort
    if set_default_layout:
        sc.default_layout = default_layout
    if sort_order is not None:
        sc.sort_order = sort_order

    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a smart collection named {sc.name!r} already exists") from exc
    return sc


def delete_smart_collection(session: Session, smart_collection_id: str) -> None:
    sc = get_smart_collection(session, smart_collection_id)
    session.delete(sc)
    session.flush()
