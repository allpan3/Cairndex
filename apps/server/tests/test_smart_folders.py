"""Smart Folder CRUD + filter preview + simple/smart browse equivalence.

The acceptance criterion (AGENTS.md §4.8): a saved Smart Folder and an
equivalent toolbar filter compile to the same predicate and return identical
results, and saved folders survive a restart (re-read from the DB).
"""

import pytest
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.filters.ast import FilterExpression
from cairndex.services import bundles as bundle_service
from cairndex.services import smart_folders as sf_service
from cairndex.services.browse import BundleSort, SystemView, browse_bundles

_HIGH_RATED = {
    "version": 1,
    "root": {"field": "rating", "operator": "gte", "value": 4},
}


def _seed(session: Session) -> tuple[str, str]:
    keep = bundle_service.create_bundle(session, title="keep", rating=5)
    bundle_service.create_bundle(session, title="drop", rating=1)
    session.commit()
    return keep.id, "drop"


# --- CRUD --------------------------------------------------------------------
def test_create_and_get_roundtrip(session: Session) -> None:
    sf = sf_service.create_smart_folder(
        session,
        name="Highly rated",
        filter_expr=FilterExpression.model_validate(_HIGH_RATED),
    )
    session.commit()
    got = sf_service.get_smart_folder(session, sf.id)
    assert got.name == "Highly rated"
    # Stored as the canonical, validated AST (defaults filled in).
    assert FilterExpression.model_validate(got.filter_json) == FilterExpression.model_validate(
        _HIGH_RATED
    )
    assert got.filter_version == 1


def test_duplicate_name_conflicts(session: Session) -> None:
    sf_service.create_smart_folder(
        session, name="dup", filter_expr=FilterExpression.model_validate(_HIGH_RATED)
    )
    session.commit()
    from cairndex.core.errors import ConflictError

    with pytest.raises(ConflictError):
        sf_service.create_smart_folder(
            session, name="dup", filter_expr=FilterExpression.model_validate(_HIGH_RATED)
        )


def test_invalid_filter_rejected_at_save(session: Session) -> None:
    bad = FilterExpression.model_validate(
        {"version": 1, "root": {"field": "nope", "operator": "eq", "value": 1}}
    )
    with pytest.raises(ValidationError):
        sf_service.create_smart_folder(session, name="bad", filter_expr=bad)


def test_update_filter_and_name(session: Session) -> None:
    sf = sf_service.create_smart_folder(
        session, name="a", filter_expr=FilterExpression.model_validate(_HIGH_RATED)
    )
    session.commit()
    new_filter = {"version": 1, "root": {"field": "title", "operator": "contains", "value": "x"}}
    sf_service.update_smart_folder(
        session,
        sf.id,
        name="b",
        filter_expr=FilterExpression.model_validate(new_filter),
    )
    session.commit()
    got = sf_service.get_smart_folder(session, sf.id)
    assert got.name == "b"
    assert FilterExpression.model_validate(got.filter_json) == FilterExpression.model_validate(
        new_filter
    )


def test_delete(session: Session) -> None:
    sf = sf_service.create_smart_folder(
        session, name="gone", filter_expr=FilterExpression.model_validate(_HIGH_RATED)
    )
    session.commit()
    sf_service.delete_smart_folder(session, sf.id)
    session.commit()
    from cairndex.core.errors import NotFoundError

    with pytest.raises(NotFoundError):
        sf_service.get_smart_folder(session, sf.id)


# --- equivalence -------------------------------------------------------------
def test_simple_and_smart_filter_are_equivalent(session: Session) -> None:
    keep_id, _ = _seed(session)
    expr = FilterExpression.model_validate(_HIGH_RATED)

    # "Toolbar filter": pass the AST straight to browse.
    direct = browse_bundles(session, filter_expr=expr)

    # "Smart Folder": save it, re-read filter_json from the DB, then browse.
    sf = sf_service.create_smart_folder(session, name="hr", filter_expr=expr)
    session.commit()
    reloaded = sf_service.get_smart_folder(session, sf.id)
    saved = browse_bundles(
        session, filter_expr=FilterExpression.model_validate(reloaded.filter_json)
    )

    assert [b.id for b in direct.items] == [keep_id]
    assert [b.id for b in saved.items] == [b.id for b in direct.items]
    assert direct.total == saved.total == 1


def test_browse_filter_respects_view_and_sort(session: Session) -> None:
    keep_id, _ = _seed(session)
    page = browse_bundles(
        session,
        view=SystemView.ALL,
        sort=BundleSort.RATING,
        descending=True,
        filter_expr=FilterExpression.model_validate(_HIGH_RATED),
    )
    assert [b.id for b in page.items] == [keep_id]
