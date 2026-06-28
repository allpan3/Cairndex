"""Bundle browse: system views, sorting, pagination, summaries, counts."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services import storage_roots as root_service
from cairndex.services.browse import (
    BundleSort,
    SystemView,
    browse_bundles,
    collection_counts,
    view_counts,
)


def _root(session: Session) -> str:
    root = root_service.create_storage_root(session, name="r", canonical_path="/mnt/r")
    session.flush()
    return root.id


def test_browse_returns_enriched_summaries(session: Session) -> None:
    root_id = _root(session)
    bundle = bundle_service.create_bundle(session, title="Movie")
    f = bundle_service.add_file(
        session,
        bundle.id,
        storage_root_id=root_id,
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
    root_id = _root(session)
    collection = collection_service.create_collection(session, name="F")

    # b1: in a collection, tagged-not; b2: uncategorized + untagged; b3: missing file.
    b1 = bundle_service.create_bundle(session, title="b1")
    bundle_service.set_bundle_collections(session, b1.id, [collection.id])
    bundle_service.create_bundle(session, title="b2")  # uncategorized + untagged
    b3 = bundle_service.create_bundle(session, title="b3")
    mf = bundle_service.add_file(
        session,
        b3.id,
        storage_root_id=root_id,
        relative_path="x/y.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    mf.availability = FileAvailability.MISSING
    session.commit()

    assert browse_bundles(session, view=SystemView.ALL).total == 3
    # b2 and b3 are in no collection.
    assert browse_bundles(session, view=SystemView.UNCATEGORIZED).total == 2
    # all three are untagged.
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


def test_storage_root_scoping(session: Session) -> None:
    """Browsing and counts can be scoped to one library (storage root) without
    affecting the logical collection a bundle belongs to."""
    r1 = root_service.create_storage_root(session, name="r1", canonical_path="/mnt/r1")
    r2 = root_service.create_storage_root(session, name="r2", canonical_path="/mnt/r2")
    session.flush()
    collection = collection_service.create_collection(session, name="C")

    b1 = bundle_service.create_bundle(session, title="in-r1")
    bundle_service.add_file(
        session,
        b1.id,
        storage_root_id=r1.id,
        relative_path="a.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    bundle_service.set_bundle_collections(session, b1.id, [collection.id])

    b2 = bundle_service.create_bundle(session, title="in-r2")
    bundle_service.add_file(
        session,
        b2.id,
        storage_root_id=r2.id,
        relative_path="b.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    bundle_service.set_bundle_collections(session, b2.id, [collection.id])
    session.commit()

    assert browse_bundles(session).total == 2
    scoped = browse_bundles(session, storage_root_id=r1.id)
    assert scoped.total == 1 and scoped.items[0].id == b1.id

    assert view_counts(session)["all"] == 2
    assert view_counts(session, storage_root_id=r1.id)["all"] == 1

    assert collection_counts(session)[collection.id] == 2
    assert collection_counts(session, storage_root_id=r2.id)[collection.id] == 1


def test_view_counts(session: Session) -> None:
    bundle_service.create_bundle(session, title="a")
    bundle_service.create_bundle(session, title="b")
    session.commit()
    counts = view_counts(session)
    assert counts["all"] == 2
    assert counts["uncategorized"] == 2
    assert counts["untagged"] == 2
    assert counts["missing"] == 0


def test_browse_endpoint_and_counts_routing(client: TestClient) -> None:
    # /browse and /counts must not be shadowed by /{bundle_id}.
    client.post("/api/v1/bundles", json={"title": "one"})
    browse = client.get("/api/v1/bundles/browse", params={"view": "all", "sort": "title"})
    assert browse.status_code == 200
    assert browse.json()["total"] == 1
    assert browse.json()["items"][0]["title"] == "one"

    counts = client.get("/api/v1/bundles/counts")
    assert counts.status_code == 200
    assert counts.json()["all"] == 1


def test_collection_counts_endpoint(client: TestClient) -> None:
    collection_id = client.post("/api/v1/collections", json={"name": "F"}).json()["id"]
    bundle_id = client.post("/api/v1/bundles", json={"title": "x"}).json()["id"]
    client.put(f"/api/v1/bundles/{bundle_id}/collections", json={"ids": [collection_id]})

    counts = client.get("/api/v1/collections/counts").json()["counts"]
    assert counts[collection_id] == 1
