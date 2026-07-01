"""Bundle browse: system views, sorting, pagination, summaries, counts."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services.browse import (
    BundleSort,
    SystemView,
    browse_bundles,
    view_counts,
)


def _unbundled(session: Session, relative_path: str, *, title: str | None = None) -> AssetBundle:
    """Create a scan-staged provisional one-file bundle (an "unbundled" file)."""
    bundle = AssetBundle(
        title=title,
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(bundle)
    session.flush()
    session.add(
        AssetFile(
            bundle_id=bundle.id,
            relative_path=relative_path,
            original_filename=relative_path.rsplit("/", 1)[-1],
            display_title=relative_path.rsplit("/", 1)[-1],
            role=FileRole.OTHER,
            media_kind=MediaKind.VIDEO,
        )
    )
    session.flush()
    return bundle


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
    assert s.has_cover is True
    assert s.grouping_state == bundle.grouping_state


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
    assert counts["unbundled"] == 0


def test_unbundled_files_hidden_from_normal_views(session: Session) -> None:
    """Scan-staged provisional bundles belong only in the Unbundled view."""
    confirmed = bundle_service.create_bundle(session, title="real")
    bundle_service.add_file(
        session,
        confirmed.id,
        relative_path="real/movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    _unbundled(session, "loose/clip.mp4", title="clip")
    _unbundled(session, "loose/other.mp4", title="other")
    session.commit()

    # Normal views never surface the scan-staged files.
    for view in (
        SystemView.ALL,
        SystemView.RECENT,
        SystemView.UNCATEGORIZED,
        SystemView.UNTAGGED,
    ):
        page = browse_bundles(session, view=view)
        assert [s.title for s in page.items] == ["real"], view

    # The dedicated view shows only them.
    unbundled = browse_bundles(session, view=SystemView.UNBUNDLED)
    assert unbundled.total == 2
    assert sorted(s.title for s in unbundled.items) == ["clip", "other"]

    counts = view_counts(session)
    assert counts["all"] == 1
    assert counts["unbundled"] == 2


def test_unbundled_files_hidden_from_collection_views(session: Session) -> None:
    collection = collection_service.create_collection(session, name="C")
    confirmed = bundle_service.create_bundle(session, title="real")
    bundle_service.set_bundle_collections(session, confirmed.id, [collection.id])
    _unbundled(session, "loose/clip.mp4", title="clip")
    session.commit()

    page = browse_bundles(session, collection_id=collection.id)
    assert [s.title for s in page.items] == ["real"]


# Hidden-only bundles are not visible library browse items
def test_browse_excludes_hidden_only_bundles(session: Session) -> None:
    hidden = bundle_service.create_bundle(session, title="hidden")
    bundle_service.add_file(
        session,
        hidden.id,
        relative_path=".cairndex/cache/thumbnails/01/thumb.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    visible = bundle_service.create_bundle(session, title="visible")
    bundle_service.add_file(
        session,
        visible.id,
        relative_path="visible.jpg",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    page = browse_bundles(session)

    assert page.total == 1
    assert [item.title for item in page.items] == ["visible"]
    assert view_counts(session)["all"] == 1


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
