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
from cairndex.services import bundle_cursor as cursor_service
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services import playback_progress as progress_service
from cairndex.services.browse import (
    BundleSort,
    SystemView,
    browse_bundles,
    cleanup_bundle_order,
    reorder_bundles,
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
    f.tech_metadata = {
        "container": "mov,mp4,m4a,3gp,3g2,mj2",
        "width": 1920,
        "height": 1080,
        "duration": 90.0,
        "video_codec": "h264",
        "audio_codec": "aac",
    }
    progress_service.upsert_progress(session, f.id, position_s=22.0, duration_s=90.0)
    session.commit()

    page = browse_bundles(session)
    assert page.total == 1
    s = page.items[0]
    assert s.title == "Movie"
    assert s.file_count == 1 and s.total_size == 1000
    assert s.width == 1920 and s.height == 1080 and s.duration == 90.0
    assert s.extension == "mp4" and s.media_kind == "video"
    assert s.has_cover is True
    assert s.openable is True
    assert s.grouping_state == bundle.grouping_state
    # The lone video is the derived cover, so it drives the cache-busting key.
    assert s.cover_key == f.id
    assert s.resume_file_id == f.id
    assert s.resume_media_kind == "video"
    assert s.resume_relative_path == "m/movie.mp4"
    assert s.resume_container == "mov,mp4,m4a,3gp,3g2,mj2"
    assert s.resume_video_codec == "h264"
    assert s.resume_audio_codec == "aac"
    assert s.resume_duration == 90.0
    assert s.resume_position == 22.0

    progress_service.upsert_progress(session, f.id, position_s=89.0, duration_s=90.0)
    session.commit()
    assert browse_bundles(session).items[0].resume_position is None


# Hover metadata follows an image cursor and remains absent for an empty bundle
def test_summary_hover_preview_fields_include_image_cursor(session: Session) -> None:
    image_bundle = bundle_service.create_bundle(session, title="Still")
    image = bundle_service.add_file(
        session,
        image_bundle.id,
        relative_path="stills/frame.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    image.mime_type = "image/jpeg"
    empty_bundle = bundle_service.create_bundle(session, title="Empty")
    session.commit()

    summaries = {item.id: item for item in browse_bundles(session).items}
    image_summary = summaries[image_bundle.id]
    assert image_summary.resume_file_id == image.id
    assert image_summary.resume_media_kind == "image"
    assert image_summary.resume_mime_type == "image/jpeg"
    assert image_summary.resume_relative_path == "stills/frame.jpg"
    assert image_summary.resume_duration is None
    assert summaries[empty_bundle.id].resume_file_id is None


# A static image cover does not replace the bundle's remembered video location
def test_summary_hover_preview_is_independent_of_image_cover(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="Movie")
    image = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie/poster.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
        sequence=0,
    )
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie/feature.mp4",
        role=FileRole.VIDEO_PART,
        media_kind=MediaKind.VIDEO,
        sequence=1,
    )
    video.tech_metadata = {"duration": 120.0, "video_codec": "h264"}
    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": image.id})
    cursor_service.set_cursor(session, bundle.id, video.id)
    progress_service.upsert_progress(session, video.id, position_s=35, duration_s=120)
    session.commit()

    summary = browse_bundles(session).items[0]
    assert summary.cover_key == image.id
    assert summary.resume_file_id == video.id
    assert summary.resume_media_kind == "video"
    assert summary.resume_position == 35


