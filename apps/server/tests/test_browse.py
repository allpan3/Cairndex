"""Bundle browse: system views, sorting, pagination, summaries, counts."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services.browse import (
    BundleSort,
    SystemView,
    browse_bundles,
    view_counts,
)


def test_browse_returns_enriched_summaries(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="Movie")
    f = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="m/movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    f.size_bytes = 1000
    f.tech_metadata = {"width": 1920, "height": 1080, "duration": 90.0}
    bundle_service.update_bundle(session, bundle.id, {"primary_file_id": f.id})
    session.commit()

    page = browse_bundles(session)
    assert page.total == 1
    s = page.items[0]
    assert s.title == "Movie"
    assert s.file_count == 1 and s.total_size == 1000
    assert s.width == 1920 and s.height == 1080 and s.duration == 90.0
    assert s.extension == "mp4" and s.media_kind == "video"


def test_system_views_filter(session: Session) -> None:
    collection = collection_service.create_collection(session, name="F")

    b1 = bundle_service.create_bundle(session, title="b1")
    bundle_service.set_bundle_collections(session, b1.id, [collection.id])
    bundle_service.create_bundle(session, title="b2")  # uncategorized + untagged
    b3 = bundle_service.create_bundle(session, title="b3")
    mf = bundle_service.add_file(
        session,
        b3.id,
        relative_path="x/y.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    mf.availability = FileAvailability.MISSING
    session.commit()

    assert browse_bundles(session, view=SystemView.ALL).total == 3
    assert browse_bundles(session, view=SystemView.UNCATEGORIZED).total == 2
    assert browse_bundles(session, view=SystemView.UNTAGGED).total == 3
    missing = browse_bundles(session, view=SystemView.MISSING)
    assert missing.total == 1 and missing.items[0].id == b3.id
    assert browse_bundles(session, collection_id=collection.id).items[0].id == b1.id


def test_sort_and_offset_pagination(session: Session) -> None:
    for i in range(5):
        bundle_service.create_bundle(session, title=f"title-{i}")
    session.commit()

    asc = browse_bundles(session, sort=BundleSort.TITLE, descending=False, limit=2, offset=0)
    assert [s.title for s in asc.items] == ["title-0", "title-1"]
    assert asc.total == 5
    nxt = browse_bundles(session, sort=BundleSort.TITLE, descending=False, limit=2, offset=2)
    assert [s.title for s in nxt.items] == ["title-2", "title-3"]


def test_view_counts(session: Session) -> None:
    bundle_service.create_bundle(session, title="a")
    bundle_service.create_bundle(session, title="b")
    session.commit()
    counts = view_counts(session)
    assert counts["all"] == 2
    assert counts["uncategorized"] == 2
    assert counts["untagged"] == 2
    assert counts["missing"] == 0


def test_browse_endpoint_and_counts_routing(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    client.post(f"{base}/bundles", json={"title": "one"})
    browse = client.get(f"{base}/bundles/browse", params={"view": "all", "sort": "title"})
    assert browse.status_code == 200
    assert browse.json()["total"] == 1
    assert browse.json()["items"][0]["title"] == "one"

    counts = client.get(f"{base}/bundles/counts")
    assert counts.status_code == 200
    assert counts.json()["all"] == 1


def test_collection_counts_endpoint(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    collection_id = client.post(f"{base}/collections", json={"name": "F"}).json()["id"]
    bundle_id = client.post(f"{base}/bundles", json={"title": "x"}).json()["id"]
    client.put(f"{base}/bundles/{bundle_id}/collections", json={"ids": [collection_id]})

    counts = client.get(f"{base}/collections/counts").json()["counts"]
    assert counts[collection_id] == 1
