"""Smart Folder domain service: saved filter expressions (AGENTS.md §4.8).

A Smart Folder is a named, persisted filter AST plus presentation defaults.
The stored ``filter_json`` is validated as a ``FilterExpression`` *and* compiled
once on write, so a structurally-valid-but-unsupported filter (unknown field,
bad operator) is rejected at save time rather than surfacing later at browse.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import SmartFolder


def _validate(session: Session, filter_expr: FilterExpression) -> None:
    # Raises ValidationError for unknown fields/operators/value types.
    compile_expression(session, filter_expr)


def get_smart_folder(session: Session, smart_folder_id: str) -> SmartFolder:
    sf = session.get(SmartFolder, smart_folder_id)
    if sf is None:
        raise NotFoundError(f"smart folder {smart_folder_id!r} not found")
    return sf


def list_smart_folders(session: Session) -> list[SmartFolder]:
    stmt = select(SmartFolder).order_by(SmartFolder.sort_order, SmartFolder.created_at)
    return list(session.scalars(stmt))


def create_smart_folder(
    session: Session,
    *,
    name: str,
    filter_expr: FilterExpression,
    default_sort: str | None = None,
    default_layout: str | None = None,
    sort_order: int = 0,
) -> SmartFolder:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _validate(session, filter_expr)

    sf = SmartFolder(
        name=name,
        filter_version=filter_expr.version,
        filter_json=filter_expr.model_dump(mode="json"),
        default_sort=default_sort,
        default_layout=default_layout,
        sort_order=sort_order,
    )
    session.add(sf)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a smart folder named {name!r} already exists") from exc
    return sf


def update_smart_folder(
    session: Session,
    smart_folder_id: str,
    *,
    name: str | None = None,
    filter_expr: FilterExpression | None = None,
    default_sort: str | None = None,
    set_default_sort: bool = False,
    default_layout: str | None = None,
    set_default_layout: bool = False,
    sort_order: int | None = None,
) -> SmartFolder:
    sf = get_smart_folder(session, smart_folder_id)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        sf.name = cleaned
    if filter_expr is not None:
        _validate(session, filter_expr)
        sf.filter_version = filter_expr.version
        sf.filter_json = filter_expr.model_dump(mode="json")
    if set_default_sort:
        sf.default_sort = default_sort
    if set_default_layout:
        sf.default_layout = default_layout
    if sort_order is not None:
        sf.sort_order = sort_order

    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a smart folder named {sf.name!r} already exists") from exc
    return sf


def delete_smart_folder(session: Session, smart_folder_id: str) -> None:
    sf = get_smart_folder(session, smart_folder_id)
    session.delete(sf)
    session.flush()