def test_summary_cover_key_tracks_the_selected_cover(session: Session) -> None:
    """cover_key follows the effective cover so the client can bust the thumbnail
    cache: it starts on the derived cover (first image) and moves when the owner
    picks a different one."""
    bundle = bundle_service.create_bundle(session, title="Album")
    first = bundle_service.add_file(
        session, bundle.id, relative_path="a/1.jpg", role=FileRole.IMAGE, media_kind=MediaKind.IMAGE
    )
    second = bundle_service.add_file(
        session, bundle.id, relative_path="a/2.jpg", role=FileRole.IMAGE, media_kind=MediaKind.IMAGE
    )
    session.commit()

    # No explicit cover yet → derived from the first image.
    assert browse_bundles(session).items[0].cover_key == first.id

    bundle_service.update_bundle(session, bundle.id, {"cover_file_id": second.id})
    session.commit()
    assert browse_bundles(session).items[0].cover_key == second.id


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
    """Available provisional bundles belong only in the Unbundled view."""
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


def test_missing_view_includes_a_stale_provisional_bundle(session: Session) -> None:
    stale = _unbundled(session, "loose/gone.mp4", title="gone")
    stale.files[0].availability = FileAvailability.MISSING
    session.commit()

    missing = browse_bundles(session, view=SystemView.MISSING)
    assert missing.total == 1 and missing.items[0].id == stale.id
    counts = view_counts(session)
    assert counts["missing"] == 1 and counts["unbundled"] == 1


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


