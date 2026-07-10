"""Whole-library FTS5 metadata search: coverage, freshness, escaping, API."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.search import rebuild, to_match_query
from cairndex.services import browse as browse_service
from cairndex.services import bundles as bundle_service
from cairndex.services import tags as tag_service


def _titles(session: Session, q: str, **kw: object) -> list[str | None]:
    page = browse_service.browse_bundles(session, search=q, limit=100, **kw)  # type: ignore[arg-type]
    return [b.title for b in page.items]


def test_to_match_query_escaping() -> None:
    assert to_match_query("cosmos ep") == '"cosmos"* "ep"*'
    assert to_match_query("  spaced  ") == '"spaced"*'
    assert to_match_query("!!!") is None
    assert to_match_query("") is None
    # FTS operators are neutralized (treated as literal terms, no syntax error).
    assert to_match_query('a AND "b') == '"a"* "AND"* "b"*'


def test_search_finds_item_beyond_first_page(session: Session) -> None:
    for i in range(150):
        bundle_service.create_bundle(session, title=f"Filler {i:03d}")
    target = bundle_service.create_bundle(session, title="Cosmos Documentary", notes=["deep space"])
    bundle_service.add_file(
        session,
        target.id,
        relative_path="dir/cosmos_ep01.mkv",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    tag = tag_service.create_tag(session, name="astronomy")
    bundle_service.set_bundle_tags(session, target.id, [tag.id])
    session.commit()

    assert _titles(session, "cosmos") == ["Cosmos Documentary"]
    assert _titles(session, "ep01") == ["Cosmos Documentary"]  # original filename
    assert _titles(session, "astronomy") == ["Cosmos Documentary"]  # tag name
    assert _titles(session, "space") == ["Cosmos Documentary"]  # note
    assert _titles(session, "zzznope") == []


def test_search_updates_on_edit_and_delete(session: Session) -> None:
    b = bundle_service.create_bundle(session, title="Original Title")
    session.commit()
    assert _titles(session, "original") == ["Original Title"]

    bundle_service.update_bundle(session, b.id, {"title": "Renamed"})
    session.commit()
    assert _titles(session, "original") == []  # stale text gone
    assert _titles(session, "renamed") == ["Renamed"]

    bundle_service.delete_bundle(session, b.id)
    session.commit()
    assert _titles(session, "renamed") == []


def test_search_updates_on_tag_rename(session: Session) -> None:
    b = bundle_service.create_bundle(session, title="Movie")
    tag = tag_service.create_tag(session, name="thriller")
    bundle_service.set_bundle_tags(session, b.id, [tag.id])
    session.commit()
    assert _titles(session, "thriller") == ["Movie"]

    tag_service.update_tag(session, tag.id, name="suspense")
    session.commit()
    assert _titles(session, "thriller") == []
    assert _titles(session, "suspense") == ["Movie"]


def test_search_composes_with_filter(session: Session) -> None:
    keep = bundle_service.create_bundle(session, title="Space Odyssey", rating=5)
    bundle_service.create_bundle(session, title="Space Filler", rating=1)
    session.commit()
    from cairndex.filters.ast import FilterExpression, PredicateNode

    expr = FilterExpression(root=PredicateNode(field="rating", operator="gte", value=4))
    page = browse_service.browse_bundles(session, search="space", filter_expr=expr, limit=100)
    assert [b.title for b in page.items] == ["Space Odyssey"]
    assert page.total == 1
    _ = keep


def test_rebuild_repopulates(session: Session) -> None:
    bundle_service.create_bundle(session, title="Alpha")
    bundle_service.create_bundle(session, title="Beta")
    session.commit()
    count = rebuild(session)
    session.commit()
    assert count == 2
    assert _titles(session, "alpha") == ["Alpha"]


def test_browse_api_q_param(client: TestClient, library_id: str, session: Session) -> None:
    bundle_service.create_bundle(session, title="Findable Widget")
    bundle_service.create_bundle(session, title="Other Thing")
    session.commit()

    got = client.get(f"/api/v1/libraries/{library_id}/bundles/browse?q=widget")
    assert got.status_code == 200
    body = got.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Findable Widget"

    # POST browse also accepts q (alongside a filter AST).
    posted = client.post(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        json={"q": "other"},
    )
    assert posted.status_code == 200
    assert [i["title"] for i in posted.json()["items"]] == ["Other Thing"]
