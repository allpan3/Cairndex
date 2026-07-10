"""Compile a validated filter AST into a parameterized SQLAlchemy predicate.

The result is a boolean ``ColumnElement`` over ``AssetBundle`` for use in
``select(AssetBundle).where(...)``. Only allowlisted fields/operators compile;
anything else raises ``ValidationError`` (HTTP 422) — so a malformed or hostile
expression can never reach SQL, and every value is a bound parameter, never
interpolated text (AGENTS.md §10).
"""

import operator as op
from collections.abc import Callable
from datetime import datetime
from typing import Any

from sqlalchemy import and_, exists, func, not_, or_, select, true
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.filters.ast import (
    AndNode,
    FilterExpression,
    NotNode,
    OrNode,
    PredicateNode,
)
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    Tag,
    asset_bundle_collections,
    asset_bundle_tags,
)
from cairndex.services.hierarchy import descendant_ids

_NUM_OPS: dict[str, Callable[[Any, Any], Any]] = {
    "eq": op.eq,
    "neq": op.ne,
    "gt": op.gt,
    "gte": op.ge,
    "lt": op.lt,
    "lte": op.le,
}

# SQLAlchemy expressions are dynamically typed here; alias as Any so mypy
# doesn't flag every parameterized-expression return.
Bool = Any


def compile_expression(session: Session, expr: FilterExpression) -> Bool:
    if expr.root is None:
        return true()
    return _compile(session, expr.root)


def _compile(session: Session, node: object) -> Bool:
    if isinstance(node, AndNode):
        return and_(*(_compile(session, c) for c in node.children)) if node.children else true()
    if isinstance(node, OrNode):
        return or_(*(_compile(session, c) for c in node.children)) if node.children else true()
    if isinstance(node, NotNode):
        return not_(_compile(session, node.child))
    if isinstance(node, PredicateNode):
        return _compile_predicate(session, node)
    raise ValidationError("unknown filter node")  # pragma: no cover


# --- predicate helpers -------------------------------------------------------
def _text(column: Any, operator: str, value: Any) -> Bool:
    if not isinstance(value, str):
        raise ValidationError("text filter value must be a string")
    if operator == "contains":
        return column.icontains(value, autoescape=True)
    if operator == "not_contains":
        return not_(column.icontains(value, autoescape=True))
    if operator == "equals":
        return column == value
    if operator == "starts_with":
        return column.istartswith(value, autoescape=True)
    raise ValidationError(f"operator {operator!r} is not valid for text fields")


def _notes_text(operator: str, value: Any) -> Bool:
    """Match text within any of a bundle's ``notes`` (a JSON array of strings).

    Compiles to an ``EXISTS`` over ``json_each(asset_bundles.notes)`` so the
    match is per-note and exact (no false hits across the JSON delimiters). A
    NULL/empty ``notes`` yields no rows, so ``contains`` is false and
    ``not_contains`` is true for a note-less bundle."""
    if not isinstance(value, str):
        raise ValidationError("text filter value must be a string")
    each = func.json_each(AssetBundle.notes).table_valued("value")
    col = each.c.value

    def has(condition: Bool) -> Bool:
        return select(1).select_from(each).where(condition).exists()

    if operator == "contains":
        return has(col.icontains(value, autoescape=True))
    if operator == "not_contains":
        return not_(has(col.icontains(value, autoescape=True)))
    if operator == "equals":
        return has(col == value)
    if operator == "starts_with":
        return has(col.istartswith(value, autoescape=True))
    raise ValidationError(f"operator {operator!r} is not valid for text fields")


def _numeric(column: Any, operator: str, value: Any) -> Bool:
    if operator == "between":
        if not (isinstance(value, list) and len(value) == 2):
            raise ValidationError("'between' needs a [low, high] value")
        return column.between(value[0], value[1])
    fn = _NUM_OPS.get(operator)
    if fn is None:
        raise ValidationError(f"operator {operator!r} is not valid for numeric fields")
    if not isinstance(value, (int, float)):
        raise ValidationError("numeric filter value must be a number")
    return fn(column, value)


def _parse_dt(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValidationError("date filter value must be an ISO-8601 string")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"invalid date: {value!r}") from exc


def _date(column: Any, operator: str, value: Any) -> Bool:
    if operator == "between":
        if not (isinstance(value, list) and len(value) == 2):
            raise ValidationError("'between' needs a [low, high] value")
        return column.between(_parse_dt(value[0]), _parse_dt(value[1]))
    fn = _NUM_OPS.get(operator)
    if fn is None or operator in ("eq", "neq"):
        raise ValidationError(f"operator {operator!r} is not valid for date fields")
    return fn(column, _parse_dt(value))


def _file_exists(condition: Bool) -> Bool:
    return exists().where((AssetFile.bundle_id == AssetBundle.id) & condition)


def _expand(session: Session, model: type[Tag] | type[Collection], ids: list[str]) -> list[str]:
    out: list[str] = []
    for i in ids:
        out.extend(descendant_ids(session, model, i, include_self=True))
    return out