def _confirmed(session: Session, title: str) -> AssetBundle:
    """A confirmed bundle with one visible file (so browse doesn't hide it)."""
    bundle = bundle_service.create_bundle(session, title=title)
    bundle_service.add_file(
        session,
        bundle.id,
        relative_path=f"m/{title}.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.flush()
    return bundle


def _browse_ids(session: Session, **kwargs: object) -> list[str]:
    page = browse_bundles(session, sort=BundleSort.MANUAL, descending=False, **kwargs)  # type: ignore[arg-type]
    return [s.id for s in page.items]


def test_manual_sort_uses_global_order_in_all_view(session: Session) -> None:
    a, b, c = (_confirmed(session, t) for t in ("a", "b", "c"))
    # Newest-first by default, so the starting order is c, b, a. Move b to the end.
    reorder_bundles(session, collection_id=None, moved_ids=[b.id], before_id=None)
    assert _browse_ids(session, view=SystemView.ALL) == [c.id, a.id, b.id]


def test_manual_sort_uses_membership_order_inside_a_collection(session: Session) -> None:
    coll = collection_service.create_collection(session, name="C")
    a, b, c = (_confirmed(session, t) for t in ("a", "b", "c"))
    for bundle in (a, b, c):
        bundle_service.set_bundle_collections(session, bundle.id, [coll.id])
    # A collection order distinct from the global order proves the two are separate.
    # Both start newest-first (c, b, a).
    reorder_bundles(session, collection_id=coll.id, moved_ids=[a.id], before_id=None)
    reorder_bundles(session, collection_id=None, moved_ids=[a.id], before_id=c.id)
    reorder_bundles(session, collection_id=None, moved_ids=[b.id], before_id=c.id)

    assert _browse_ids(session, collection_id=coll.id) == [c.id, b.id, a.id]
    assert _browse_ids(session, view=SystemView.ALL) == [a.id, b.id, c.id]


def test_cleanup_bundle_order_by_title_rewrites_collection_membership(session: Session) -> None:
    coll = collection_service.create_collection(session, name="C")
    # Added out of alphabetical order.
    gamma, alpha, beta = (_confirmed(session, t) for t in ("gamma", "alpha", "beta"))
    for bundle in (gamma, alpha, beta):
        bundle_service.set_bundle_collections(session, bundle.id, [coll.id])

    cleanup_bundle_order(session, collection_id=coll.id, sort=BundleSort.TITLE, descending=False)
    assert _browse_ids(session, collection_id=coll.id) == [alpha.id, beta.id, gamma.id]


def test_collection_counts_endpoint(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    root = client.post(f"{base}/collections", json={"name": "Root"}).json()["id"]
    child = client.post(f"{base}/collections", json={"name": "Child", "parent_id": root}).json()[
        "id"
    ]
    leaf = client.post(f"{base}/collections", json={"name": "Leaf", "parent_id": child}).json()[
        "id"
    ]
    empty = client.post(f"{base}/collections", json={"name": "Empty"}).json()["id"]

    direct = client.post(f"{base}/bundles", json={"title": "direct"}).json()["id"]
    nested = client.post(f"{base}/bundles", json={"title": "nested"}).json()["id"]
    shared = client.post(f"{base}/bundles", json={"title": "shared"}).json()["id"]
    client.put(f"{base}/bundles/{direct}/collections", json={"ids": [root]})
    client.put(f"{base}/bundles/{nested}/collections", json={"ids": [leaf]})
    client.put(f"{base}/bundles/{shared}/collections", json={"ids": [child, leaf]})

    counts = client.get(f"{base}/collections/counts").json()["counts"]
    assert counts == {root: 3, child: 2, leaf: 2, empty: 0}


def test_date_opened_sort_puts_never_opened_last(session: Session) -> None:
    """The Recent view's Date Opened order. A bundle nobody has opened has no
    timestamp to rank by, and belongs at the end of "most recently opened"."""
    never = bundle_service.create_bundle(session, title="never")
    first = bundle_service.create_bundle(session, title="first")
    second = bundle_service.create_bundle(session, title="second")
    session.commit()

    bundle_service.mark_bundle_opened(session, first.id)
    bundle_service.mark_bundle_opened(session, second.id)
    session.commit()

    page = browse_bundles(session, sort=BundleSort.DATE_OPENED, descending=True)
    assert [b.title for b in page.items][:2] == ["second", "first"]
    assert page.items[-1].title == "never"
    assert never.last_opened_at is None


def test_marking_opened_is_not_an_edit(session: Session) -> None:
    """Opening must not bump the metadata version or the modified time: it is a
    read, and either would make browsing look like editing (and would drag every
    glanced-at bundle to the top of Date Modified)."""
    bundle = bundle_service.create_bundle(session, title="b")
    session.commit()
    before_version, before_updated = bundle.version, bundle.updated_at

    bundle_service.mark_bundle_opened(session, bundle.id)
    session.commit()

    assert bundle.last_opened_at is not None
    assert bundle.version == before_version
    assert bundle.updated_at == before_updated


def test_date_modified_sort_follows_metadata_edits(session: Session) -> None:
    older = bundle_service.create_bundle(session, title="older")
    bundle_service.create_bundle(session, title="newer")
    session.commit()

    bundle_service.update_bundle(session, older.id, {"rating": 5})
    session.commit()

    page = browse_bundles(session, sort=BundleSort.DATE_MODIFIED, descending=True)
    assert page.items[0].title == "older"


def test_manual_sort_puts_a_newly_added_bundle_first(session: Session) -> None:
    """Nothing has been dragged, so every bundle holds the same default order
    value and the tie-break decides. A bundle added just now belongs at the
    front — that is where someone looks for what they just imported."""
    first = bundle_service.create_bundle(session, title="oldest")
    second = bundle_service.create_bundle(session, title="middle")
    session.commit()
    newest = bundle_service.create_bundle(session, title="newest")
    session.commit()

    page = browse_bundles(session, sort=BundleSort.MANUAL, descending=False)
    assert [b.title for b in page.items] == ["newest", "middle", "oldest"]
    assert {first.id, second.id, newest.id} == {b.id for b in page.items}


def test_manual_sort_still_honours_a_dragged_order(session: Session) -> None:
    """Once a group has been dragged, its explicit order wins outright — the
    newest-first tie-break only ever settles bundles nobody has placed."""
    bundle_service.create_bundle(session, title="a")
    b = bundle_service.create_bundle(session, title="b")
    c = bundle_service.create_bundle(session, title="c")
    session.commit()

    # Starts newest-first (c, b, a); drag b to the front.
    reorder_bundles(session, collection_id=None, moved_ids=[b.id], before_id=c.id)
    session.commit()

    page = browse_bundles(session, sort=BundleSort.MANUAL, descending=False)
    assert [x.title for x in page.items] == ["b", "c", "a"]


def test_reorder_is_resolved_against_the_whole_scope_not_the_loaded_page(
    session: Session,
) -> None:
    """The bug behind "items jump to the beginning or the end".

    The client only ever holds a page. The old contract took its visible list and
    numbered it 0..n-1, which collided with the order values every unloaded
    bundle still held — so bundles the user could not even see moved. Sending the
    move instead means the size of the loaded window changes nothing.
    """
    titles = [f"b{i:02d}" for i in range(12)]
    bundles = {t: _confirmed(session, t) for t in titles}
    order = _browse_ids(session, view=SystemView.ALL)
    names = {b.id: b.title for b in bundles.values()}

    # A drag made while looking at only the first four: move the 4th before the
    # 2nd. Everything outside that window must keep its relative order.
    reorder_bundles(session, collection_id=None, moved_ids=[order[3]], before_id=order[1])

    after = _browse_ids(session, view=SystemView.ALL)
    expected = [order[0], order[3], order[1], order[2], *order[4:]]
    assert [names[i] for i in after] == [names[i] for i in expected]


def test_reorder_moves_a_multi_selection_as_one_block(session: Session) -> None:
    a, b, c, d = (_confirmed(session, t) for t in ("a", "b", "c", "d"))
    order = _browse_ids(session, view=SystemView.ALL)  # newest first: d, c, b, a

    # Drag the two ends together to the front; they keep their relative order.
    reorder_bundles(session, collection_id=None, moved_ids=[order[3], order[0]], before_id=order[1])

    assert _browse_ids(session, view=SystemView.ALL) == [order[0], order[3], order[1], order[2]]
    assert {a.id, b.id, c.id, d.id} == set(order)


def test_reorder_appends_when_there_is_no_bundle_to_land_before(session: Session) -> None:
    _a, _b, _c = (_confirmed(session, t) for t in ("a", "b", "c"))
    order = _browse_ids(session, view=SystemView.ALL)

    reorder_bundles(session, collection_id=None, moved_ids=[order[0]], before_id=None)

    assert _browse_ids(session, view=SystemView.ALL) == [order[1], order[2], order[0]]


def test_dropping_a_block_onto_itself_changes_nothing(session: Session) -> None:
    _a, _b, _c = (_confirmed(session, t) for t in ("a", "b", "c"))
    order = _browse_ids(session, view=SystemView.ALL)

    reorder_bundles(session, collection_id=None, moved_ids=[order[0], order[1]], before_id=order[1])

    assert _browse_ids(session, view=SystemView.ALL) == order


def test_reorder_ignores_ids_outside_the_scope(session: Session) -> None:
    coll = collection_service.create_collection(session, name="C")
    inside, outside = _confirmed(session, "inside"), _confirmed(session, "outside")
    bundle_service.set_bundle_collections(session, inside.id, [coll.id])

    reorder_bundles(session, collection_id=coll.id, moved_ids=[outside.id], before_id=inside.id)

    assert _browse_ids(session, collection_id=coll.id) == [inside.id]


def test_reordering_is_not_editing(session: Session) -> None:
    """A drag rearranges the shelf; it must not mark the books modified. The
    manual-order writer spans the whole scope now, and ``updated_at`` carries an
    onupdate default — an unconditional rewrite would stamp every bundle in the
    library "modified just now" on every drag, destroying Date Modified."""
    a = bundle_service.create_bundle(session, title="a")
    b = bundle_service.create_bundle(session, title="b")
    c = bundle_service.create_bundle(session, title="c")
    session.commit()
    stamps = {x.id: x.updated_at for x in (a, b, c)}

    reorder_bundles(session, collection_id=None, moved_ids=[a.id], before_id=None)
    session.commit()
    for x in (a, b, c):
        session.refresh(x)
        assert x.updated_at == stamps[x.id], f"{x.title} was stamped modified by a reorder"
