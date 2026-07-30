"""Faceted counts + tag Equal/direct semantics for the toolbar filters (Slice 1).

The facet endpoint powers the tag/rating popovers: counts must reflect the
current browse scope (view/collection/search + the *other* active filter
categories), never a global static count, and must exclude the category being
shown.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.rating import UNRATED_KEY
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import AssetBundle
from cairndex.services import browse as browse_service
from cairndex.services import bundles as bundle_service
from cairndex.services import tags as tag_service


def _matches(session: Session, ast: dict) -> set[str]:
    from sqlalchemy import select

    pred = compile_expression(session, FilterExpression.model_validate(ast))
    return set(session.scalars(select(AssetBundle.id).where(pred)))


# --- Equal/direct tag semantics ---------------------------------------------
def test_equal_direct_matches_directly_tagged_parent_only(session: Session) -> None:
    """Equal/direct = ``contains_any`` with ``include_descendants=false``. A
    parent tag applied *directly* to a bundle matches; a bundle tagged only with
    a descendant does not (no descendant expansion)."""
    parent = tag_service.create_tag(session, name="genre")
    child = tag_service.create_tag(session, name="thriller", parent_id=parent.id)

    b_parent = bundle_service.create_bundle(session, title="tagged with parent directly")
    bundle_service.set_bundle_tags(session, b_parent.id, [parent.id])
    b_child = bundle_service.create_bundle(session, title="tagged with child only")
    bundle_service.set_bundle_tags(session, b_child.id, [child.id])
    session.commit()

    equal_parent = {
        "version": 1,
        "root": {
            "field": "tags",
            "operator": "contains_any",
            "value": [parent.id],
            "include_descendants": False,
        },
    }
    assert _matches(session, equal_parent) == {b_parent.id}


def test_equal_direct_multiple_is_any_of_exact_tags(session: Session) -> None:
    """Multiple Equal selections = direct membership in *any* selected tag."""
    a = tag_service.create_tag(session, name="a")
    b = tag_service.create_tag(session, name="b")
    ba = bundle_service.create_bundle(session, title="a")
    bundle_service.set_bundle_tags(session, ba.id, [a.id])
    bb = bundle_service.create_bundle(session, title="b")
    bundle_service.set_bundle_tags(session, bb.id, [b.id])
    bundle_service.create_bundle(session, title="none")
    session.commit()

    got = _matches(
        session,
        {
            "version": 1,
            "root": {
                "field": "tags",
                "operator": "contains_any",
                "value": [a.id, b.id],
                "include_descendants": False,
            },
        },
    )
    assert got == {ba.id, bb.id}


# --- Tag facet counts --------------------------------------------------------
def _seed_tagged(session: Session) -> dict[str, str]:
    parent = tag_service.create_tag(session, name="genre")
    child = tag_service.create_tag(session, name="thriller", parent_id=parent.id)
    other = tag_service.create_tag(session, name="watched")

    b1 = bundle_service.create_bundle(session, title="parent+child", rating=5)
    bundle_service.set_bundle_tags(session, b1.id, [parent.id, child.id])
    b2 = bundle_service.create_bundle(session, title="child", rating=3)
    bundle_service.set_bundle_tags(session, b2.id, [child.id])
    b3 = bundle_service.create_bundle(session, title="watched", rating=None)
    bundle_service.set_bundle_tags(session, b3.id, [other.id])
    session.commit()
    return {
        "parent": parent.id,
        "child": child.id,
        "other": other.id,
        "b1": b1.id,
        "b2": b2.id,
        "b3": b3.id,
    }


def test_tag_facet_direct_counts(session: Session) -> None:
    ids = _seed_tagged(session)
    result = browse_service.facet_counts(session, want_tags=True, tag_include_descendants=False)
    assert result.tags is not None
    assert result.tags[ids["parent"]] == 1  # only b1 is tagged with parent directly
    assert result.tags[ids["child"]] == 2  # b1 + b2
    assert result.tags[ids["other"]] == 1


def test_tag_facet_descendant_rollup_is_distinct(session: Session) -> None:
    ids = _seed_tagged(session)
    result = browse_service.facet_counts(session, want_tags=True, tag_include_descendants=True)
    assert result.tags is not None
    # parent rolls up its subtree (parent OR child) as distinct bundles: b1 + b2,
    # NOT 3 — b1 is tagged with both and must not be double-counted.
    assert result.tags[ids["parent"]] == 2
    assert result.tags[ids["child"]] == 2  # leaf unchanged


def test_tag_facet_respects_base_filter_scope(session: Session) -> None:
    """The base filter (other active categories) scopes the counts. Here we scope
    to rating>=4, so only b1 (rating 5) remains — child count drops to 1."""
    ids = _seed_tagged(session)
    base = FilterExpression.model_validate(
        {"version": 1, "root": {"field": "rating", "operator": "gte", "value": 4}}
    )
    result = browse_service.facet_counts(
        session, filter_expr=base, want_tags=True, tag_include_descendants=False
    )
    assert result.tags is not None
    assert result.tags[ids["child"]] == 1  # only b1 (rating 5) survives the scope
    assert result.tags[ids["other"]] == 0


# --- Rating facet counts -----------------------------------------------------
def test_rating_facet_includes_unrated(session: Session) -> None:
    _seed_tagged(session)
    result = browse_service.facet_counts(session, want_ratings=True)
    assert result.ratings is not None
    assert result.ratings.get("5") == 1
    assert result.ratings.get("3") == 1
    assert result.ratings.get(UNRATED_KEY) == 1


def test_rating_facet_keys_half_and_whole_stars_distinctly(session: Session) -> None:
    """Whole stars key as ``"4"``, half stars as ``"3.5"``.

    SQLite hands 4 back as an int and 3.5 as a float from the same column, so
    without one canonical formatter the same scale would produce both ``"4"``
    and ``"4.0"`` depending on the value.
    """
    for rating in (3, 3.5, 3.5, 4):
        bundle_service.create_bundle(session, title=f"rated {rating}", rating=rating)
    session.commit()

    ratings = browse_service.facet_counts(session, want_ratings=True).ratings
    assert ratings is not None
    assert ratings.get("3") == 1
    assert ratings.get("3.5") == 2
    assert ratings.get("4") == 1
    assert "4.0" not in ratings and "3.0" not in ratings


# --- API ---------------------------------------------------------------------
def test_facets_endpoint(client: TestClient, library_id: str, session: Session) -> None:
    ids = _seed_tagged(session)
    base = f"/api/v1/libraries/{library_id}"
    r = client.post(
        f"{base}/filters/facets",
        json={"facets": ["tags", "ratings"], "tag_include_descendants": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tags"][ids["parent"]] == 2
    assert body["ratings"]["unrated"] == 1
