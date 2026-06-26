"""Filter AST validation + compilation (the security-critical Phase 5 core)."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import AssetBundle
from cairndex.services import bundles as bundle_service
from cairndex.services import folders as folder_service
from cairndex.services import storage_roots as root_service
from cairndex.services import tags as tag_service


def _matches(session: Session, ast: dict) -> set[str]:
    expr = FilterExpression.model_validate(ast)
    pred = compile_expression(session, expr)
    rows = session.scalars(select(AssetBundle.id).where(pred))
    return set(rows)


def _count(session: Session, ast: dict) -> int:
    pred = compile_expression(session, FilterExpression.model_validate(ast))
    return session.scalar(select(func.count()).select_from(AssetBundle).where(pred)) or 0


# --- AST validation ----------------------------------------------------------
def test_logical_and_predicate_nodes_are_disambiguated() -> None:
    expr = FilterExpression.model_validate(
        {
            "version": 1,
            "root": {"op": "and", "children": [{"field": "rating", "operator": "gte", "value": 4}]},
        }
    )
    assert expr.root is not None


def test_unknown_keys_are_rejected() -> None:
    with pytest.raises(Exception):  # noqa: B017 - pydantic ValidationError
        FilterExpression.model_validate(
            {"version": 1, "root": {"field": "title", "operator": "eq", "value": 1, "bogus": 2}}
        )


def test_empty_expression_matches_everything(session: Session) -> None:
    bundle_service.create_bundle(session, title="a")
    bundle_service.create_bundle(session, title="b")
    session.commit()
    assert _count(session, {"version": 1, "root": None}) == 2


# --- compilation: invalid cannot reach SQL ----------------------------------
def test_unknown_field_rejected(session: Session) -> None:
    with pytest.raises(ValidationError):
        compile_expression(
            session,
            FilterExpression.model_validate(
                {"version": 1, "root": {"field": "x", "operator": "eq", "value": 1}}
            ),
        )


def test_bad_operator_for_field_rejected(session: Session) -> None:
    with pytest.raises(ValidationError):
        compile_expression(
            session,
            FilterExpression.model_validate(
                {"version": 1, "root": {"field": "rating", "operator": "contains", "value": 1}}
            ),
        )


def test_wrong_value_type_rejected(session: Session) -> None:
    with pytest.raises(ValidationError):
        compile_expression(
            session,
            FilterExpression.model_validate(
                {"version": 1, "root": {"field": "rating", "operator": "gte", "value": "high"}}
            ),
        )


# --- compilation: results ----------------------------------------------------
def test_text_and_rating(session: Session) -> None:
    a = bundle_service.create_bundle(session, title="The Matrix", rating=5)
    bundle_service.create_bundle(session, title="The Matrix", rating=2)
    bundle_service.create_bundle(session, title="Other", rating=5)
    session.commit()

    got = _matches(
        session,
        {
            "version": 1,
            "root": {
                "op": "and",
                "children": [
                    {"field": "title", "operator": "contains", "value": "matrix"},
                    {"field": "rating", "operator": "gte", "value": 4},
                ],
            },
        },
    )
    assert got == {a.id}


def test_not_and_or(session: Session) -> None:
    a = bundle_service.create_bundle(session, title="alpha", rating=5)
    b = bundle_service.create_bundle(session, title="beta", rating=1)
    session.commit()
    # rating>=4 OR title contains 'beta', but NOT title contains 'alpha'
    got = _matches(
        session,
        {
            "version": 1,
            "root": {
                "op": "and",
                "children": [
                    {
                        "op": "or",
                        "children": [
                            {"field": "rating", "operator": "gte", "value": 4},
                            {"field": "title", "operator": "contains", "value": "beta"},
                        ],
                    },
                    {
                        "op": "not",
                        "child": {"field": "title", "operator": "contains", "value": "alpha"},
                    },
                ],
            },
        },
    )
    assert got == {b.id}
    assert a.id not in got


def test_tags_any_all_none_with_descendants(session: Session) -> None:
    parent = tag_service.create_tag(session, name="genre")
    child = tag_service.create_tag(session, name="thriller", parent_id=parent.id)
    other = tag_service.create_tag(session, name="watched")

    b_child = bundle_service.create_bundle(session, title="has child tag")
    bundle_service.set_bundle_tags(session, b_child.id, [child.id])
    b_other = bundle_service.create_bundle(session, title="watched only")
    bundle_service.set_bundle_tags(session, b_other.id, [other.id])
    session.commit()

    # contains_any [parent] with descendants matches the bundle tagged with the child.
    assert _matches(
        session,
        {
            "version": 1,
            "root": {
                "field": "tags",
                "operator": "contains_any",
                "value": [parent.id],
                "include_descendants": True,
            },
        },
    ) == {b_child.id}
    # Without descendants, the parent tag alone matches nothing.
    assert (
        _matches(
            session,
            {
                "version": 1,
                "root": {
                    "field": "tags",
                    "operator": "contains_any",
                    "value": [parent.id],
                    "include_descendants": False,
                },
            },
        )
        == set()
    )
    # contains_none [watched] excludes the watched bundle.
    none = _matches(
        session,
        {"version": 1, "root": {"field": "tags", "operator": "contains_none", "value": [other.id]}},
    )
    assert b_other.id not in none and b_child.id in none


def test_folders_and_file_predicates(session: Session) -> None:
    root = root_service.create_storage_root(session, name="r", canonical_path="/mnt/r")
    folder = folder_service.create_folder(session, name="F")
    session.flush()

    in_folder = bundle_service.create_bundle(session, title="in folder")
    bundle_service.set_bundle_folders(session, in_folder.id, [folder.id])
    with_mkv = bundle_service.create_bundle(session, title="mkv")
    bundle_service.add_file(
        session,
        with_mkv.id,
        storage_root_id=root.id,
        relative_path="a/movie.mkv",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    missing = bundle_service.create_bundle(session, title="missing")
    mf = bundle_service.add_file(
        session,
        missing.id,
        storage_root_id=root.id,
        relative_path="b/gone.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    mf.availability = FileAvailability.MISSING
    session.commit()

    assert _matches(
        session,
        {
            "version": 1,
            "root": {"field": "folders", "operator": "contains_any", "value": [folder.id]},
        },
    ) == {in_folder.id}
    assert _matches(
        session,
        {"version": 1, "root": {"field": "extension", "operator": "equals", "value": "mkv"}},
    ) == {with_mkv.id}
    assert _matches(
        session,
        {"version": 1, "root": {"field": "has_missing", "operator": "equals", "value": True}},
    ) == {missing.id}
    assert _matches(
        session, {"version": 1, "root": {"field": "file_count", "operator": "gte", "value": 1}}
    ) == {with_mkv.id, missing.id}