def _membership(
    session: Session,
    *,
    bundle_col: Any,
    member_col: Any,
    model: type[Tag] | type[Collection],
    node: PredicateNode,
) -> Bool:
    if not isinstance(node.value, list):
        raise ValidationError(f"{node.field} filter value must be a list of ids")
    ids: list[str] = node.value

    def has(in_ids: list[str]) -> Bool:
        # Non-correlated semijoin (``bundle IN (SELECT ... WHERE member IN ids)``)
        # rather than a per-bundle correlated EXISTS. The inner match set is
        # computed once (via the association-table indexes) instead of once per
        # candidate bundle — decisive when descendant expansion makes ``in_ids``
        # large: measured ~7.2s → ~0.15s for tag-descendant filters at 100k
        # bundles (perf/M2). Semantically identical to the EXISTS form.
        return AssetBundle.id.in_(select(bundle_col).where(member_col.in_(in_ids)))

    if node.operator == "contains_all":
        clauses = [
            has(_expand(session, model, [i]) if node.include_descendants else [i]) for i in ids
        ]
        return and_(*clauses) if clauses else true()

    expanded = _expand(session, model, ids) if node.include_descendants else ids
    if node.operator == "contains_any":
        return has(expanded)
    if node.operator == "contains_none":
        return not_(has(expanded))
    raise ValidationError(f"operator {node.operator!r} is not valid for {node.field}")


def _file_count_col() -> Any:
    return (
        select(func.count())
        .select_from(AssetFile)
        .where(AssetFile.bundle_id == AssetBundle.id)
        .scalar_subquery()
    )


def _size_col() -> Any:
    return (
        select(func.coalesce(func.sum(AssetFile.size_bytes), 0))
        .where(AssetFile.bundle_id == AssetBundle.id)
        .scalar_subquery()
    )


def _has_cover_expr() -> Bool:
    return or_(
        AssetBundle.cover_file_id.isnot(None),
        _file_exists(AssetFile.media_kind == MediaKind.IMAGE),
    )


def _as_bool(value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValidationError("boolean filter value must be true or false")
    return value


# --- field dispatch ----------------------------------------------------------
def _compile_predicate(session: Session, node: PredicateNode) -> Bool:
    field = node.field
    o, v = node.operator, node.value

    if field in ("title", "name"):
        return _text(AssetBundle.title, o, v)
    if field == "notes":
        return _notes_text(o, v)
    if field == "filename":
        return _file_exists_text(o, v)
    if field == "source":
        return _file_exists(_text_on(AssetFile.source, o, v))
    if field == "rating":
        # ``is_null`` is a rating-specific operator for the "Unrated" filter
        # (rating IS NULL). Kept off the generic numeric path so every numeric
        # field doesn't silently accept null.
        if o == "is_null":
            return AssetBundle.rating.is_(None) if _as_bool(v) else AssetBundle.rating.isnot(None)
        return _numeric(AssetBundle.rating, o, v)
    if field == "file_count":
        return _numeric(_file_count_col(), o, v)
    if field == "size_bytes":
        return _numeric(_size_col(), o, v)
    if field == "date_added":
        return _date(AssetBundle.created_at, o, v)
    if field == "tags":
        return _membership(
            session,
            bundle_col=asset_bundle_tags.c.bundle_id,
            member_col=asset_bundle_tags.c.tag_id,
            model=Tag,
            node=node,
        )
    if field == "collections":
        return _membership(
            session,
            bundle_col=asset_bundle_collections.c.bundle_id,
            member_col=asset_bundle_collections.c.collection_id,
            model=Collection,
            node=node,
        )
    if field == "extension":
        return _extension(o, v)
    if field == "has_cover":
        if o != "equals":
            raise ValidationError("has_cover only supports 'equals'")
        return _has_cover_expr() if _as_bool(v) else not_(_has_cover_expr())
    if field == "has_missing":
        if o != "equals":
            raise ValidationError("has_missing only supports 'equals'")
        miss = _file_exists(AssetFile.availability == FileAvailability.MISSING)
        return miss if _as_bool(v) else not_(miss)
    raise ValidationError(f"unknown filter field {field!r}")


def _text_on(column: Any, operator: str, value: Any) -> Bool:
    return _text(column, operator, value)


def _file_exists_text(operator: str, value: Any) -> Bool:
    return _file_exists(_text(AssetFile.relative_path, operator, value))


def _extension(operator: str, value: Any) -> Bool:
    if operator == "equals":
        exts = [value]
    elif operator in ("in", "not_in"):
        if not isinstance(value, list):
            raise ValidationError("'in'/'not_in' need a list value")
        exts = value
    else:
        raise ValidationError(f"operator {operator!r} is not valid for extension")
    patterns = [func.lower(AssetFile.relative_path).like(f"%.{str(e).lower()}") for e in exts]
    sub = _file_exists(or_(*patterns)) if patterns else true()
    return not_(sub) if operator == "not_in" else sub
